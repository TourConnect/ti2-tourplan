/* eslint-disable max-len */
const axiosRaw = require('axios');
const R = require('ramda');
const assert = require('assert');
const moment = require('moment');
const js2xmlparser = require('js2xmlparser');
const xml2js = require('xml2js');
const { XMLParser } = require('fast-xml-parser');
const Normalizer = require('./normalizer');

const { searchAvailabilityForItinerary } = require('./availability/itinerary-availability');
const { addServiceToItinerary } = require('./itinerary-add-service');
const { searchProductsForItinerary } = require('./itinerary-products-search');
const { searchItineraries } = require('./itinerary-search');

const xmlParser = new xml2js.Parser();
const fastParser = new XMLParser();

const defaultXmlOptions = {
  prettyPrinting: { enabled: false },
  dtd: {
    include: true,
    name: 'tourConnect_4_00_000.dtd',
  },
};
const getHeaders = ({ length }) => ({
  Accept: 'application/xml',
  'Content-Type': 'application/xml; charset=utf-8',
  'Content-Length': length,
});

class BuyerPlugin {
  constructor(params = {}) { // we get the env variables from here
    Object.entries(params).forEach(([attr, value]) => {
      this[attr] = value;
    });
    this.tokenTemplate = () => ({
      endpoint: {
        type: 'text',
        regExp: /^(?!mailto:)(?:(?:http|https|ftp):\/\/)(?:\S+(?::\S*)?@)?(?:(?:(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[0-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u00a1-\uffff0-9]+-?)*[a-z\u00a1-\uffff0-9]+)(?:\.(?:[a-z\u00a1-\uffff0-9]+-?)*[a-z\u00a1-\uffff0-9]+)*(?:\.(?:[a-z\u00a1-\uffff]{2,})))|localhost)(?::\d{2,5})?(?:(\/|\?|#)[^\s]*)?$/i,
        description: 'The uri for the tourplan adapter',
      },
      username: {
        type: 'text',
        regExp: /.+/,
        description: 'The tourplan provided username',
        default: 'en',
      },
      password: {
        type: 'text',
        regExp: /.+/,
        description: 'The tourplan provided password',
        default: 'en',
      },
      hostConnectEndpoint: {
        type: 'text',
        regExp: /.+/,
      },
      hostConnectAgentID: {
        type: 'text',
        regExp: /.+/,
      },
      hostConnectAgentPassword: {
        type: 'text',
        regExp: /.+/,
      },
      displayRateInSupplierCurrency: {
        type: 'text',
        regExp: /^(yes|no)$/i,
        default: 'N',
      },
      customRatesEnableForQuotesAndBookings: {
        type: 'text',
        regExp: /^(yes|no)$/i,
        default: 'No',
      },
      customRatesMarkupPercentage: {
        type: 'number',
        regExp: /^(100|[1-9]?\d)(\.\d{1,2})?$/,
        default: 10,
      },
      customRatesCalculateWithLastYearsRate: {
        type: 'text',
        regExp: /^(Yes|No)$/i,
        default: 'No',
      },
      customRatesExtendedBookingYears: {
        type: 'number',
        regExp: /^(1|2|3|4|5|6|7|8|9|10)$/i,
        default: 1,
      },
    });
    
    // Get DTD cache days from environment variable, default to 7 days
    const dtdDays = parseInt(this.DTD_DAYS || '7', 10);
    const dtdCacheTtl = (60 * 60 * 24) * dtdDays; // Convert days to seconds
    
    this.cacheSettings = {
      bookingsProductSearch: {
        // ttl: 60 * 60 * 24, // 1 day
      },
      dtdVersions: {
        ttl: dtdCacheTtl,
      },
    };
    
    // Store DTD versions in memory as a fallback when cache is not available
    this.dtdVersionCache = {};
    
    this.getCorrectDtdVersion = async ({ endpoint, axios }) => {
      const cacheKey = `dtd_version_${endpoint}`;
      
      // If cache is available, use it
      if (this.cache && this.cache.getOrExec) {
        try {
          const cachedVersion = await this.cache.getOrExec({
            fnParams: [cacheKey],
            fn: async () => this.detectDtdVersion({ endpoint, axios }),
            ttl: this.cacheSettings.dtdVersions.ttl,
          });
          return cachedVersion;
        } catch (cacheErr) {
          // Cache error, fall back to memory cache
        }
      }
      
      // Fallback to memory cache when cache is not available
      const now = Date.now();
      const memoryCached = this.dtdVersionCache[cacheKey];
      
      if (memoryCached && memoryCached.expiry > now) {
        return memoryCached.version;
      }
      
      // Detect the DTD version
      const detectedVersion = await this.detectDtdVersion({ endpoint, axios });
      
      // Store in memory cache
      this.dtdVersionCache[cacheKey] = {
        version: detectedVersion,
        expiry: now + (this.cacheSettings.dtdVersions.ttl * 1000), // Convert seconds to milliseconds
      };
      
      return detectedVersion;
    };
    
    this.detectDtdVersion = async ({ endpoint, axios }) => {
      // Try with the default DTD version first
      const defaultDtd = 'tourConnect_4_00_000.dtd';
      const testXmlOptions = {
        prettyPrinting: { enabled: false },
        dtd: {
          include: true,
          name: defaultDtd,
        },
      };
      
      const model = {
        AuthenticationRequest: {
          Login: 'test',
          Password: 'test',
        },
      };
      
      let data = Normalizer.stripEnclosingQuotes(
        js2xmlparser.parse('Request', model, testXmlOptions),
      );
      data = data.replace(/(?<!<)\/(?![^<]*>)/g, '&#47;');
      data = data.replace(testXmlOptions.dtd.name, `Request SYSTEM "${testXmlOptions.dtd.name}"`);
      
      try {
        const reply = await axios({
          method: 'post',
          url: endpoint,
          data,
          headers: getHeaders({ length: data.length }),
        });
        
        // The API returns 200 even for DTD errors, so check the response content
        const responseData = R.path(['data'], reply);
        if (responseData && typeof responseData === 'string') {
          // Check if this is an XML error response about DTD version
          if (responseData.includes('<Error>') && responseData.includes('This DTD version')) {
            // Parse the XML error to extract the required DTD version
            const match = responseData.match(/Please use the latest DTD version:\s*([a-zA-Z0-9_]+\.dtd)/);
            if (match && match[1]) {
              return match[1];
            }
          }
          
          // Also try parsing as JSON in case it was already converted
          try {
            const parsedResponse = fastParser.parse(responseData);
            const errorDetails = R.path(['Error', 'Details'], parsedResponse);
            if (errorDetails && errorDetails.includes('This DTD version')) {
              const match = errorDetails.match(/Please use the latest DTD version:\s*([a-zA-Z0-9_]+\.dtd)/);
              if (match && match[1]) {
                return match[1];
              }
            }
          } catch (parseErr) {
            // Not valid XML/JSON, continue
          }
        }
        
        // If no error, the default DTD is correct
        return defaultDtd;
      } catch (err) {
        // Check if the error response contains DTD version info
        const errorResponse = R.path(['response', 'data'], err);
        if (errorResponse && typeof errorResponse === 'string') {
          // Check if this is an XML error response about DTD version
          if (errorResponse.includes('<Error>') && errorResponse.includes('This DTD version')) {
            // Parse the XML error to extract the required DTD version
            const match = errorResponse.match(/Please use the latest DTD version:\s*([a-zA-Z0-9_]+\.dtd)/);
            if (match && match[1]) {
              return match[1];
            }
          }
        }
        
        // Network or other errors - use default
        return defaultDtd;
      }
    };
    
    this.callTourplan = async ({
      model,
      endpoint,
      axios,
      xmlOptions,
    }) => {
      // Only apply DTD version detection for regular TourPlan API, not HostConnect
      const isHostConnect = xmlOptions.dtd.name === 'hostConnect_4_06_009.dtd';
      let updatedXmlOptions = xmlOptions;
      
      if (!isHostConnect) {
        // Get the correct DTD version from cache or detect it for TourPlan API
        const correctDtd = await this.getCorrectDtdVersion({ endpoint, axios });
        
        // Update xmlOptions with the correct DTD version
        updatedXmlOptions = {
          ...xmlOptions,
          dtd: {
            ...xmlOptions.dtd,
            name: correctDtd,
          },
        };
      }
      
      let data = Normalizer.stripEnclosingQuotes(
        js2xmlparser.parse('Request', model, updatedXmlOptions),
      );
      // NOTE: Forward slash is NOT an invalid XML character and hence js2xmlparser
      // doesn't escape it, however TourPlan needs it to be escaped as '&#47;'
      // so we need to do it manually after js2xmlparser has done its thing
      // we need to carefull here because we don't want to escape the forward slash
      // when it's inside a tag, so we use a negative lookbehind and lookahead to
      // ensure the forward slash is not inside a tag.
      // In future if more such characters are found, we can use a more sophisticated
      // approach to handle them
      data = data.replace(/(?<!<)\/(?![^<]*>)/g, '&#47;');
      data = data.replace(updatedXmlOptions.dtd.name, `Request SYSTEM "${updatedXmlOptions.dtd.name}"`);
      let replyObj;
      let errorStr;
      // can't use proxy because of the static IP thing, darn
      // if (this.xmlProxyUrl) {
      //   // use pyfilematch xmlproxy
      //   try {
      //     replyObj = R.path(['data'], await axios({
      //       method: 'post',
      //       url: `${this.xmlProxyUrl}/xmlproxy`,
      //       data: {
      //         url: endpoint,
      //         data,
      //         headers: getHeaders({ length: `${data.length}` }),
      //       },
      //     }));
      //   } catch (err) {
      //     console.log('error in calling pyfilematch xmlproxy', err);
      //     errorStr = `error in calling pyfilematch xmlproxy: ${err}`;
      //   }
      // }
      if (!replyObj) {
        // in case of error /xmlproxy, fallback to call tourplan directly
        // and then use pyfilematch xml2json to parse the xml
        const axiospayload = {
          method: 'post',
          url: endpoint,
          data,
          headers: getHeaders({ length: data.length }),
        };
        const reply = R.path(['data'], await axios(axiospayload));
        if (this.xmlProxyUrl) {
          try {
            // using raw axios to avoid logging the large xml request
            ({ data: replyObj } = await axiosRaw({
              method: 'post',
              url: `${this.xmlProxyUrl}/xml2json`,
              data: { xml: reply },
              maxContentLength: Infinity,
              maxBodyLength: Infinity,
            }));
          } catch (err) {
            console.warn('error in calling pyfilematch xml2json', R.pathOr('Nada', ['response', 'data', 'error'], err));
            errorStr = `error in calling pyfilematch xml2json: ${R.pathOr('Nada', ['response', 'data', 'error'], err)}`;
          }
        }
        // in case of error from /xml2json, fallback to fast-xml-parser
        if (!replyObj) {
          replyObj = fastParser.parse(reply);
        }
      }
      const requestType = R.keys(model)[0];
      if (!replyObj) throw new Error(`${requestType} failed: ${errorStr || 'no reply object'}`);
      let error = replyObj.error || R.path(['Reply', 'ErrorReply', 'Error'], replyObj);
      if (error) {
        if (error.includes('DateFrom in the past')) {
          error = '1002 - Date is in the past';
        } else if (error.includes('1052 SCN')) {
          error = '1052 - OptionId not found(Check if it is Internet Enabled)';
        } else if (error.includes('SCN Server overloaded')) {
          error = "2051 - The Tourplan server is unavailable. Please wait a minute and try again. If you keep getting this error, please contact your team's Tourplan administrator or Tourplan support."
        }
        throw new Error(`${requestType} failed: ${error}`);
      }
      return R.path(['Reply'], replyObj);
    };
  }

  async validateToken({
    axios,
    token: {
      endpoint,
      username,
      password,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
    },
  }) {
    try {
      if (hostConnectEndpoint) {
        assert(hostConnectAgentID && hostConnectAgentPassword);
        const model = {
          AgentInfoRequest: {
            AgentID: hostConnectAgentID,
            Password: hostConnectAgentPassword,
          },
        };
        const replyObj = await this.callTourplan({
          model,
          endpoint: hostConnectEndpoint,
          axios,
          xmlOptions: hostConnectXmlOptions,
        });
        assert(R.path(['AgentInfoReply', 'Currency'], replyObj));
        return true;
      }
      const model = {
        AuthenticationRequest: {
          Login: username,
          Password: password,
        },
      };
      const replyObj = await this.callTourplan({
        model, endpoint, axios, xmlOptions: defaultXmlOptions,
      });
      assert(R.path(['AuthenticationReply'], replyObj) === '');
      return true;
    } catch (err) {
      console.error(err.message);
      return false;
    }
  }

  async queryAllotment({
    axios,
    token: {
      endpoint = this.endpoint,
      username = this.username,
      password = this.password,
    },
    payload: {
      dateFormat = 'DD/MM/YYYY',
      startDate,
      endDate,
      keyPath,
      appliesTo: appliesToFilter,
    },
  }) {
    const verbose = R.path(['verbose'], this);
    const cleanLog = inputString =>
      (inputString || '').toString()
        .replaceAll(username, '****').replaceAll(password, '****');
    assert(endpoint);
    assert(startDate);
    assert(endDate);
    assert(keyPath, 'Must provide a supplier/product spec');
    const keyPathArr = keyPath.split('|');
    assert(keyPathArr.length > 1, 'Must provide a supplier id and a product id');
    const supplierId = R.path([-2], keyPathArr);
    const productId = R.path([-1], keyPathArr);
    assert(supplierId);
    assert(productId);
    const model = {
      GetInventoryRequest: {
        SupplierCode: supplierId,
        Date_From: moment(startDate, dateFormat).format('YYYY-MM-DD'),
        Date_To: moment(endDate, dateFormat).format('YYYY-MM-DD'),
        OptionCode: productId,
        // AllocationName: '2021 REBOOT',
        // Unit_Type: 'RM',
        Login: username,
        Password: password,
      },
    };
    
    // Get the correct DTD version for this endpoint
    const correctDtd = await this.getCorrectDtdVersion({ endpoint, axios });
    const xmlOptionsWithCorrectDtd = {
      ...defaultXmlOptions,
      dtd: {
        ...defaultXmlOptions.dtd,
        name: correctDtd,
      },
    };
    
    let data = Normalizer.stripEnclosingQuotes(
      js2xmlparser.parse('Request', model, xmlOptionsWithCorrectDtd),
    );
    // Fix forward slashes like in callTourplan
    data = data.replace(/(?<!<)\/(?![^<]*>)/g, '&#47;');
    data = data.replace(xmlOptionsWithCorrectDtd.dtd.name, `Request SYSTEM "${xmlOptionsWithCorrectDtd.dtd.name}"`);
    if (verbose) console.log('request', cleanLog(data));
    const reply = R.path(['data'], await axios({
      method: 'post',
      url: endpoint,
      data,
      headers: getHeaders({ length: data.length }),
    }));
    if (verbose) console.log('reply', cleanLog(reply));
    const returnObj = await xmlParser.parseStringPromise(reply);
    let allotment = R.pathOr(
      [],
      ['Reply', 'GetInventoryReply', 0, 'Allocation'],
      returnObj,
    );
    // remove empty instances
    allotment = allotment.filter(currentAllotment => Array.isArray(currentAllotment.Split));
    const allotmentResponse = [];
    allotment.forEach(currentAllotment => {
      const appliesToCode = R.path(['AllocationAppliesTo', 0, 'AllocationType', 0], currentAllotment);
      const optionCodes = R.pathOr([], ['AllocationAppliesTo', 0, 'OptionCode'], currentAllotment);
      const supplierCode = R.path(['SupplierCode', 0], currentAllotment);
      const appliesTo = {
        S: 'Supplier',
        O: 'Product',
      }[appliesToCode] || appliesToCode;
      const allotmentName = R.path(['AllocationName', 0], currentAllotment);
      const allotmentDescription = R.path(['AllocationDescription', 0], currentAllotment);
      currentAllotment.Split.forEach(currentSplit => {
        const splitCode = R.path(['Split_Code', 0], currentSplit);
        R.path(['UnitTypeInventory'], currentSplit).forEach(currentUnitType => {
          const unitType = R.path(['Unit_Type', 0], currentUnitType);
          R.path(['PerDayInventory'], currentUnitType).forEach(dayInventory => {
            const date = moment(R.path(['Date', 0], dayInventory), 'YYYY-MM-DD')
              .format(dateFormat);
            allotmentResponse.push({
              name: allotmentName,
              description: allotmentDescription,
              appliesTo,
              splitCode,
              unitType,
              date,
              release: R.path(['Release_Period', 0], dayInventory),
              max: R.path(['Max_Qty', 0], dayInventory),
              booked: R.path(['Bkd_Qty', 0], dayInventory),
              request: {
                Y: true,
                N: false,
              }[R.path(['Request_OK', 0], dayInventory)],
              keyPaths: optionCodes.map(currentProduct => `${supplierCode}|${currentProduct}`),
            });
          });
        });
      });
    });
    return {
      allotment: (() => {
        if (appliesToFilter) {
          return allotmentResponse.filter(
            ({ appliesTo }) => appliesTo === appliesToFilter,
          );
        }
        return allotmentResponse;
      })(),
    };
  }

  async searchProductsForItinerary({
    axios,
    token,
    typeDefsAndQueries,
    payload,
  }) {
    return searchProductsForItinerary({
      axios,
      token,
      typeDefsAndQueries,
      payload,
      callTourplan: this.callTourplan.bind(this),
    });
  }

  // eslint-disable-next-line class-methods-use-this
  async getCreateItineraryFields({
    token: {
      hostConnectAgentID,
      hostConnectAgentPassword,
      hostConnectEndpoint,
    },
    axios,
  }) {
    const model = {
      GetLocationsRequest: {
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
      },
    };
    const GetLocationsReply = await this.cache.getOrExec({
      fnParams: [model],
      fn: () => this.callTourplan({
        model,
        endpoint: hostConnectEndpoint,
        axios,
        xmlOptions: hostConnectXmlOptions,
      }),
      ttl: 60 * 60 * 12, // 2 hours
    });
    let locationCodes = R.pathOr([], ['GetLocationsReply', 'Locations', 'Location'], GetLocationsReply);
    if (!Array.isArray(locationCodes)) locationCodes = [locationCodes];
    const customFields = [{
      id: 'LocationCode',
      label: 'Location Code',
      type: 'extended-option',
      isPerService: true,
      options: locationCodes.map(o => ({ value: o.Code, label: `${o.Name} (${o.Code})` })),
    }];
    return {
      fields: [],
      customFields,
    };
  }

  async searchAvailabilityForItinerary({
    axios,
    token,
    payload,
  }) {
    return searchAvailabilityForItinerary({
      axios,
      token,
      payload,
      callTourplan: this.callTourplan.bind(this),
    });
  }

  async addServiceToItinerary({
    axios,
    token,
    payload,
  }) {
    return addServiceToItinerary({
      axios,
      token,
      payload,
      callTourplan: this.callTourplan.bind(this),
    });
  }

  async searchItineraries({
    axios,
    typeDefsAndQueries,
    token,
    payload,
  }) {
    return searchItineraries({
      axios,
      typeDefsAndQueries,
      token,
      payload,
      callTourplan: this.callTourplan.bind(this),
    });
  }
}

module.exports = BuyerPlugin;
