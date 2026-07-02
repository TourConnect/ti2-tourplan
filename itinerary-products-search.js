const R = require('ramda');
const Promise = require('bluebird');
const { translateTPOption } = require('./resolvers/product');
const { hostConnectXmlOptions } = require('./utils');

const searchProductsForItinerary = async ({
  axios,
  typeDefsAndQueries: {
    itineraryProductTypeDefs,
    itineraryProductQuery,
  },
  token: {
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    configuration,
  },
  payload: {
    // single optionId or array of optionIds
    optionId,
    searchInput,
    // lastUpdatedFrom is used to get options that were updated after a certain date in Tourplan
    // example: lastUpdatedFrom: '2024-04-22 05:17:57.427Z'
    lastUpdatedFrom,
  },
  callTourplan,
}) => {
  // Normalise optionId to an array (or empty)
  const optionIds = optionId
    ? (Array.isArray(optionId) ? optionId : [optionId]).filter(Boolean)
    : [];

  let options = [];

  if (optionIds.length > 0) {
    // Fast path: fetch only the requested option(s) by their exact Opt code,
    // skipping the expensive full-catalog GetServices + wildcard OptionInfo calls.
    await Promise.each(optionIds, async id => {
      const getOptionsModel = {
        OptionInfoRequest: {
          Opt: id,
          Info: 'GR',
          AgentID: hostConnectAgentID,
          Password: hostConnectAgentPassword,
        },
      };
      const getOptionsReply = await callTourplan({
        model: getOptionsModel,
        endpoint: hostConnectEndpoint,
        axios,
        xmlOptions: hostConnectXmlOptions,
      });
      let thisOptions = R.pathOr([], ['OptionInfoReply', 'Option'], getOptionsReply);
      if (!Array.isArray(thisOptions)) thisOptions = [thisOptions];
      options = options.concat(thisOptions);
    });
  } else {
    /*
      Full catalog path:
      1. getServiceCodes -> [AC, BD]
      2. for each serviceCode getoptions
      3. convert them to ti2 products structure
      4. merge all products from all serviceCodes
    */
    // getServices
    const getServicesModel = {
      GetServicesRequest: {
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
      },
    };
    const getServicesReply = await callTourplan({
      model: getServicesModel,
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    });
    let serviceCodes = R.pathOr([], ['GetServicesReply', 'TPLServices', 'TPLService'], getServicesReply);
    if (!Array.isArray(serviceCodes)) serviceCodes = [serviceCodes];
    serviceCodes = serviceCodes.map(s => s.Code);
    await Promise.each(serviceCodes, async serviceCode => {
      const getOptionsModel = {
        OptionInfoRequest: {
          Opt: `???${serviceCode}????????????`,
          Info: 'G',
          AgentID: hostConnectAgentID,
          Password: hostConnectAgentPassword,
          ...(lastUpdatedFrom ? {
            LastUpdateFrom: lastUpdatedFrom,
          } : {}),
        },
      };
      const getOptionsReply = await callTourplan({
        model: getOptionsModel,
        endpoint: hostConnectEndpoint,
        axios,
        xmlOptions: hostConnectXmlOptions,
      });
      let thisOptions = R.pathOr([], ['OptionInfoReply', 'Option'], getOptionsReply);
      // due to the new parser, single option will be returned as an object
      // instead of an array
      if (!Array.isArray(thisOptions)) thisOptions = [thisOptions];
      options = options.concat(thisOptions);
    });
  }
  if (!(options && options.length)) {
    throw new Error('No products found');
  }
  const arrayOfOptionsGroupedBySupplierId = R.call(R.compose(
    R.values,
    R.groupBy(R.path(['OptGeneral', 'SupplierId'])),
  ), options);
  const products = await Promise.map(
    arrayOfOptionsGroupedBySupplierId,
    optionsGroupedBySupplierId => translateTPOption({
      rootValue: {
        optionsGroupedBySupplierId,
      },
      typeDefs: itineraryProductTypeDefs,
      query: itineraryProductQuery,
    }),
    {
      concurrency: 10,
    },
  );
  // Preserve raw OptRates from Tourplan in product search response when available.
  const optionRatesByOptionId = options.reduce((acc, option) => {
    const currentOptionId = R.path(['Opt'], option);
    const currentOptionRates = R.path(['OptRates'], option);
    if (!currentOptionId || !currentOptionRates) return acc;
    return {
      ...acc,
      [currentOptionId]: currentOptionRates,
    };
  }, {});
  const productsWithOptRates = products.map(product => ({
    ...product,
    options: R.pathOr([], ['options'], product).map(currentOption => ({
      ...currentOption,
      ...(R.path([currentOption.optionId], optionRatesByOptionId)
        ? { optRates: R.path([currentOption.optionId], optionRatesByOptionId) }
        : {}),
    })),
  }));
  return {
    products: productsWithOptRates,
    productFields: [],
    ...(searchInput || optionId ? {} : configuration),
  };
};

module.exports = {
  searchProductsForItinerary,
};
