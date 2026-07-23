const R = require('ramda');
const { hostConnectXmlOptions } = require('../utils');
const { asArray, trimString } = require('./values');

/** Refresh GetServices cache monthly after the first successful fetch. */
const SERVICES_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Normalize GetServices rows to { CODE: Name }. Keep codes even when Name is blank. */
const toServiceMap = (entries, { codeKey = 'Code', nameKey = 'Name' } = {}) => (
  asArray(entries).reduce((acc, entry) => {
    const code = trimString(R.path([codeKey], entry));
    const name = trimString(R.path([nameKey], entry));
    if (code) {
      acc[code.toUpperCase()] = name || '';
    }
    return acc;
  }, {})
);

/** Resolve service type name from the company-specific GetServices map. */
const resolveServiceType = (serviceCode, servicesByCode = {}) => {
  if (!serviceCode) return undefined;
  const code = String(serviceCode).toUpperCase();
  return trimString(servicesByCode[code]);
};

/**
 * Fetch GetServices once per agent/endpoint, then serve from cache for 30 days.
 */
const getCachedServices = async ({
  callTourplan,
  cache,
  axios,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
}) => {
  const model = {
    GetServicesRequest: {
      AgentID: hostConnectAgentID,
      Password: hostConnectAgentPassword,
    },
  };
  const fetchServices = async () => {
    const reply = await callTourplan({
      model,
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    });
    return toServiceMap(
      R.pathOr([], ['GetServicesReply', 'TPLServices', 'TPLService'], reply),
    );
  };

  if (cache && cache.getOrExec) {
    return cache.getOrExec({
      fnParams: ['hostconnect:GetServices', hostConnectEndpoint, hostConnectAgentID],
      fn: fetchServices,
      ttl: SERVICES_CACHE_TTL_SECONDS,
    });
  }
  return fetchServices();
};

module.exports = {
  SERVICES_CACHE_TTL_SECONDS,
  getCachedServices,
  resolveServiceType,
  toServiceMap,
};
