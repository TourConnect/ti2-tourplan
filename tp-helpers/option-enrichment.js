const R = require('ramda');
const { resolveLocation } = require('./locations');
const { resolveServiceType } = require('./services');
const { resolveCountryFromDestination } = require('./system-settings');

const firstPresent = (...values) => values.find(
  value => value !== undefined && value !== null && value !== '',
);

/** Parse location (3) + service (2) codes from a Tourplan Opt / optionId. */
const parseOptCodes = opt => {
  if (typeof opt !== 'string' || opt.trim().length < 5) return {};
  const normalized = opt.trim().toUpperCase();
  return {
    locationCode: normalized.slice(0, 3),
    serviceCode: normalized.slice(3, 5),
  };
};

/**
 * Enrich an option from company GetLocations + GetServices + GetSystemSettings maps.
 * - city from location code in optionId via GetLocations Name
 * - service type prefers GetServices (optionId chars 3-4), else ButtonName
 * - country from GetSystemSettings destination → CountryName (skips Undefined)
 */
const enrichOptionWithCodeTables = (
  option,
  locationsByCode = {},
  servicesByCode = {},
  countriesByDestination = {},
) => {
  const optGeneral = R.pathOr({}, ['OptGeneral'], option);
  const parsed = parseOptCodes(R.path(['Opt'], option));
  const locationCode = firstPresent(
    parsed.locationCode,
    optGeneral.Locality,
  );
  const serviceCode = parsed.serviceCode;
  const location = resolveLocation(locationCode, locationsByCode);
  const serviceType = firstPresent(
    resolveServiceType(serviceCode, servicesByCode),
    optGeneral.ButtonName,
  );

  const city = location && location.city;
  const locationName = location && (location.name || location.city);
  const country = resolveCountryFromDestination(
    firstPresent(
      city,
      locationName,
      optGeneral.LocalityDescription,
      optGeneral.Address3,
    ),
    countriesByDestination,
  );

  return {
    ...option,
    ...((location || country) ? {
      __destination: {
        ...(location ? {
          locationCode: location.code,
          city,
          name: locationName,
        } : {}),
        ...(country ? { country } : {}),
      },
    } : {}),
    OptGeneral: {
      ...optGeneral,
      ...(locationCode ? { Locality: String(locationCode).toUpperCase() } : {}),
      ...(locationName ? { LocalityDescription: locationName } : {}),
      ...(serviceType ? { ButtonName: serviceType } : {}),
    },
  };
};

module.exports = {
  enrichOptionWithCodeTables,
  parseOptCodes,
};
