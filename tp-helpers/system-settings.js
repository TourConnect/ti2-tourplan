const R = require('ramda');
const { hostConnectXmlOptions } = require('../utils');

/** Refresh GetSystemSettings cache monthly after the first successful fetch. */
const SYSTEM_SETTINGS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

const asArray = value => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const trimString = value => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

/** Skip placeholder country names (e.g. PDNZ returns CountryName Undefined). */
const isPlaceholderCountry = countryName => (
  /^(undefined|unassigned)$/i.test(String(countryName || '').trim())
);

/**
 * Normalize CountryName from GetSystemSettings.
 * Some companies prefix with a sort index, e.g. "1 - United Kingdom".
 */
const normalizeCountryName = countryName => {
  let value = trimString(countryName);
  if (!value) return undefined;
  value = value.replace(/^\d+\s*[-–.:)]\s*/, '').trim();
  return value || undefined;
};

/**
 * Normalize destination labels for lookup.
 * HostConnect sometimes wraps names in quotes (e.g. 'London').
 */
const normalizeDestinationKey = name => {
  let value = trimString(name);
  if (!value) return undefined;
  if (
    (value.startsWith("'") && value.endsWith("'"))
    || (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value ? value.toLowerCase() : undefined;
};

/**
 * Build { destinationKey: CountryName } from GetSystemSettings Countries.
 * Destinations under Undefined/Unassigned CountryName are omitted.
 */
const toDestinationCountryMap = countries => (
  asArray(countries).reduce((acc, country) => {
    if (!country || typeof country !== 'object') return acc;
    const countryName = normalizeCountryName(country.CountryName || country.countryName);
    if (!countryName || isPlaceholderCountry(countryName)) return acc;

    const destinations = asArray(
      R.pathOr([], ['DestinationNames', 'DestinationName'], country),
    );
    destinations.forEach(destination => {
      const key = normalizeDestinationKey(destination);
      if (!key || acc[key]) return;
      acc[key] = countryName;
    });
    return acc;
  }, {})
);

/** Resolve country name from a city / destination label. */
const resolveCountryFromDestination = (destinationName, countriesByDestination = {}) => {
  const key = normalizeDestinationKey(destinationName);
  if (!key) return undefined;
  return countriesByDestination[key];
};

/**
 * Fetch GetSystemSettings once per agent/endpoint, then serve from cache for a month.
 * Returns destination → country map used to set product option country.
 */
const getCachedDestinationCountries = async ({
  callTourplan,
  cache,
  axios,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
}) => {
  const model = {
    GetSystemSettingsRequest: {
      AgentID: hostConnectAgentID,
      Password: hostConnectAgentPassword,
    },
  };
  const fetchDestinationCountries = async () => {
    const reply = await callTourplan({
      model,
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    });
    return toDestinationCountryMap(
      R.pathOr([], ['GetSystemSettingsReply', 'Countries', 'Country'], reply),
    );
  };

  if (cache && cache.getOrExec) {
    return cache.getOrExec({
      fnParams: ['hostconnect:GetSystemSettings', hostConnectEndpoint, hostConnectAgentID],
      fn: fetchDestinationCountries,
      ttl: SYSTEM_SETTINGS_CACHE_TTL_SECONDS,
    });
  }
  return fetchDestinationCountries();
};

module.exports = {
  SYSTEM_SETTINGS_CACHE_TTL_SECONDS,
  getCachedDestinationCountries,
  isPlaceholderCountry,
  normalizeCountryName,
  normalizeDestinationKey,
  resolveCountryFromDestination,
  toDestinationCountryMap,
};
