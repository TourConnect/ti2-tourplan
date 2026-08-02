const R = require('ramda');
const Promise = require('bluebird');
const { translateTPOption, getOptionCurrency } = require('./resolvers/product');
const { getAgentCurrencyCode } = require('./availability/itinerary-availability-helper');
const { hostConnectXmlOptions } = require('./utils');
const { getCachedLocations } = require('./tp-helpers/locations');
const { getCachedServices } = require('./tp-helpers/services');
const { getCachedDestinationCountries } = require('./tp-helpers/system-settings');
const { enrichOptionWithCodeTables } = require('./tp-helpers/option-enrichment');
const {
  isEnabled,
  normalizePickupPoints,
} = require('./tp-helpers/pickup-points');
const { getOptionInfoTag } = require('./utils');

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
    // service codes to omit from full catalog search
    // (e.g. ['AC'], 'AC', or 'AC,SM'); when empty/absent, get all
    omitServiceCodes,
    // Request Tourplan pickup/dropoff points in OptionInfo when product consumers need them.
    pickupPointsRequired,
  },
  callTourplan,
  cache,
}) => {
  // Normalise optionId to an array (or empty)
  const optionIds = optionId
    ? (Array.isArray(optionId) ? optionId : [optionId]).filter(Boolean)
    : [];
  const shouldRequestPickupPoints = isEnabled(pickupPointsRequired);

  let options = [];
  let servicesByCode;
  let agentCurrencyCode = null;
  try {
    agentCurrencyCode = await getAgentCurrencyCode({
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      callTourplan,
      cache,
    });
  } catch (err) {
    console.warn('WARNING: Unable to fetch TourPlan agent currency for product search:', err.message);
  }

  if (optionIds.length > 0) {
    // Fast path: fetch only the requested option(s) by their exact Opt code,
    // skipping the expensive full-catalog GetServices + wildcard OptionInfo calls.
    await Promise.each(optionIds, async id => {
      const getOptionsModel = {
        OptionInfoRequest: {
          Opt: id,
          Info: getOptionInfoTag({
            includeRates: true,
            pickupPointsRequired: shouldRequestPickupPoints,
          }),
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
      1. getServiceCodes (cached GetServices) -> [AC, BD]
      2. for each serviceCode getoptions (omitting all service codes in omitServiceCodes)
      3. convert them to ti2 products structure
      4. merge all products from all serviceCodes
    */
    servicesByCode = await getCachedServices({
      callTourplan,
      cache,
      axios,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
    });
    let rawOmitCodes = [];
    if (Array.isArray(omitServiceCodes)) {
      rawOmitCodes = omitServiceCodes;
    } else if (omitServiceCodes) {
      rawOmitCodes = [omitServiceCodes];
    }
    const omitSet = new Set(
      rawOmitCodes
        .flatMap(code => String(code == null ? '' : code).split(','))
        .map(code => code.trim().toUpperCase())
        .filter(Boolean),
    );
    if (omitSet.size > 0) {
      console.debug(
        `[tourplan] Omitting service code(s) from full catalog product search: ${[...omitSet].join(', ')}`,
      );
    }
    const serviceCodes = Object.keys(servicesByCode)
      .filter(code => !omitSet.has(code));
    await Promise.each(serviceCodes, async serviceCode => {
      const getOptionsModel = {
        OptionInfoRequest: {
          Opt: `???${serviceCode}????????????`,
          Info: getOptionInfoTag({ pickupPointsRequired: shouldRequestPickupPoints }),
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

  // Cache GetLocations/GetServices/GetSystemSettings and enrich destination,
  // serviceType, and country before GraphQL translation.
  // Full-catalog path already loaded servicesByCode; reuse it to avoid a second fetch.
  const loadOptionalTable = async (tableName, load) => {
    try {
      return await load();
    } catch (err) {
      console.warn(
        `WARNING: Unable to fetch TourPlan ${tableName} table:`,
        err.message,
      );
      return {};
    }
  };
  const [locationsByCode, resolvedServicesByCode, countriesByDestination] = await Promise.all([
    loadOptionalTable('locations', () => (
      getCachedLocations({
        callTourplan,
        cache,
        axios,
        hostConnectEndpoint,
        hostConnectAgentID,
        hostConnectAgentPassword,
      })
    )),
    loadOptionalTable('services', () => (
      servicesByCode !== undefined
        ? Promise.resolve(servicesByCode)
        : getCachedServices({
          callTourplan,
          cache,
          axios,
          hostConnectEndpoint,
          hostConnectAgentID,
          hostConnectAgentPassword,
        })
    )),
    loadOptionalTable('system settings', () => (
      getCachedDestinationCountries({
        callTourplan,
        cache,
        axios,
        hostConnectEndpoint,
        hostConnectAgentID,
        hostConnectAgentPassword,
      })
    )),
  ]);
  servicesByCode = resolvedServicesByCode;

  const enrichedOptions = options.map(option => (
    enrichOptionWithCodeTables(
      option,
      locationsByCode,
      servicesByCode,
      countriesByDestination,
    )
  ));
  const arrayOfOptionsGroupedBySupplierId = R.call(R.compose(
    R.values,
    R.groupBy(R.path(['OptGeneral', 'SupplierId'])),
  ), enrichedOptions);
  const products = await Promise.map(
    arrayOfOptionsGroupedBySupplierId,
    optionsGroupedBySupplierId => translateTPOption({
      rootValue: {
        optionsGroupedBySupplierId,
      },
      agentCurrencyCode,
      typeDefs: itineraryProductTypeDefs,
      query: itineraryProductQuery,
    }),
    {
      concurrency: 10,
    },
  );
  // Preserve raw OptRates / PickupPoints from Tourplan in product search response
  // when available (camelCase keys: optRates, pickupPoints; Tourplan field casing
  // inside). Re-attach after GraphQL because stock TI2 itinerary-product
  // typeDefs/query omit these fields (same for city/country/currency).
  // Also ensure city and currency are always on the option for product cache.
  const enrichedByOptionId = R.indexBy(R.prop('Opt'), enrichedOptions);
  const optionRatesByOptionId = options.reduce((acc, option) => {
    const currentOptionId = R.path(['Opt'], option);
    const currentOptionRates = R.path(['OptRates'], option);
    if (!currentOptionId || !currentOptionRates) return acc;
    return {
      ...acc,
      [currentOptionId]: currentOptionRates,
    };
  }, {});
  const productsWithRawOptionMetadata = products.map(product => ({
    ...product,
    options: R.pathOr([], ['options'], product).map(currentOption => {
      const rawOption = R.path([currentOption.optionId], enrichedByOptionId) || {};
      const currency = currentOption.currency
        || getOptionCurrency(rawOption, agentCurrencyCode)
        || R.path([currentOption.optionId, 'Currency'], optionRatesByOptionId);
      const city = currentOption.city
        || R.path(['__destination', 'city'], rawOption);
      const country = currentOption.country
        || R.path(['__destination', 'country'], rawOption);
      const pickupPoints = shouldRequestPickupPoints
        ? normalizePickupPoints(
          R.path(['OptGeneral', 'PickupPoints'], rawOption)
            || R.path(['PickupPoints'], rawOption),
        )
        : undefined;
      return {
        ...R.omit(['city', 'country', 'rateContext'], currentOption),
        ...(city ? { city } : {}),
        ...(country ? { country } : {}),
        ...(currency ? { currency } : {}),
        ...(pickupPoints ? { pickupPoints } : {}),
        ...(R.path([currentOption.optionId], optionRatesByOptionId)
          ? { optRates: R.path([currentOption.optionId], optionRatesByOptionId) }
          : {}),
      };
    }),
  }));
  return {
    products: productsWithRawOptionMetadata,
    productFields: [],
    ...(searchInput || optionId ? {} : configuration),
  };
};

module.exports = {
  searchProductsForItinerary,
};
