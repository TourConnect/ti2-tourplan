/* eslint-disable no-underscore-dangle */
/* globals describe, it, expect */
const { toLocationMap } = require('./locations');
const {
  enrichOptionWithCodeTables,
  parseOptCodes,
} = require('./option-enrichment');

describe('tp-helpers/option-enrichment', () => {
  it('parses location and service codes from optionId', () => {
    expect(parseOptCodes('LONHOMILBAIBBCLSC')).toEqual({
      locationCode: 'LON',
      serviceCode: 'HO',
    });
  });

  it('sets city from GetLocations, country from GetSystemSettings, and prefers GetServices over ButtonName', () => {
    const enriched = enrichOptionWithCodeTables(
      {
        Opt: 'CPTHOHOTELSBCLSC',
        OptGeneral: {
          SupplierId: '1',
          ButtonName: 'Accommodation',
          Address3: 'Johannesburg',
        },
      },
      toLocationMap([
        { Code: 'CPT', Name: 'Cape Town' },
      ]),
      { HO: 'Hotel' },
      { 'cape town': 'South Africa' },
    );

    expect(enriched.__destination).toEqual({
      locationCode: 'CPT',
      city: 'Cape Town',
      name: 'Cape Town',
      country: 'South Africa',
    });
    expect(enriched.OptGeneral.Locality).toBe('CPT');
    expect(enriched.OptGeneral.LocalityDescription).toBe('Cape Town');
    // optionId chars 3-4 = HO → GetServices "Hotel" wins over ButtonName
    expect(enriched.OptGeneral.ButtonName).toBe('Hotel');
  });

  it('does not set country when destination maps only under Undefined CountryName', () => {
    const enriched = enrichOptionWithCodeTables(
      {
        Opt: 'AKLACHOTELSBCLSC',
        OptGeneral: {
          SupplierId: '1',
          ButtonName: 'Accommodation',
        },
      },
      toLocationMap([{ Code: 'AKL', Name: 'Auckland' }]),
      { AC: 'Accommodation' },
      {}, // PDNZ-style empty map after skipping Undefined
    );

    expect(enriched.__destination).toEqual({
      locationCode: 'AKL',
      city: 'Auckland',
      name: 'Auckland',
    });
    expect(enriched.__destination.country).toBeUndefined();
  });

  it('falls back to ButtonName when GetServices has no match for optionId service code', () => {
    const enriched = enrichOptionWithCodeTables(
      {
        Opt: 'LONZZDAVIDSLTCLVC',
        OptGeneral: {
          SupplierId: '1',
          ButtonName: 'Transfers',
          Locality: 'XXX',
        },
      },
      toLocationMap([{ Code: 'LON', Name: 'London' }]),
      { TR: 'Transfers' },
    );

    expect(enriched.__destination.locationCode).toBe('LON');
    expect(enriched.__destination.city).toBe('London');
    expect(enriched.OptGeneral.ButtonName).toBe('Transfers');
  });

  it('falls back to ButtonName when GetServices has a blank name for the optionId service code', () => {
    const enriched = enrichOptionWithCodeTables(
      {
        Opt: 'LONSMDAVIDSLTCLVC',
        OptGeneral: {
          SupplierId: '1',
          ButtonName: 'Sightseeing',
        },
      },
      toLocationMap([{ Code: 'LON', Name: 'London' }]),
      { SM: '' },
    );

    expect(enriched.__destination.locationCode).toBe('LON');
    expect(enriched.__destination.city).toBe('London');
    expect(enriched.OptGeneral.ButtonName).toBe('Sightseeing');
  });

  it('uses GetServices from optionId when ButtonName is missing', () => {
    const enriched = enrichOptionWithCodeTables(
      {
        Opt: 'LONTRDAVIDSLTCLVC',
        OptGeneral: {
          SupplierId: '1',
        },
      },
      toLocationMap([{ Code: 'LON', Name: 'London' }]),
      { TR: 'Transfers' },
    );

    expect(enriched.OptGeneral.ButtonName).toBe('Transfers');
  });
});
