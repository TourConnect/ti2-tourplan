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
    forceRefresh,
    searchInput,
    // lastUpdatedFrom is used to get options that were updated after a certain date in Tourplan
    // example: lastUpdatedFrom: '2024-04-22 05:17:57.427Z'
    lastUpdatedFrom,
  },
  callTourplan,
}) => {
  /*
    Pseudo
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
  let options = [];
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
    console.log(`got ${thisOptions.length} options for serviceCode ${serviceCode}`);
    options = options.concat(thisOptions);
  });
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
  return {
    products,
    productFields: [],
    ...(searchInput || optionId ? {} : configuration),
  };
};

module.exports = {
  searchProductsForItinerary,
};
