/* eslint-disable arrow-body-style */
const { makeExecutableSchema } = require('@graphql-tools/schema');
const R = require('ramda');
const { graphql } = require('graphql');


const translateTCMLCollection = async ({ rootValue, typeDefs, query }) => {
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: {
      Query: {
        productId: R.path(['elementId']),
        productName: R.path(['elementName']),
        availableCurrencies: () => [],
        defaultCurrency: () => '',
        options: R.pathOr([], ['children']),
      },
      Option: {
        optionId: R.path(['elementId']),
        optionName: R.path(['elementName']),
        units: R.pathOr([], ['children']),
      },
      Unit: {
        unitId: R.path(['elementId']),
        unitName: R.path(['elementName']),
        subtitle: () => '',
        pricing: () => [],
        restrictions: () => ({}),
      },
    },
  });
  const retVal = await graphql({ schema, rootValue, source: query });
  if (retVal.errors) throw new Error(retVal.errors);
  return retVal.data;
};

const translateTPOption = ({ optionsGroupedBySupplierId, supplierData }) => {
  return {
    // LLM sends the product id as string
    productId: supplierData.supplierId + "",
    productName: supplierData.supplierName,
    address: supplierData.supplierAddress,
    serviceTypes: supplierData.serviceTypes,
    options: optionsGroupedBySupplierId.map(option => {
      const comment = R.path(['OptGeneral', 'Comment'], option);
      const st = R.pathOr('', ['OptGeneral', 'ButtonName'], option);
      const keyData = {
        optionId: R.path(['Opt'], option),
        optionName: `${R.path(['OptGeneral', 'Description'], option)}${
          comment ? `-${comment}` : ''
        }`,
        // Guides, Accommodation, Transfers, Entrance Fees, Meals, Other
        serviceType: typeof st === 'string' ? st : '',
        restrictions: {
          MPFCU: R.path(['OptGeneral', 'MPFCU'], option),
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
          ...['Single', 'Twin', 'Double', 'Quad'].reduce((acc, roomType) => {
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
        },
      };
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
      const units = (() => {
        if (R.path(['OptGeneral', 'SType'], option) === 'N') {
          return [{
            unitId: 'Adults',
            unitName: 'Adults',
            pricing: [],
            restrictions: {
              minAge: R.path(['OptGeneral', 'Adult_From'], option),
              maxAge: R.path(['OptGeneral', 'Adult_To'], option),
            },
          }, R.path(['OptGeneral', 'ChildrenAllowed'], option) === 'Y' ? {
            unitId: 'Children',
            unitName: 'Children',
            pricing: [],
            restrictions: {
              minAge: R.path(['OptGeneral', 'Child_From'], option),
              maxAge: R.path(['OptGeneral', 'Child_To'], option),
            },
          } : null, R.path(['OptGeneral', 'InfantsAllowed'], option) === 'Y' ? {
            unitId: 'Infants',
            unitName: 'Infants',
            pricing: [],
            restrictions: {
              minAge: R.path(['OptGeneral', 'Infant_From'], option),
              maxAge: R.path(['OptGeneral', 'Infant_To'], option),
            },
          } : null].filter(Boolean);
        }
        if (R.path(['OptGeneral', 'SType'], option) === 'Y' || R.path(['OptGeneral', 'SType'], option) === 'P') {
          return ['Single', 'Twin', 'Double', 'Quad']
            .map((unitId) => ({
              unitId,
              unitName: unitId,
              pricing: [],
              restrictions: {
                allowed: R.path(['OptGeneral', `${unitId}_Avail`], option) === 'Y',
                paxCount: R.path(['OptGeneral', `${unitId}_Max`], option)
                || R.path(['OptGeneral', `${unitId}_Ad_Max`], option),
              },
            }));
        }
        return [{
          unitId: keyData.optionId, unitName: keyData.optionName, pricing: [], restrictions: {},
        }];
      })();
      return {
        ...keyData,
        units,
      };
    }),
  };
  // const schema = makeExecutableSchema({
  //   typeDefs,
  //   resolvers: {},
  // });
  // const retVal = await graphql({ schema, rootValue, source: query });
  // if (retVal.errors) throw new Error(retVal.errors);
  // console.log(retVal.data, rootValue);
  // return retVal.data;
};

module.exports = {
  translateTCMLCollection,
  translateTPOption,
};
