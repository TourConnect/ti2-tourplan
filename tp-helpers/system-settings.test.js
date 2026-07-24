const {
  SYSTEM_SETTINGS_CACHE_TTL_SECONDS,
  isPlaceholderCountry,
  normalizeCountryName,
  normalizeDestinationKey,
  resolveCountryFromDestination,
  toDestinationCountryMap,
} = require('./system-settings');

describe('tp-helpers/system-settings', () => {
  it('refreshes GetSystemSettings cache monthly', () => {
    expect(SYSTEM_SETTINGS_CACHE_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
  });

  it('skips Undefined and Unassigned country names (e.g. PDNZ)', () => {
    expect(isPlaceholderCountry('Undefined')).toBe(true);
    expect(isPlaceholderCountry('Unassigned')).toBe(true);
    expect(isPlaceholderCountry('United Kingdom')).toBe(false);

    expect(toDestinationCountryMap([{
      CountryName: 'Undefined',
      DestinationNames: {
        DestinationName: ['Auckland', 'Queenstown'],
      },
    }])).toEqual({});
  });

  it('strips numeric prefixes from CountryName (e.g. ASA "1 - United Kingdom")', () => {
    expect(normalizeCountryName('1 - United Kingdom')).toBe('United Kingdom');
    expect(normalizeCountryName('12. France')).toBe('France');
    expect(normalizeCountryName('United Kingdom')).toBe('United Kingdom');

    expect(toDestinationCountryMap([{
      CountryName: '1 - United Kingdom',
      DestinationNames: {
        DestinationName: ['London', 'Bath'],
      },
    }])).toEqual({
      london: 'United Kingdom',
      bath: 'United Kingdom',
    });
  });

  it('maps destination names to country and strips wrapping quotes', () => {
    expect(normalizeDestinationKey("'London'")).toBe('london');
    expect(toDestinationCountryMap([
      {
        CountryName: 'United Kingdom',
        DestinationNames: {
          DestinationName: ["'London'", 'Edinburgh'],
        },
      },
      {
        CountryName: 'France',
        DestinationNames: {
          DestinationName: 'Paris',
        },
      },
      {
        CountryName: 'Unassigned',
        DestinationNames: {
          DestinationName: 'Nowhere',
        },
      },
    ])).toEqual({
      london: 'United Kingdom',
      edinburgh: 'United Kingdom',
      paris: 'France',
    });
  });

  it('resolveCountryFromDestination looks up by normalized city/destination', () => {
    const map = toDestinationCountryMap([{
      CountryName: 'United Kingdom',
      DestinationNames: { DestinationName: ["'London'"] },
    }]);
    expect(resolveCountryFromDestination('London', map)).toBe('United Kingdom');
    expect(resolveCountryFromDestination("'London'", map)).toBe('United Kingdom');
    expect(resolveCountryFromDestination('Unknownville', map)).toBeUndefined();
  });
});
