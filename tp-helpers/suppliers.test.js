/* globals describe, it, expect, jest */
const {
  getCachedSuppliers,
  SUPPLIERS_CACHE_TTL_SECONDS,
  toSupplierMap,
} = require('./suppliers');

describe('tp-helpers/suppliers', () => {
  it('refreshes SupplierInfo cache monthly', () => {
    expect(SUPPLIERS_CACHE_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
  });

  it('indexes a supplier by id and code', () => {
    const supplier = {
      SupplierId: 7318,
      SupplierCode: 'HOTELS',
      Name: 'Example Hotel',
      SupplierNotes: {
        SupplierNote: { NoteText: 'Family owned hotel' },
      },
    };
    const map = toSupplierMap(supplier);
    expect(map['7318']).toBe(supplier);
    expect(map.HOTELS).toBe(supplier);
  });

  it('caches SupplierInfo per endpoint and agent', async () => {
    const callTourplan = jest.fn().mockResolvedValue({
      SupplierInfoReply: { Suppliers: { Supplier: [] } },
    });
    const cache = { getOrExec: jest.fn(({ fn }) => fn()) };
    await getCachedSuppliers({
      callTourplan,
      cache,
      axios: {},
      hostConnectEndpoint: 'endpoint',
      hostConnectAgentID: 'agent',
      hostConnectAgentPassword: 'password',
    });
    expect(cache.getOrExec).toHaveBeenCalledWith(expect.objectContaining({
      fnParams: ['hostconnect:SupplierInfo', 'endpoint', 'agent'],
      ttl: SUPPLIERS_CACHE_TTL_SECONDS,
    }));
    expect(callTourplan).toHaveBeenCalledWith(expect.objectContaining({
      model: {
        SupplierInfoRequest: {
          AgentID: 'agent',
          Password: 'password',
        },
      },
    }));
  });
});
