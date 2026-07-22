const {
  LOCATIONS_CACHE_TTL_SECONDS,
  locationLabel,
  resolveLocation,
  toLocationMap,
} = require('./locations');

describe('tp-helpers/locations', () => {
  it('refreshes GetLocations cache monthly', () => {
    expect(LOCATIONS_CACHE_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
  });

  it('builds location records from GetLocations Code + Name only', () => {
    expect(toLocationMap([
      { Code: 'CPT', Name: 'Cape Town' },
      { Code: 'VFA', Name: 'Victoria Falls' },
    ])).toEqual({
      CPT: {
        code: 'CPT',
        name: 'Cape Town',
        city: 'Cape Town',
      },
      VFA: {
        code: 'VFA',
        name: 'Victoria Falls',
        city: 'Victoria Falls',
      },
    });
  });

  it('resolveLocation returns undefined when code missing from GetLocations', () => {
    expect(resolveLocation('ZZZ', toLocationMap([{ Code: 'LON', Name: 'London' }]))).toBeUndefined();
  });

  it('locationLabel prefers name then city', () => {
    expect(locationLabel({ name: 'London', city: 'City' })).toBe('London');
    expect(locationLabel({ city: 'Cape Town' })).toBe('Cape Town');
    expect(locationLabel('Paris')).toBe('Paris');
  });
});
