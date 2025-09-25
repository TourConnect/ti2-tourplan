const R = require('ramda');
const crypto = require('crypto');
const { productConnectXmlOptions } = require('../../utils');

/*
  This is used to test if the Product Connect API is enabled and if the credentials are correct

  It calls the GetAgent API for a fixed AgentCode 'A????'.
  + If the API returns a valid response product product connect credentials are correct.
  + Else, product connect credentials are incorrect.

  @param {Object} params - Configuration parameters
  @param {string} productConnectEndpoint - The product connect endpoint
  @param {string} productConnectUser - The product connect user
  @param {string} productConnectUserPassword - The product connect user password
  @param {Object} axios - The axios instance
  @param {Object} callTourplan - The callTourplan function
  @returns {boolean} True GetAgent API returns a valid response, false otherwise
*/
const testProductConnectAPI = async ({
  productConnectEndpoint,
  productConnectUser,
  productConnectUserPassword,
  axios,
  callTourplan,
}) => {
  // Input validation
  if (!productConnectEndpoint || typeof productConnectEndpoint !== 'string') {
    throw new Error('Invalid productConnectEndpoint provided - must be a non-empty string');
  }
  if (!productConnectUser || typeof productConnectUser !== 'string') {
    throw new Error('Invalid productConnectUser provided - must be a non-empty string');
  }
  if (!productConnectUserPassword || typeof productConnectUserPassword !== 'string') {
    throw new Error('Invalid productConnectUserPassword provided - must be a non-empty string');
  }
  try {
    const productConnectModel = {
      GetAgentRequest: {
        User: productConnectUser,
        Password: productConnectUserPassword,
        AgentCode: 'A????',
      },
    };
    const replyProductConnectObj = await callTourplan({
      model: productConnectModel,
      endpoint: productConnectEndpoint,
      axios,
      xmlOptions: productConnectXmlOptions,
    });
    const isProductConnectEnabled = Boolean(R.path(['GetAgentReply', 'AgentData'], replyProductConnectObj));
    if (isProductConnectEnabled) {
      console.info('INFO: ProductConnect is Enabled');
    } else {
      console.info('INFO: ProductConnect is Disabled');
    }
    return isProductConnectEnabled;
  } catch (err) {
    console.warn('WARNING: Product connect validation failed:', err.message);
    return false;
  }
};

/*
  Validate the Product Connect API settings

  @param {Object} params - Configuration parameters
  @param {string} productConnectEndpoint - The product connect endpoint
  @param {string} productConnectUser - The product connect user
  @param {string} productConnectUserPassword - The product connect user password
  @param {Object} axios - The axios instance
  @param {Object} callTourplan - The callTourplan function
  @param {Object} cache - The cache instance
  @param {boolean} useCache - Whether to use the cache
  @returns {boolean} True if the Product Connect is configured correctly, false otherwise
*/
const validateProductConnect = async ({
  productConnectEndpoint,
  productConnectUser,
  productConnectUserPassword,
  axios,
  callTourplan,
  cache,
  useCache = false,
}) => {
  if (!productConnectEndpoint) {
    console.warn('WARNING: ProductConnect Endpoint is not set.');
    return true;
  }
  if (!productConnectUser || !productConnectUserPassword) {
    console.warn('WARNING: ProductConnect User or Password is not set.');
    return false;
  }

  if (cache && cache.getOrExec && useCache) {
    try {
      const sanitizedEndpoint = productConnectEndpoint.replace(/[^a-zA-Z0-9]/g, '');
      const sensitiveKey = `${productConnectUser}|${productConnectUserPassword}|${sanitizedEndpoint}`;
      const cacheKey = `productConnectValid_${crypto.createHash('sha256').update(sensitiveKey).digest('hex').slice(0, 16)}`;
      console.log('validateProductConnect::cacheKey: ', cacheKey);
      const isValid = await cache.getOrExec({
        fnParams: [cacheKey],
        fn: async () => testProductConnectAPI({
          productConnectEndpoint,
          productConnectUser,
          productConnectUserPassword,
          axios,
          callTourplan,
        }),
        ttl: 60 * 60 * 24,
      });
      return isValid;
    } catch (cacheErr) {
      console.warn('WARNING: Product connect validation cache error:', cacheErr.message);
    }
  }

  return testProductConnectAPI({
    productConnectEndpoint,
    productConnectUser,
    productConnectUserPassword,
    axios,
    callTourplan,
  });
};

module.exports = {
  validateProductConnect,
};
