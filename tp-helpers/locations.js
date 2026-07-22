const R = require('ramda');
const { hostConnectXmlOptions } = require('../utils');

/** Refresh GetLocations cache monthly after the first successful fetch. */
const LOCATIONS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

const asArray = value => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const trimString = value => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

/**
 * Normalize GetLocations rows to { CODE: { code, name, city } }.
 * HostConnect GetLocations returns Code + Name only; Name is used as city.
 */
const toLocationMap = entries => (
  asArray(entries).reduce((acc, entry) => {
    if (!entry || typeof entry !== 'object') return acc;
    const code = trimString(entry.Code || entry.code);
    if (!code) return acc;
    const name = trimString(
      entry.Name || entry.Description || entry.name || entry.description,
    );
    const normalizedCode = code.toUpperCase();
    acc[normalizedCode] = {
      code: normalizedCode,
      name,
      city: name,
    };
    return acc;
  }, {})
);

const locationLabel = location => {
  if (!location) return undefined;
  if (typeof location === 'string') return location;
  return location.name || location.city;
};

/** Resolve location record from the company-specific GetLocations map. */
const resolveLocation = (locationCode, locationsByCode = {}) => {
  if (!locationCode) return undefined;
  const code = String(locationCode).toUpperCase();
  const location = locationsByCode[code];
  if (!location) return undefined;
  if (typeof location === 'string') {
    return {
      code,
      name: location,
      city: location,
    };
  }
  return location;
};

/**
 * Fetch GetLocations once per agent/endpoint, then serve from cache for a month.
 */
const getCachedLocations = async ({
  callTourplan,
  cache,
  axios,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
}) => {
  const model = {
    GetLocationsRequest: {
      AgentID: hostConnectAgentID,
      Password: hostConnectAgentPassword,
    },
  };
  const fetchLocations = async () => {
    const reply = await callTourplan({
      model,
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    });
    return toLocationMap(
      R.pathOr([], ['GetLocationsReply', 'Locations', 'Location'], reply),
    );
  };

  if (cache && cache.getOrExec) {
    return cache.getOrExec({
      fnParams: ['hostconnect:GetLocations', hostConnectEndpoint, hostConnectAgentID],
      fn: fetchLocations,
      ttl: LOCATIONS_CACHE_TTL_SECONDS,
    });
  }
  return fetchLocations();
};

module.exports = {
  LOCATIONS_CACHE_TTL_SECONDS,
  getCachedLocations,
  locationLabel,
  resolveLocation,
  toLocationMap,
};
