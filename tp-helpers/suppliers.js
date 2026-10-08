const R = require('ramda');
const { hostConnectXmlOptions } = require('../utils');
const { asArray, trimString } = require('./values');

/** Refresh SupplierInfo cache monthly after the first successful fetch. */
const SUPPLIERS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

const supplierKey = value => {
  if (value === undefined || value === null) return undefined;
  return trimString(String(value));
};

/**
 * Normalize SupplierInfo rows to { supplierId: supplier, supplierCode: supplier }.
 * Notes live at SupplierNotes/SupplierNote/NoteText, not on OptGeneral.
 */
const toSupplierMap = entries => (
  asArray(entries).reduce((acc, entry) => {
    if (!entry || typeof entry !== 'object') return acc;
    const id = supplierKey(entry.SupplierId);
    const code = supplierKey(entry.SupplierCode);
    if (id) acc[id] = entry;
    if (code) acc[code] = entry;
    return acc;
  }, {})
);

/**
 * Fetch SupplierInfo once per agent/endpoint, then serve from cache for a month.
 * An unfiltered request returns the company supplier list, including notes.
 */
const getCachedSuppliers = async ({
  callTourplan,
  cache,
  axios,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
}) => {
  const model = {
    SupplierInfoRequest: {
      AgentID: hostConnectAgentID,
      Password: hostConnectAgentPassword,
    },
  };
  const fetchSuppliers = async () => {
    const reply = await callTourplan({
      model,
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    });
    return toSupplierMap(
      R.pathOr([], ['SupplierInfoReply', 'Suppliers', 'Supplier'], reply),
    );
  };

  if (cache && cache.getOrExec) {
    return cache.getOrExec({
      fnParams: ['hostconnect:SupplierInfo', hostConnectEndpoint, hostConnectAgentID],
      fn: fetchSuppliers,
      ttl: SUPPLIERS_CACHE_TTL_SECONDS,
    });
  }
  return fetchSuppliers();
};

module.exports = {
  SUPPLIERS_CACHE_TTL_SECONDS,
  getCachedSuppliers,
  toSupplierMap,
};
