/* eslint-disable arrow-body-style */
const { makeExecutableSchema } = require('@graphql-tools/schema');
const R = require('ramda');
const { graphql } = require('graphql');

const resolvers = {
  Query: {
    // LLM sends the product id as string
    productId: rootValue => `${R.path(['supplierData', 'supplierId'], rootValue)}`,
    productName: rootValue => R.path(['supplierData', 'supplierName'], rootValue),
    address: rootValue => R.path(['supplierData', 'supplierAddress'], rootValue),
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
    lastUpdateTimestamp: option => {
      const lastUpdateISO = R.path(['OptGeneral', 'LastUpdate'], option);
      return lastUpdateISO ? new Date(lastUpdateISO).getTime() / 1000 : null;
    },
    // Guides, Accommodation, Transfers, Entrance Fees, Meals, Other
    serviceType: option => {
      const st = R.pathOr('', ['OptGeneral', 'ButtonName'], option);
      return typeof st === 'string' ? st : '';
    },
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
        return ['Single', 'Twin', 'Double', 'Quad']
          .map(unitId => ({
            unitId,
            unitName: unitId,
            restrictions: {
              allowed: R.path(['OptGeneral', `${unitId}_Avail`], option) === 'Y',
              maxPax: R.path(['OptGeneral', `${unitId}_Max`], option)
                || R.path(['OptGeneral', `${unitId}_Ad_Max`], option),
              maxAdults: R.path(['OptGeneral', `${unitId}_Ad_Max`], option),
              minAge: R.path(['OptGeneral', `${unitId}_From`], option),
              maxAge: R.path(['OptGeneral', `${unitId}_To`], option),
            },
          }));
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
        allowed: R.path(['OptGeneral', 'ChildrenAllowed'], option) === 'Y',
        minAge: R.path(['OptGeneral', 'Child_From'], option),
        maxAge: R.path(['OptGeneral', 'Child_To'], option),
      },
      Infant: {
        allowed: R.path(['OptGeneral', 'InfantsAllowed'], option) === 'Y',
        minAge: R.path(['OptGeneral', 'Infant_From'], option),
        maxAge: R.path(['OptGeneral', 'Infant_To'], option),
      },
      ...['Single', 'Twin', 'Triple', 'Double', 'Quad'].reduce((acc, roomType) => {
        const unitAvail = R.path(['OptGeneral', `${roomType}_Avail`], option);
        const unitMax = R.path(['OptGeneral', `${roomType}_Max`], option);
        const unitAdMax = R.path(['OptGeneral', `${roomType}_Ad_Max`], option);
        return {
          ...acc,
          [roomType]: {
            allowed: unitAvail === 'Y',
            maxPax: unitMax,
            maxAdults: unitAdMax,
          },
        };
      }, {}),
    }),
    extras: option => {
      // when only one extra is present, it is not an array
      let OptExtras = R.pathOr([], ['OptGeneral', 'OptExtras', 'OptExtra'], option);
      // console.log({ OptExtras })
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

const translateTPOption = async ({
  rootValue: {
    optionsGroupedBySupplierId,
  },
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
    serviceTypes: R.uniq(optionsGroupedBySupplierId.map(R.path(['OptGeneral', 'ButtonName']))),
  };
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers,
  });
  const retVal = await graphql({
    schema,
    rootValue: {
      supplierData,
      optionsGroupedBySupplierId,
    },
    source: query,
  });
  if (retVal.errors) throw new Error(retVal.errors);
  return retVal.data;
};

module.exports = {
  translateTPOption,
};
