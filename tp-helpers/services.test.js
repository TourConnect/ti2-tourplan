/* globals describe, it, expect, jest */
const {
  getCachedServices,
  SERVICES_CACHE_TTL_SECONDS,
  resolveServiceType,
  toServiceMap,
} = require('./services');

describe('tp-helpers/services', () => {
  it('refreshes GetServices cache monthly', () => {
    expect(SERVICES_CACHE_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
  });

  it('normalizes GetServices rows', () => {
    expect(toServiceMap([
      { Code: 'ho', Name: 'Hotel' },
      { Code: 'TR', Name: 'Transfers' },
      { Code: 'sm' },
      { Code: 'xx', Name: '  ' },
    ])).toEqual({
      HO: 'Hotel',
      TR: 'Transfers',
      SM: '',
      XX: '',
    });
  });

  it('resolves service type only from GetServices map', () => {
    expect(resolveServiceType('HO', { HO: 'Hotel' })).toBe('Hotel');
    expect(resolveServiceType('HO', {})).toBeUndefined();
  });

  it('uses the GetServices cache key and keeps blank-name service codes on refresh', async () => {
    const callTourplan = jest.fn().mockResolvedValue({
      GetServicesReply: {
        TPLServices: {
          TPLService: [
            { Code: 'SM', Name: '  ' },
          ],
        },
      },
    });
    const cache = {
      getOrExec: jest.fn(({ fn }) => fn()),
    };

    const services = await getCachedServices({
      callTourplan,
      cache,
      axios: {},
      hostConnectEndpoint: 'endpoint',
      hostConnectAgentID: 'agent',
      hostConnectAgentPassword: 'password',
    });

    expect(cache.getOrExec).toHaveBeenCalledWith(expect.objectContaining({
      fnParams: ['hostconnect:GetServices', 'endpoint', 'agent'],
      ttl: SERVICES_CACHE_TTL_SECONDS,
    }));
    expect(callTourplan).toHaveBeenCalledTimes(1);
    expect(services).toEqual({ SM: '' });
  });
});
