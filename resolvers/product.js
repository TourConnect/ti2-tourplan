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

const translateTPOption = ({ optionsGroupedBySupplierId, supplierData, typeDefs, query }) => {
  return {
    productId: supplierData.supplierId,
    productName: supplierData.supplierName,
    options: optionsGroupedBySupplierId.map(option => {
      const keyData = {
        optionId: R.path(['Opt', 0], option),
        optionName: R.path(['OptGeneral', 0, 'Description', 0], option),
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
        if (R.path(['OptGeneral', 0, 'SType', 0], option) === 'N') {
          return [{
            unitId: 'Adults',
            unitName: 'Adults',
            pricing: [],
            restrictions: {
              paxCount: R.path(['OptGeneral', 0, 'MPFCU', 0], option),
              minAge: R.path(['OptGeneral', 0, 'Adult_From', 0], option),
              maxAge: R.path(['OptGeneral', 0, 'Adult_To', 0], option),
            },
          }, R.path(['OptGeneral', 0, 'ChildrenAllowed', 0], option) === 'Y' ? {
            unitId: 'Children',
            unitName: 'Children',
            pricing: [],
            restrictions: {
              minAge: R.path(['OptGeneral', 0, 'Child_From', 0], option),
              maxAge: R.path(['OptGeneral', 0, 'Child_To', 0], option),
            },
          } : null, R.path(['OptGeneral', 0, 'InfantsAllowed', 0], option) === 'Y' ? {
            unitId: 'Infants',
            unitName: 'Infants',
            pricing: [],
            restrictions: {
              minAge: R.path(['OptGeneral', 0, 'Infant_From', 0], option),
              maxAge: R.path(['OptGeneral', 0, 'Infant_To', 0], option),
            },
          } : null].filter(Boolean);
        }
        if (R.path(['OptGeneral', 0, 'SType', 0], option) === 'Y') {
          return [['SG', 'Single'], ['TW', 'Twin'], ['DB', 'Double'], ['QD', 'Quad']]
            .filter(([_, unitName]) => R.path(['OptGeneral', 0, `${unitName}_Avail`, 0], option) === 'Y')
            .map(([unitId, unitName]) => ({
              unitId,
              unitName,
              pricing: [],
              restrictions: {
                paxCount: R.path(['OptGeneral', 0, `${unitName}_Max`, 0], option)
                || R.path(['OptGeneral', 0, `${unitName}_Ad_Max`, 0], option),
              },
            }));
        }
        return [{
          unitId: keyData.optionId, unitName: keyData.optionName, pricing: [], restrictions: {},
        }];
      })();
      return {
        optionId: keyData.optionId,
        optionName: keyData.optionName,
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
