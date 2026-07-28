/* globals describe, it, expect, jest */
const {
  getCachedLocations,
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

  it('separates catalog and create-itinerary cache policies', async () => {
    const callTourplan = jest.fn().mockResolvedValue({
      GetLocationsReply: { Locations: { Location: [] } },
    });
    const cache = { getOrExec: jest.fn(({ fn }) => fn()) };
    const baseParams = {
      callTourplan,
      cache,
      axios: {},
      hostConnectEndpoint: 'endpoint',
      hostConnectAgentID: 'agent',
      hostConnectAgentPassword: 'password',
    };

    await getCachedLocations(baseParams);
    await getCachedLocations({
      ...baseParams,
      cacheScope: 'create-itinerary-fields',
      ttl: 60 * 60 * 12,
    });

    expect(cache.getOrExec.mock.calls[0][0]).toEqual(expect.objectContaining({
      fnParams: ['hostconnect:GetLocations', 'catalog', 'endpoint', 'agent'],
      ttl: LOCATIONS_CACHE_TTL_SECONDS,
    }));
    expect(cache.getOrExec.mock.calls[1][0]).toEqual(expect.objectContaining({
      fnParams: [
        'hostconnect:GetLocations',
        'create-itinerary-fields',
        'endpoint',
        'agent',
      ],
      ttl: 60 * 60 * 12,
    }));
  });
});
