/* eslint-disable arrow-body-style */
const { makeExecutableSchema } = require('@graphql-tools/schema');
const R = require('ramda');
const { graphql } = require('graphql');
const { asArray, firstPresent, trimString } = require('../tp-helpers/values');

// Prefer AgentInfo Currency (same source as validateToken); fall back to OptRates.
const getOptionCurrency = (option, agentCurrencyCode) => firstPresent(
  agentCurrencyCode,
  R.path(['OptRates', 'Currency'], option),
);

const getOptionCity = option => firstPresent(
  R.path(['__destination', 'city'], option),
  R.path(['OptGeneral', 'LocalityDescription'], option),
  R.path(['OptGeneral', 'Address3'], option),
);

// Other (HostConnect OT) is included with the other room types only when
// OptionInfo actually carries Other_* fields. A missing flag is not "unavailable".
const RESTRICTION_ROOM_TYPES = ['Single', 'Twin', 'Double', 'Triple', 'Quad', 'Other'];
const ACCOMMODATION_UNIT_TYPES = ['Single', 'Twin', 'Double', 'Triple', 'Quad'];
const ROOM_SOURCE_SUFFIXES = ['Avail', 'Max', 'Ad_Max', 'Max_With_Infants', 'From', 'To'];

const finiteInt = value => {
  if (typeof value === 'boolean') return undefined;
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readRoomRaw = (option, roomType, suffix) => (
  R.path(['OptGeneral', `${roomType}_${suffix}`], option)
);

const readRoomInt = (option, roomType, suffix) => finiteInt(readRoomRaw(option, roomType, suffix));

const hasRoomSource = (option, roomType) => ROOM_SOURCE_SUFFIXES.some(suffix => {
  const value = readRoomRaw(option, roomType, suffix);
  return value !== undefined && value !== null && value !== '';
});

// Y and N are explicit. Anything else, including a missing element, is unknown.
const roomAllowed = (option, roomType) => {
  const avail = readRoomRaw(option, roomType, 'Avail');
  if (avail === 'Y') return true;
  if (avail === 'N') return false;
  if (roomType === 'Other') return null;
  return false;
};

// Max of 0 is a real cap. Ad_Max is only the fallback when Max is absent.
const maxPaxForRoom = (option, roomType) => {
  const maxPax = readRoomInt(option, roomType, 'Max');
  if (maxPax !== undefined) return maxPax;
  return readRoomInt(option, roomType, 'Ad_Max');
};

const roomRestriction = (option, roomType) => {
  const maxPaxWithInfants = readRoomInt(option, roomType, 'Max_With_Infants');
  return {
    allowed: roomAllowed(option, roomType),
    maxPax: maxPaxForRoom(option, roomType),
    maxAdults: readRoomInt(option, roomType, 'Ad_Max'),
    ...(maxPaxWithInfants !== undefined && { maxPaxWithInfants }),
  };
};

const noteTexts = record => asArray(R.path(['SupplierNotes', 'SupplierNote'], record))
  .map(note => (
    typeof note === 'string' ? trimString(note) : trimString(R.path(['NoteText'], note))
  ))
  .filter(Boolean);

// SupplierInfo notes, not OptGeneral.Description (that text is the option name).
const supplierDescriptionFromRecord = (record, supplierName) => {
  const source = record || {};
  const name = trimString(supplierName)
    || trimString(source.Name)
    || trimString(source.SupplierName);
  const notes = R.uniq([
    trimString(source.Notes),
    trimString(source.Note),
    trimString(source.SupplierNote),
    ...noteTexts(source),
  ].filter(text => text && text !== name));
  if (notes.length) return notes.join('\n');
  const isOptionGeneral = source.SType !== undefined
    || source.ButtonName !== undefined
    || source.Class !== undefined
    || source.ClassDescription !== undefined;
  const description = trimString(source.Description);
  if (!isOptionGeneral && description && description !== name) return description;
  return null;
};

const optionClassFromGeneral = general => firstPresent(
  trimString(R.path(['ClassDescription'], general)),
  trimString(R.path(['Class'], general)),
) || null;

const chargeUnitFromGeneral = general => {
  const scu = trimString(R.path(['SCU'], general));
  return scu ? scu.toLowerCase() : null;
};

const intOrNull = value => (
  value === undefined || value === null ? null : value
);

const accommodationUnit = (option, unitId) => {
  const room = roomRestriction(option, unitId);
  return {
    unitId,
    unitName: unitId,
    restrictions: {
      allowed: room.allowed,
      maxPax: room.maxPax,
      maxAdults: room.maxAdults,
      minAge: readRoomInt(option, unitId, 'From'),
      maxAge: readRoomInt(option, unitId, 'To'),
      ...(room.maxPaxWithInfants !== undefined
        && { maxPaxWithInfants: room.maxPaxWithInfants }),
    },
  };
};

const accommodationUnitTypes = option => (
  hasRoomSource(option, 'Other')
    ? [...ACCOMMODATION_UNIT_TYPES, 'Other']
    : ACCOMMODATION_UNIT_TYPES
);

const publicRoomRestriction = room => ({
  allowed: room.allowed,
  maxPax: intOrNull(room.maxPax),
  maxAdults: intOrNull(room.maxAdults),
  ...(room.maxPaxWithInfants !== undefined && { maxPaxWithInfants: room.maxPaxWithInfants }),
});

// Stock TI2 product queries omit optionClass, chargeUnit, Other, and maxPaxWithInfants.
const attachOptionCatalogFields = (currentOption, rawOption) => {
  const general = R.pathOr({}, ['OptGeneral'], rawOption);
  const optionClass = currentOption.optionClass || optionClassFromGeneral(general);
  const chargeUnit = currentOption.chargeUnit || chargeUnitFromGeneral(general);
  const restrictions = { ...(currentOption.restrictions || {}) };
  RESTRICTION_ROOM_TYPES.forEach(roomType => {
    const computed = roomRestriction(rawOption, roomType);
    const existing = restrictions[roomType];
    if (!existing) {
      if (!hasRoomSource(rawOption, roomType)) return;
      restrictions[roomType] = publicRoomRestriction(computed);
      return;
    }
    if (
      computed.maxPaxWithInfants !== undefined
      && (existing.maxPaxWithInfants === undefined || existing.maxPaxWithInfants === null)
    ) {
      restrictions[roomType] = {
        ...existing,
        maxPaxWithInfants: computed.maxPaxWithInfants,
      };
    }
  });
  let units = R.pathOr([], ['units'], currentOption).map(unit => {
    const computed = roomRestriction(rawOption, unit.unitId);
    if (computed.maxPaxWithInfants === undefined) return unit;
    const existingCap = R.path(['restrictions', 'maxPaxWithInfants'], unit);
    if (existingCap !== undefined && existingCap !== null) return unit;
    return {
      ...unit,
      restrictions: {
        ...(unit.restrictions || {}),
        maxPaxWithInfants: computed.maxPaxWithInfants,
      },
    };
  });
  const isAccommodation = ['Y', 'P'].includes(R.path(['OptGeneral', 'SType'], rawOption));
  if (
    isAccommodation
    && hasRoomSource(rawOption, 'Other')
    && !units.some(unit => unit.unitId === 'Other')
  ) {
    units = units.concat(accommodationUnit(rawOption, 'Other'));
  }
  return {
    ...R.omit(['optionClass', 'chargeUnit'], currentOption),
    ...(optionClass ? { optionClass } : {}),
    ...(chargeUnit ? { chargeUnit } : {}),
    restrictions,
    units,
  };
};

const typeDefinesField = (typeDefs, typeName, fieldName) => {
  const typeMatch = String(typeDefs || '').match(new RegExp(`type\\s+${typeName}\\s*{([\\s\\S]*?)}`));
  if (!typeMatch) return false;
  return new RegExp(`\\b${fieldName}\\s*:`).test(typeMatch[1]);
};

const resolvers = {
  Query: {
    // LLM sends the product id as string
    productId: rootValue => `${R.path(['supplierData', 'supplierId'], rootValue)}`,
    productName: rootValue => R.path(['supplierData', 'supplierName'], rootValue),
    address: rootValue => R.path(['supplierData', 'supplierAddress'], rootValue),
    description: rootValue => R.path(['supplierData', 'supplierDescription'], rootValue) || null,
    serviceTypes: rootValue => R.path(['supplierData', 'serviceTypes'], rootValue),
    options: R.pathOr([], ['optionsGroupedBySupplierId']),
  },
  ProductOption: {
    optionId: R.path(['Opt']),
    optionName: option => {
      const comment = R.path(['OptGeneral', 'Comment'], option);
      return `${R.path(['OptGeneral', 'Description'], option)}${
        comment ? `-${comment}` : ''
      }`;
    },
    comment: option => R.path(['OptGeneral', 'Comment'], option),
    lastUpdateTimestamp: option => {
      const lastUpdateISO = R.path(['OptGeneral', 'LastUpdate'], option);
      return lastUpdateISO ? new Date(lastUpdateISO).getTime() / 1000 : null;
    },
    // Prefer GetServices name written during enrichment (from optionId chars 3-4);
    // ButtonName remains the HostConnect fallback when GetServices has no match.
    serviceType: option => {
      const st = R.pathOr('', ['OptGeneral', 'ButtonName'], option);
      return typeof st === 'string' ? st : '';
    },
    // City: GetLocations Name (from optionId) → LocalityDescription → Address3.
    city: getOptionCity,
    // Country: GetSystemSettings destination → CountryName (via enrichment).
    country: option => R.path(['__destination', 'country'], option),
    // AgentInfo currency → OptRates.Currency.
    currency: (option, args, context) => getOptionCurrency(
      option,
      context && context.agentCurrencyCode,
    ),
    optionClass: option => optionClassFromGeneral(R.path(['OptGeneral'], option)),
    chargeUnit: option => chargeUnitFromGeneral(R.path(['OptGeneral'], option)),
    units: option => {
      /*
      SType: One character that specifies the service type of the
              option. One of: Y (accommodation), A (apartment), P
              (package), N (non-accommodation). If the service
              type is Y or P then the option is room-based (pricing
              is room based, when a service line is added to a
              booking for this option then a room type must be
              supplied). The difference between Y and P is that
              packages are fixed length (hence a number of
              nights is not specified).
      */
      if (R.path(['OptGeneral', 'SType'], option) === 'N') {
        return [{
          unitId: 'Adults',
          unitName: 'Adults',
          restrictions: {
            minAge: R.path(['OptGeneral', 'Adult_From'], option),
            maxAge: R.path(['OptGeneral', 'Adult_To'], option),
          },
        }, R.path(['OptGeneral', 'ChildrenAllowed'], option) === 'Y' ? {
          unitId: 'Children',
          unitName: 'Children',
          restrictions: {
            minAge: R.path(['OptGeneral', 'Child_From'], option),
            maxAge: R.path(['OptGeneral', 'Child_To'], option),
          },
        } : null, R.path(['OptGeneral', 'InfantsAllowed'], option) === 'Y' ? {
          unitId: 'Infants',
          unitName: 'Infants',
          restrictions: {
            minAge: R.path(['OptGeneral', 'Infant_From'], option),
            maxAge: R.path(['OptGeneral', 'Infant_To'], option),
          },
        } : null].filter(Boolean);
      }
      if (R.path(['OptGeneral', 'SType'], option) === 'Y' || R.path(['OptGeneral', 'SType'], option) === 'P') {
        return accommodationUnitTypes(option).map(unitId => accommodationUnit(option, unitId));
      }
      return [];
    },
    restrictions: option => ({
      roomTypeRequired: ['Y', 'P'].includes(R.path(['OptGeneral', 'SType'], option)),
      Adult: {
        allowed: R.path(['OptGeneral', 'AdultsAllowed'], option) === 'Y',
        minAge: R.path(['OptGeneral', 'Adult_From'], option),
        maxAge: R.path(['OptGeneral', 'Adult_To'], option),
      },
      Child: {
        // NOTE: if CountChildrenInPaxBreak is Y, then also allow children
        // Reason: The children can be part of the booking if CountChildrenInPaxBreak is Y
        allowed: R.path(['OptGeneral', 'ChildrenAllowed'], option) === 'Y' || R.path(['OptGeneral', 'CountChildrenInPaxBreak'], option) === 'Y',
        minAge: R.path(['OptGeneral', 'Child_From'], option),
        maxAge: R.path(['OptGeneral', 'Child_To'], option),
      },
      Infant: {
        // NOTE: if CountInfantsInPaxBreak is Y, then also allow infants
        // Reason: The infants can be part of the booking if CountInfantsInPaxBreak is Y
        allowed: R.path(['OptGeneral', 'InfantsAllowed'], option) === 'Y' || R.path(['OptGeneral', 'CountInfantsInPaxBreak'], option) === 'Y',
        minAge: R.path(['OptGeneral', 'Infant_From'], option),
        maxAge: R.path(['OptGeneral', 'Infant_To'], option),
      },
      ...RESTRICTION_ROOM_TYPES.reduce((acc, roomType) => {
        if (roomType === 'Other' && !hasRoomSource(option, roomType)) return acc;
        return {
          ...acc,
          [roomType]: roomRestriction(option, roomType),
        };
      }, {}),
    }),
    extras: option => {
      // when only one extra is present, it is not an array
      let OptExtras = R.pathOr([], ['OptGeneral', 'OptExtras', 'OptExtra'], option);
      if (!Array.isArray(OptExtras)) OptExtras = [OptExtras];
      return OptExtras;
    },
  },
  Extra: {
    id: R.path(['SequenceNumber']),
    name: R.path(['Description']),
    chargeBasis: R.path(['ChargeBasis']),
    isCompulsory: root => R.path(['IsCompulsory'], root) === 'Y',
    isPricePerPerson: root => R.path(['IsPricePerPerson'], root) === 'Y',
  },
};

const resolversForTypeDefs = typeDefs => {
  const queryResolvers = { ...resolvers.Query };
  Object.keys(queryResolvers).forEach(fieldName => {
    if (!typeDefinesField(typeDefs, 'Query', fieldName)) {
      delete queryResolvers[fieldName];
    }
  });
  const productOptionResolvers = { ...resolvers.ProductOption };
  Object.keys(productOptionResolvers).forEach(fieldName => {
    if (!typeDefinesField(typeDefs, 'ProductOption', fieldName)) {
      delete productOptionResolvers[fieldName];
    }
  });
  const filteredResolvers = {
    ...resolvers,
    Query: queryResolvers,
    ProductOption: productOptionResolvers,
  };
  if (!String(typeDefs || '').match(/type\s+Extra\s*{/)) {
    delete filteredResolvers.Extra;
  }
  return filteredResolvers;
};

const translateTPOption = async ({
  rootValue: {
    optionsGroupedBySupplierId,
    supplierRecord,
  },
  agentCurrencyCode,
  typeDefs,
  query,
}) => {
  const OptGeneral = R.pathOr({}, [0, 'OptGeneral'], optionsGroupedBySupplierId);
  let supplierName = R.path(['SupplierName'], OptGeneral);
  if (R.path(['SupplierName'], OptGeneral).toLocaleLowerCase() === 'transfers') {
    supplierName = `${R.path(['VoucherName'], OptGeneral)} (${R.path(['SupplierName'], OptGeneral)})`;
  }
  const supplierData = {
    supplierId: R.path(['SupplierId'], OptGeneral),
    supplierName,
    supplierAddress: `${R.pathOr('', ['Address1'], OptGeneral)}, ${R.pathOr('', ['Address2'], OptGeneral)},  ${R.pathOr('', ['Address3'], OptGeneral)}, ${R.pathOr('', ['Address4'], OptGeneral)}, ${R.pathOr('', ['Address5'], OptGeneral)}`,
    supplierDescription: supplierDescriptionFromRecord(supplierRecord || {}, supplierName),
    serviceTypes: R.uniq(optionsGroupedBySupplierId.map(R.path(['OptGeneral', 'ButtonName']))),
  };
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: resolversForTypeDefs(typeDefs),
  });
  const retVal = await graphql({
    schema,
    rootValue: {
      supplierData,
      optionsGroupedBySupplierId,
    },
    contextValue: { agentCurrencyCode },
    source: query,
  });
  if (retVal.errors) throw new Error(retVal.errors);

  return retVal.data;
};

module.exports = {
  translateTPOption,
  resolversForTypeDefs,
  getOptionCurrency,
  attachOptionCatalogFields,
  supplierDescriptionFromRecord,
};
