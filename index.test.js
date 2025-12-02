/* globals describe, it, expect, jest, afterEach */
const { readFile } = require('fs').promises;
const axios = require('axios');
const path = require('path');
const xml2js = require('xml2js');
const R = require('ramda');
const hash = require('object-hash');
const { XMLParser } = require('fast-xml-parser');
const { typeDefs: itineraryProductTypeDefs, query: itineraryProductQuery } = require('./node_modules/ti2/controllers/graphql-schemas/itinerary-product');
const { typeDefs: itineraryBookingTypeDefs, query: itineraryBookingQuery } = require('./node_modules/ti2/controllers/graphql-schemas/itinerary-booking');
const { CUSTOM_RATE_ID_NAME } = require('./utils');
const {
  getRatesObjectArray,
  getImmediateLastDateRange,
} = require('./availability/itinerary-availability-helper');

const {
  convertToAdult,
  validateDateRanges,
  calculateEndDate,
} = require('./availability/itinerary-availability-utils');

const xmlParser = new xml2js.Parser();

const Plugin = require('./index');

const typeDefsAndQueries = {
  itineraryProductTypeDefs,
  itineraryProductQuery,
  itineraryBookingTypeDefs,
  itineraryBookingQuery,
};

jest.mock('axios');
const actualAxios = jest.requireActual('axios');

// Extend the existing getFixture function to handle callTourplan mocks
const mockCallTourplan = jest.fn().mockImplementation(async ({ model, endpoint }) => {
  // Create a mock request object similar to what axios would receive
  const requestType = Object.keys(model)[0]; // Gets 'OptionInfoRequest'

  const mockRequestObject = {
    method: 'post',
    url: endpoint,
    data: `<${requestType}>${JSON.stringify(model[requestType])}</${requestType}>`,
    headers: {},
  };

  // Use your existing fixture system
  const fixtureResponse = await getFixture(mockRequestObject);

  // Parse the XML response to match callTourplan's return format
  const fastParser = new XMLParser();
  const parsed = fastParser.parse(fixtureResponse.data);

  return R.path(['Reply'], parsed);
});

const getFixture = async requestObject => {
  // console.log('requestObject: ', requestObject);
  // Extract request name using regex
  const requestName = requestObject.data && typeof requestObject.data === 'string' && R.pathOr('UnknownRequest', [1], requestObject.data.match(/<(\w+Request)>/))
    ? R.pathOr('UnknownRequest', [1], requestObject.data.match(/<(\w+Request)>/))
    : 'UnknownRequest';
  // Hash only the data field to ensure stable fixture names regardless of endpoint/headers changes
  const requestHash = hash(requestObject.data || requestObject);
  // console.log('requestHash: ', requestHash);
  const file = path.resolve(__dirname, `./__fixtures__/${requestName}_${requestHash}.txt`);
  try {
    const fixture = (
      await readFile(file)
    ).toString();
    return { data: fixture };
  } catch (err) {
    console.warn(`could not find ${file} for ${JSON.stringify(requestObject)}`);
    return actualAxios(requestObject);
  }
};

const app = new Plugin();
app.callTourplan = mockCallTourplan;

describe('search tests', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });
  const token = {
    endpoint: process.env.ti2_tourplan_endpoint,
    username: process.env.ti2_tourplan_username,
    password: process.env.ti2_tourplan_password,
    hostConnectEndpoint: 'https://test_hostConnectEndpoint.com',
    hostConnectAgentID: 'test_hostConnectAgentID',
    hostConnectAgentPassword: 'test_hostConnectAgentPassword',
    seeAvailabilityRateInSupplierCurrency: 'Y',
  };
  const dateFormat = 'DD/MM/YYYY';
  describe('tooling', () => {
    describe('validateToken', () => {
      it('valid token', async () => {
        axios.mockImplementation(getFixture);
        const retVal = await app.validateToken({
          axios,
          token,
        });
        expect(retVal).toBeTruthy();
      });
      it('invalid token', async () => {
        axios.mockImplementation(getFixture);
        const retVal = await app.validateToken({
          axios,
          token: { ...token, username: 'somerandom', hostConnectAgentPassword: 'somerandom' },
        });
        expect(retVal).toBeFalsy();
      });
    });
    describe('template tests', () => {
      let template;
      it('get the template', async () => {
        template = await app.tokenTemplate();
        const rules = Object.keys(template);
        expect(rules).toContain('endpoint');
        expect(rules).toContain('password');
        expect(rules).toContain('username');
      });
      it('username', () => {
        const username = template.username.regExp;
        expect(username.test('')).toBeFalsy();
        expect(username.test('someuser')).toBeTruthy();
      });
      it('endpoint', () => {
        const endpoint = template.endpoint.regExp;
        expect(endpoint.test('something')).toBeFalsy();
        expect(endpoint.test('https://www.google.com')).toBeTruthy();
      });
      it('password', () => {
        const password = template.password.regExp;
        expect(password.test('')).toBeFalsy();
        expect(password.test('somepassword')).toBeTruthy();
      });
    });
    describe('DTD version detection', () => {
      it('should detect and use correct DTD version from error response', async () => {
        // Mock cache to test the detection logic
        const mockCache = {
          getOrExec: async ({ fn, fnParams }) => {
            // Execute the function directly without caching for testing
            return await fn(...fnParams);
          }
        };
        
        // Create a new instance with mock cache
        const appWithMockCache = new Plugin(token);
        appWithMockCache.cache = mockCache;
        
        // Mock axios to return 200 with DTD error (real-world scenario)
        axios.mockImplementationOnce(() => {
          return {
            status: 200,
            data: `<?xml version="1.0" encoding="utf-8"?>
<Error>
  <Details>Exception: This DTD version tourConnect_4_00_000.dtd is not supported. Please use the latest DTD version: tourConnect_5_05_000.dtd</Details>
</Error>`
          };
        });
        
        // Test the DTD detection
        const detectedDtd = await appWithMockCache.getCorrectDtdVersion({
          endpoint: token.endpoint,
          axios
        });
        
        expect(detectedDtd).toBe('tourConnect_5_05_000.dtd');
      });
      
      it('should use default DTD when no error is returned', async () => {
        // Mock cache to test the detection logic
        const mockCache = {
          getOrExec: async ({ fn, fnParams }) => {
            // Execute the function directly without caching for testing
            return await fn(...fnParams);
          }
        };
        
        // Create a new instance with mock cache
        const appWithMockCache = new Plugin(token);
        appWithMockCache.cache = mockCache;
        
        // Mock axios to return successful response (no DTD error)
        axios.mockImplementationOnce(() => {
          return {
            data: `<?xml version="1.0" encoding="utf-8"?>
<Reply>
  <AuthenticationReply></AuthenticationReply>
</Reply>`
          };
        });
        
        // Test the DTD detection
        const detectedDtd = await appWithMockCache.getCorrectDtdVersion({
          endpoint: token.endpoint,
          axios
        });
        
        expect(detectedDtd).toBe('tourConnect_4_00_000.dtd');
      });
      
      it('should detect DTD version from 200 response with error XML', async () => {
        // Mock cache to test the detection logic
        const mockCache = {
          getOrExec: async ({ fn, fnParams }) => {
            // Execute the function directly without caching for testing
            return await fn(...fnParams);
          }
        };
        
        // Create a new instance with mock cache
        const appWithMockCache = new Plugin(token);
        appWithMockCache.cache = mockCache;
        
        // Mock axios to return 200 with DTD error in XML (like production)
        axios.mockImplementationOnce(() => {
          return {
            status: 200,
            data: `<?xml version="1.0" encoding="utf-8"?>
<Error>
  <Details>Exception: This DTD version tourConnect_4_00_000.dtd is not supported. Please use the latest DTD version: tourConnect_5_05_000.dtd</Details>
</Error>`
          };
        });
        
        // Test the DTD detection
        const detectedDtd = await appWithMockCache.getCorrectDtdVersion({
          endpoint: token.endpoint,
          axios
        });
        
        expect(detectedDtd).toBe('tourConnect_5_05_000.dtd');
      });
      
      it('should handle DTD version when axios throws error', async () => {
        // Mock cache to test the detection logic
        const mockCache = {
          getOrExec: async ({ fn, fnParams }) => {
            // Execute the function directly without caching for testing
            return await fn(...fnParams);
          }
        };
        
        // Create a new instance with mock cache
        const appWithMockCache = new Plugin(token);
        appWithMockCache.cache = mockCache;
        
        // Mock axios to throw error (non-2xx status)
        axios.mockImplementationOnce(() => {
          const error = new Error('Request failed with status code 400');
          error.response = {
            status: 400,
            data: `<?xml version="1.0" encoding="utf-8"?>
<Error>
  <Details>Exception: This DTD version tourConnect_4_00_000.dtd is not supported. Please use the latest DTD version: tourConnect_5_05_000.dtd</Details>
</Error>`
          };
          throw error;
        });
        
        // Test the DTD detection - should detect DTD version from error response
        const detectedDtd = await appWithMockCache.getCorrectDtdVersion({
          endpoint: token.endpoint,
          axios
        });
        
        // Should detect the DTD version from the error response
        expect(detectedDtd).toBe('tourConnect_5_05_000.dtd');
      });
    });
  });
  it('read allotment empty', async () => {
    const request = axios.mockImplementation(getFixture);
    const retVal = await app.queryAllotment({
      axios,
      token,
      payload: {
        dateFormat,
        startDate: '01/08/2022',
        endDate: '15/08/2022',
        keyPath: 'MAGLUX|SYDACMAGLUXDELXRO',
      },
    });
    expect(Array.isArray(retVal.allotment)).toBeTruthy();
    expect(retVal.allotment.length).toBe(0);
    // Find the actual GetInventoryRequest call (not the DTD detection call)
    const inventoryCall = request.mock.calls.find(call => 
      call[0].data && call[0].data.includes('GetInventoryRequest')
    );
    let sentPayload = await xmlParser.parseStringPromise(
      inventoryCall[0].data,
    );
    sentPayload = R.path(['Request', 'GetInventoryRequest', 0], sentPayload);
    expect(sentPayload.SupplierCode[0]).toBe('MAGLUX');
    expect(sentPayload.OptionCode[0]).toBe('SYDACMAGLUXDELXRO');
    expect(sentPayload.Date_From[0]).toBe('2022-08-01');
    expect(sentPayload.Date_To[0]).toBe('2022-08-15');
  });
  it('read allotment not empty', async () => {
    const request = axios.mockImplementation(getFixture);
    const retVal = await app.queryAllotment({
      axios,
      token,
      payload: {
        dateFormat,
        startDate: '02/09/2021',
        endDate: '02/10/2021',
        keyPath: 'MAGLUX|QLDACMAGLUXDELSUI',
      },
    });
    expect(Array.isArray(retVal.allotment)).toBeTruthy();
    expect(retVal.allotment).toContainEqual({
      name: 'FREESALE',
      description: '',
      appliesTo: 'Product',
      splitCode: 'GENERAL',
      unitType: 'RM',
      date: '08/09/2021',
      release: '14',
      max: '3',
      booked: '0',
      request: true,
      keyPaths: ['MAGLUX|QLDACMAGLUXDELSUI'],
    });
    expect(retVal).toMatchSnapshot();
    // Find the actual GetInventoryRequest call (not the DTD detection call)
    const inventoryCall = request.mock.calls.find(call => 
      call[0].data && call[0].data.includes('GetInventoryRequest')
    );
    let sentPayload = await xmlParser.parseStringPromise(
      inventoryCall[0].data,
    );
    sentPayload = R.path(['Request', 'GetInventoryRequest', 0], sentPayload);
    expect(sentPayload.SupplierCode[0]).toBe('MAGLUX');
    expect(sentPayload.OptionCode[0]).toBe('QLDACMAGLUXDELSUI');
    expect(sentPayload.Date_From[0]).toBe('2021-09-02');
    expect(sentPayload.Date_To[0]).toBe('2021-10-02');
  });
  it('read allotment that applies to more products', async () => {
    const request = axios.mockImplementation(getFixture);
    const retVal = await app.queryAllotment({
      axios,
      token,
      payload: {
        dateFormat,
        startDate: '16/05/2022',
        endDate: '15/06/2022',
        keyPath: 'XXYYIN|SINACXXYYIN2SDXBF',
      },
    });
    expect(Array.isArray(retVal.allotment)).toBeTruthy();
    // there is no booked when multiple keyPaths are returned
    expect(retVal.allotment).toContainEqual({
      name: 'DLX_XXXXX',
      description: 'Deluxe Room',
      appliesTo: 'Product',
      splitCode: 'ALLAGENT',
      unitType: 'RO',
      date: '15/06/2022',
      release: '7',
      max: '0',
      request: false,
      keyPaths: ['XXYYIN|SINACXXYYINDLXFBF', 'XXYYIN|SINACXXYYIN2SDXBF'],
    });
    expect(retVal).toMatchSnapshot();
    // Find the actual GetInventoryRequest call (not the DTD detection call)
    const inventoryCall = request.mock.calls.find(call => 
      call[0].data && call[0].data.includes('GetInventoryRequest')
    );
    let sentPayload = await xmlParser.parseStringPromise(
      inventoryCall[0].data,
    );
    sentPayload = R.path(['Request', 'GetInventoryRequest', 0], sentPayload);
    expect(sentPayload.SupplierCode[0]).toBe('XXYYIN');
    expect(sentPayload.OptionCode[0]).toBe('SINACXXYYIN2SDXBF');
    expect(sentPayload.Date_From[0]).toBe('2022-05-16');
    expect(sentPayload.Date_To[0]).toBe('2022-06-15');
  });
  it('searchProductsForItinerary', async () => {
    axios.mockImplementation(getFixture);
    const retVal = await app.searchProductsForItinerary({
      axios,
      token,
      typeDefsAndQueries,
      payload: {
        optionId: 'LONTRDAVIDSHDWBVD',
      },
    });
    expect(retVal).toMatchSnapshot();
  });

  describe('availability tests', () => {
    it('searchAvailabilityForItinerary - not bookable', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'LONTRDAVIDSHDWBVC',
          startDate: '2025-04-01',
          chargeUnitQuantity: 1,
          paxConfigs: [{ roomType: 'DB', adults: 2 }],
        },
      });
      expect(retVal.bookable).toBeFalsy();
      expect(retVal.rates.length).toBe(0);
    });

    it('searchAvailabilityForItinerary - bookable - static with inventory', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'AKLACAKLSOFDYNAMC',
          startDate: '2025-04-01',
          chargeUnitQuantity: 2,
          paxConfigs: [{ roomType: 'DB', adults: 1 }],
        },
      });
      expect(retVal).toMatchSnapshot();
      expect(retVal.bookable).toBeTruthy();
      expect(retVal.rates.length).toBeGreaterThan(0);
      expect(retVal.type).toBe('inventory');
    });

    // Skip this test because we aren't using A check anymore
    it.skip('searchAvailabilityForItinerary - bookable - on request', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'FWMACINVCASFBSB',
          startDate: '2025-04-01',
          chargeUnitQuantity: 1,
          paxConfigs: [{ roomType: 'DB', adults: 1 }],
        },
      });
      expect(retVal).toMatchSnapshot();
      expect(retVal.bookable).toBeTruthy();
      expect(retVal.type).toBe('on request');
    });

    it('searchItineraries', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchItineraries({
        axios,
        token,
        typeDefsAndQueries,
        payload: {
          bookingId: '316559',
        },
      });

      // Verify the bookings
      expect(retVal).toMatchSnapshot();

      expect(retVal.bookings.length).toBeGreaterThan(0);
      expect(retVal.bookings[0]).toHaveProperty('agentRef');
      expect(retVal.bookings[0].agentRef).toBe('2356674/1');
      expect(retVal.bookings[0]).toHaveProperty('bookingId');
      expect(retVal.bookings[0].bookingId).toBe('316559');
      expect(retVal.bookings[0]).toHaveProperty('ref');
      expect(retVal.bookings[0].ref).toBe('ALFI393706');
      expect(retVal.bookings[0]).toHaveProperty('bookingStatus');
      expect(retVal.bookings[0].bookingStatus).toBe('Quotation');
      expect(retVal.bookings[0]).toHaveProperty('canEdit');
      expect(retVal.bookings[0].canEdit).toBe(true);
      expect(retVal.bookings[0]).toHaveProperty('currency');
      expect(retVal.bookings[0].currency).toBe('GBP');
      expect(retVal.bookings[0]).toHaveProperty('enteredDate');
      expect(retVal.bookings[0].enteredDate).toBe('2024-09-12');
      expect(retVal.bookings[0]).toHaveProperty('name');
      expect(retVal.bookings[0].name).toBe('2356674/1 Sean Conta');
      expect(retVal.bookings[0]).toHaveProperty('currency');
      expect(retVal.bookings[0].currency).toBe('GBP');
      expect(retVal.bookings[0]).toHaveProperty('enteredDate');
      expect(retVal.bookings[0].enteredDate).toBe('2024-09-12');
      expect(retVal.bookings[0]).toHaveProperty('name');
      expect(retVal.bookings[0].name).toBe('2356674/1 Sean Conta');
      expect(retVal.bookings[0]).toHaveProperty('serviceLines');
      expect(retVal.bookings[0].serviceLines.length).toBe(1);
      expect(retVal.bookings[0].serviceLines[0]).toHaveProperty('serviceLineId');
      expect(retVal.bookings[0].serviceLines[0].serviceLineId).toBe('745684');
      expect(retVal.bookings[0].serviceLines[0]).toHaveProperty('optionId');
      expect(retVal.bookings[0].serviceLines[0].optionId).toBe('LONHOSANLONBFBDLX');
      expect(retVal.bookings[0].serviceLines[0]).toHaveProperty('optionName');
      expect(retVal.bookings[0].serviceLines[0].optionName).toBe('Bed and Full Buffet Breakfast');
      expect(retVal.bookings[0].serviceLines[0]).toHaveProperty('paxConfigs');
      expect(retVal.bookings[0].serviceLines[0].paxConfigs.length).toBe(1);
      expect(retVal.bookings[0].serviceLines[0].paxConfigs[0]).toHaveProperty('roomType');
      expect(retVal.bookings[0].serviceLines[0].paxConfigs[0].roomType).toBe('Double');
      expect(retVal.bookings[0].serviceLines[0]).toHaveProperty('paxList');
      expect(retVal.bookings[0].serviceLines[0].paxList.length).toBe(1);
      expect(retVal.bookings[0].serviceLines[0].paxList[0]).toHaveProperty('firstName');
      expect(retVal.bookings[0].serviceLines[0].paxList[0].firstName).toBe('Sean');
      expect(retVal.bookings[0].serviceLines[0].paxList[0]).toHaveProperty('lastName');
      expect(retVal.bookings[0].serviceLines[0].paxList[0].lastName).toBe('Conta');
      expect(retVal.bookings[0].serviceLines[0]).toHaveProperty('quantity');
      expect(retVal.bookings[0].serviceLines[0].quantity).toBe(4);
      expect(retVal.bookings[0].serviceLines[0]).toHaveProperty('status');
      expect(retVal.bookings[0].serviceLines[0].status).toBe('OK');
      expect(retVal.bookings[0].serviceLines[0]).toHaveProperty('supplierId');
      expect(retVal.bookings[0].serviceLines[0].supplierId).toBe('SANLON');
      expect(retVal.bookings[0].serviceLines[0]).toHaveProperty('supplierName');
      expect(retVal.bookings[0].serviceLines[0].supplierName).toBe('Sanderson');
    });

    // Test case to check cancel policies at option level (top level).
    // There are cancellation policies under external rate details too, those
    // are tested in the external pudo info test case.
    it('should handle cancel policies correctly', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'TESTTOPLEVELCANCELPOLICIES',
          startDate: '2025-04-01',
          chargeUnitQuantity: 1,
          paxConfigs: [{ roomType: 'DB', adults: 2 }],
        },
      });
      expect(retVal).toMatchSnapshot();
      expect(retVal.bookable).toBeTruthy();
      expect(retVal.rates.length).toBeGreaterThan(0);

      const firstRate = retVal.rates[0];
      // Test cancel policies from external rate details
      expect(firstRate).toHaveProperty('cancelPolicies');
      expect(Array.isArray(firstRate.cancelPolicies)).toBeTruthy();
      expect(firstRate.cancelPolicies.length).toBe(3);

      // Test cancel policies structure
      if (firstRate.cancelPolicies && firstRate.cancelPolicies.length > 0) {
        const policy = firstRate.cancelPolicies[0];
        expect(policy).toHaveProperty('penaltyDescription');
        expect(policy).toHaveProperty('deadlineDateTime');
        expect(policy).toHaveProperty('cancelNum');
        expect(policy).toHaveProperty('cancelTimeUnit');
        expect(policy).toHaveProperty('inEffect');
        expect(policy).toHaveProperty('cancelFee');
        expect(policy).toHaveProperty('agentPrice');

        // Verify cancel policy details
        expect(policy.penaltyDescription).toBe('72 hours prior to arrival - 10% cancellation fee');
        expect(policy.deadlineDateTime).toBe('2025-03-29T11:00:00Z');
        expect(policy.cancelNum).toBe(72);
        expect(policy.cancelTimeUnit).toBe('Hour');
        expect(policy.inEffect).toBe(true);
        expect(policy.cancelFee).toBe(97876);
        expect(policy.agentPrice).toBe(97876);
      }
      if (firstRate.cancelPolicies && firstRate.cancelPolicies.length > 0) {
        const policy = firstRate.cancelPolicies[1];
        expect(policy).toHaveProperty('penaltyDescription');
        expect(policy).toHaveProperty('deadlineDateTime');
        expect(policy).toHaveProperty('cancelNum');
        expect(policy).toHaveProperty('cancelTimeUnit');
        expect(policy).toHaveProperty('inEffect');
        expect(policy).toHaveProperty('cancelFee');
        expect(policy).toHaveProperty('agentPrice');

        // Verify cancel policy details
        expect(policy.penaltyDescription).toBe('24 hours prior to arrival - 50% cancellation fee');
        expect(policy.deadlineDateTime).toBe('2025-03-31T11:00:00Z');
        expect(policy.cancelNum).toBe(24);
        expect(policy.cancelTimeUnit).toBe('Hour');
        expect(policy.inEffect).toBe(true);
        expect(policy.cancelFee).toBe(54900);
        expect(policy.agentPrice).toBe(54900);
      }
      if (firstRate.cancelPolicies && firstRate.cancelPolicies.length > 0) {
        const policy = firstRate.cancelPolicies[2];
        expect(policy).toHaveProperty('penaltyDescription');
        expect(policy).toHaveProperty('deadlineDateTime');
        expect(policy).toHaveProperty('cancelNum');
        expect(policy).toHaveProperty('cancelTimeUnit');
        expect(policy).toHaveProperty('inEffect');
        expect(policy).toHaveProperty('cancelFee');
        expect(policy).toHaveProperty('agentPrice');

        // Verify cancel policy details
        expect(policy.penaltyDescription).toBe('No show or same day cancellation - 100% cancellation fee');
        expect(policy.deadlineDateTime).toBe('2025-04-01T11:00:00Z');
        expect(policy.cancelNum).toBe(0);
        expect(policy.cancelTimeUnit).toBe('Hour');
        expect(policy.inEffect).toBe(true);
        expect(policy.cancelFee).toBe(109800);
        expect(policy.agentPrice).toBe(109800);
      }
    });

    // Test case to check single cancel policy at option level
    it('should handle single cancel policy correctly', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'TESTSINGLECANCELPOLICY',
          startDate: '2025-04-01',
          chargeUnitQuantity: 1,
          paxConfigs: [{ roomType: 'DB', adults: 2 }],
        },
      });
      expect(retVal).toMatchSnapshot();
      expect(retVal.bookable).toBeTruthy();
      expect(retVal.rates.length).toBeGreaterThan(0);

      const firstRate = retVal.rates[0];
      // Test single cancel policy from option level
      expect(firstRate).toHaveProperty('cancelPolicies');
      expect(Array.isArray(firstRate.cancelPolicies)).toBeTruthy();
      expect(firstRate.cancelPolicies.length).toBe(1);

      // Test single cancel policy structure
      if (firstRate.cancelPolicies && firstRate.cancelPolicies.length > 0) {
        const policy = firstRate.cancelPolicies[0];
        expect(policy).toHaveProperty('penaltyDescription');
        expect(policy).toHaveProperty('deadlineDateTime');
        expect(policy).toHaveProperty('cancelNum');
        expect(policy).toHaveProperty('cancelTimeUnit');
        expect(policy).toHaveProperty('inEffect');
        expect(policy).toHaveProperty('cancelFee');
        expect(policy).toHaveProperty('agentPrice');

        // Verify single cancel policy details
        expect(policy.penaltyDescription).toBe('48 hours prior to arrival - 25% cancellation fee');
        expect(policy.deadlineDateTime).toBe('2025-03-30T11:00:00Z');
        expect(policy.cancelNum).toBe(48);
        expect(policy.cancelTimeUnit).toBe('Hour');
        expect(policy.inEffect).toBe(true);
        expect(policy.cancelFee).toBe(27450);
        expect(policy.agentPrice).toBe(109800);
      }
    });

    // Test case to check additional info like total price, currency, agent price,
    // start times, etc. Also, external rates - pickup, dropoff, cancel policies etc.
    it('should handle external pickup, dropoff, and start times correctly', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'TESTEXTPICKUPDROPOFF',
          startDate: '2025-04-01',
          chargeUnitQuantity: 1,
          paxConfigs: [{ roomType: 'DB', adults: 2 }],
        },
      });
      expect(retVal).toMatchSnapshot();
      expect(retVal.bookable).toBeTruthy();
      expect(retVal.rates.length).toBeGreaterThan(0);

      const firstRate = retVal.rates[0];

      expect(firstRate).toHaveProperty('rateId');
      expect(firstRate.rateId).toBe('$USDtest123456789,4,DOUB,EXT TEST RATE');

      // Test currency
      expect(firstRate).toHaveProperty('currency');
      expect(firstRate.currency).toBe('USD');

      // Test totalPrice
      expect(firstRate).toHaveProperty('totalPrice');
      expect(firstRate.totalPrice).toBe(150000);

      // Test agentPrice
      expect(firstRate).toHaveProperty('agentPrice');
      expect(firstRate.agentPrice).toBe(115450);

      // Test currencyPrecision
      expect(firstRate).toHaveProperty('currencyPrecision');
      expect(firstRate.currencyPrecision).toBe(2);

      // Test CancelHours
      expect(firstRate).toHaveProperty('cancelHours');
      expect(firstRate.cancelHours).toBe(24);

      // Test external rate text
      expect(firstRate).toHaveProperty('externalRateText');
      expect(typeof firstRate.externalRateText).toBe('string');
      expect(firstRate.externalRateText).toContain('City Tour with Pickup and Dropoff (Full Day Tour)');

      // Test cancel policies from external rate details
      expect(firstRate).toHaveProperty('cancelPolicies');
      expect(Array.isArray(firstRate.cancelPolicies)).toBeTruthy();
      expect(firstRate.cancelPolicies.length).toBe(3);

      // Verify first external cancel policy
      const firstPolicy = firstRate.cancelPolicies[0];
      expect(firstPolicy).toHaveProperty('penaltyDescription');
      expect(firstPolicy.penaltyDescription).toBe('No refund for cancellations within 2 hours of tour start');

      // Verify second external cancel policy
      const secondPolicy = firstRate.cancelPolicies[1];
      expect(secondPolicy).toHaveProperty('penaltyDescription');
      expect(secondPolicy).toHaveProperty('cancelNum');
      expect(secondPolicy).toHaveProperty('cancelTimeUnit');
      expect(secondPolicy.penaltyDescription).toBe('50% refund for cancellations 2-24 hours before tour');
      expect(secondPolicy.cancelNum).toBe(2);
      expect(secondPolicy.cancelTimeUnit).toBe('Hour');

      // Verify third external cancel policy
      const thirdPolicy = firstRate.cancelPolicies[2];
      expect(thirdPolicy).toHaveProperty('penaltyDescription');
      expect(thirdPolicy).toHaveProperty('cancelNum');
      expect(thirdPolicy).toHaveProperty('cancelTimeUnit');
      expect(thirdPolicy.penaltyDescription).toBe('Full refund for cancellations more than 24 hours before tour');
      expect(thirdPolicy.cancelNum).toBe(24);
      expect(thirdPolicy.cancelTimeUnit).toBe('Hour');

      // Test external start times
      expect(firstRate).toHaveProperty('startTimes');
      expect(Array.isArray(firstRate.startTimes)).toBeTruthy();
      expect(firstRate.startTimes.length).toBe(4);

      // Verify start times are in correct format (HH:MM)
      firstRate.startTimes.forEach(startTime => {
        expect(startTime).toHaveProperty('startTime');
        expect(typeof startTime.startTime).toBe('string');
        expect(startTime.startTime).toMatch(/^\d{2}:\d{2}$/); // HH:MM format
      });

      // Verify start times conversion from ISO to HH:MM format
      const startTimeValues = firstRate.startTimes.map(st => st.startTime);
      expect(startTimeValues).toContain('08:00');
      expect(startTimeValues).toContain('09:00');
      expect(startTimeValues).toContain('10:00');
      expect(startTimeValues).toContain('11:00');

      // Test pickup details
      expect(firstRate).toHaveProperty('puInfoList');
      expect(Array.isArray(firstRate.puInfoList)).toBeTruthy();
      expect(firstRate.puInfoList.length).toBe(3);

      firstRate.puInfoList.forEach(pickup => {
        expect(pickup).toHaveProperty('pointName');
        expect(pickup).toHaveProperty('minutesPrior');
        expect(pickup).toHaveProperty('address');
        expect(pickup).toHaveProperty('pointInfo');
        expect(typeof pickup.pointName).toBe('string');
        expect(typeof pickup.minutesPrior).toBe('number');
        expect(typeof pickup.address).toBe('string');
        expect(typeof pickup.pointInfo).toBe('string');
      });

      // Verify specific pickup data (Central Hotel)
      const centralHotelPickup = firstRate.puInfoList.find(p => p.pointName === 'Central Hotel');
      expect(centralHotelPickup).toBeDefined();
      expect(centralHotelPickup.minutesPrior).toBe(30);
      expect(centralHotelPickup.address).toBe('123 Main Street, Downtown');
      expect(centralHotelPickup.pointInfo).toBe('Meet at hotel lobby entrance');

      // Verify other pickup data (Airport Terminal)
      const argusHotelPickup = firstRate.puInfoList.find(p => p.pointName === 'Airport Terminal');
      expect(argusHotelPickup).toBeDefined();
      expect(argusHotelPickup.minutesPrior).toBe(45);
      expect(argusHotelPickup.address).toBe('Airport Terminal 1, International Arrivals');
      expect(argusHotelPickup.pointInfo).toBe('Look for guide with company sign');

      // Verify other pickup data (Train Station)
      const trainStationPickup = firstRate.puInfoList.find(p => p.pointName === 'Train Station');
      expect(trainStationPickup).toBeDefined();
      expect(trainStationPickup.minutesPrior).toBe(20);
      expect(trainStationPickup.address).toBe('Central Station, Platform 3');
      expect(trainStationPickup.pointInfo).toBe('Meet at information desk');

      // Test dropoff details
      expect(firstRate).toHaveProperty('doInfoList');
      expect(Array.isArray(firstRate.doInfoList)).toBeTruthy();
      expect(firstRate.doInfoList.length).toBe(2);

      firstRate.doInfoList.forEach(dropoff => {
        expect(dropoff).toHaveProperty('pointName');
        expect(dropoff).toHaveProperty('minutesPrior');
        expect(dropoff).toHaveProperty('address');
        expect(dropoff).toHaveProperty('pointInfo');
        expect(typeof dropoff.pointName).toBe('string');
        expect(typeof dropoff.minutesPrior).toBe('number');
        expect(typeof dropoff.address).toBe('string');
        expect(typeof dropoff.pointInfo).toBe('string');
      });

      // Verify specific dropoff data (Tourist Center)
      const touristCenterDropoff = firstRate.doInfoList.find(d => d.pointName === 'Tourist Center');
      expect(touristCenterDropoff).toBeDefined();
      expect(touristCenterDropoff.minutesPrior).toBe(15);
      expect(touristCenterDropoff.address).toBe('Tourist Information Center, City Square');
      expect(touristCenterDropoff.pointInfo).toBe('Drop at main entrance');

      // Verify other dropoff data (Hotel District)
      const hotelDistrictDropoff = firstRate.doInfoList.find(d => d.pointName === 'Hotel District');
      expect(hotelDistrictDropoff).toBeDefined();
      expect(hotelDistrictDropoff.minutesPrior).toBe(10);
      expect(hotelDistrictDropoff.address).toBe('456 Hotel Boulevard, Luxury District');
      expect(hotelDistrictDropoff.pointInfo).toBe('Drop at hotel entrance');

      // Test AdditionalDetails
      expect(firstRate).toHaveProperty('additionalDetails');
      expect(Array.isArray(firstRate.additionalDetails)).toBeTruthy();
      expect(firstRate.additionalDetails.length).toBe(3);

      // Verify specific additional details
      const fullDescription = firstRate.additionalDetails.find(d => d.detailName === 'FullDescription');
      expect(fullDescription).toBeDefined();
      expect(fullDescription.detailDescription).toContain('Experience the best of our city');

      const tourDuration = firstRate.additionalDetails.find(d => d.detailName === 'TourDuration');
      expect(tourDuration).toBeDefined();
      expect(tourDuration.detailDescription).toBe('8 hours');

      const itinerary = firstRate.additionalDetails.find(d => d.detailName === 'Itinerary');
      expect(itinerary).toBeDefined();
      expect(itinerary.detailDescription).toContain('Your tour begins with pickup');
    });

    // Test case specifically for multiple cancel policies under external rates
    it('should handle multiple cancel policies under external rates correctly', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'TESTMULTIPLEEXTERNALCANCEL',
          startDate: '2025-04-01',
          chargeUnitQuantity: 1,
          paxConfigs: [{ roomType: 'DB', adults: 2 }],
        },
      });
      expect(retVal).toMatchSnapshot();
      expect(retVal.bookable).toBeTruthy();
      expect(retVal.rates.length).toBeGreaterThan(0);

      const firstRate = retVal.rates[0];

      // Test that external rates have cancel policies
      expect(firstRate).toHaveProperty('cancelPolicies');
      expect(Array.isArray(firstRate.cancelPolicies)).toBeTruthy();
      expect(firstRate.cancelPolicies.length).toBeGreaterThan(0);

      // Test structure of each cancel policy - only the values that are actually returned
      firstRate.cancelPolicies.forEach(policy => {
        expect(policy).toHaveProperty('penaltyDescription');
        expect(policy).toHaveProperty('cancelNum');
        expect(policy).toHaveProperty('cancelTimeUnit');
        expect(typeof policy.penaltyDescription).toBe('string');
        expect(typeof policy.cancelNum).toBe('number');
        expect(typeof policy.cancelTimeUnit).toBe('string');
      });

      // Test specific external cancel policies if they exist
      if (firstRate.cancelPolicies.length >= 3) {
        // Test first external cancel policy
        const firstPolicy = firstRate.cancelPolicies[0];
        expect(firstPolicy.penaltyDescription).toContain('Full refund for cancellations more than 24 hours before tour');
        expect(firstPolicy.cancelNum).toBe(24);
        expect(firstPolicy.cancelTimeUnit).toBe('Hour');

        // Test middle external cancel policy
        const middlePolicy = firstRate.cancelPolicies[1];
        expect(middlePolicy.penaltyDescription).toContain('50% refund for cancellations 2-24 hours before tour');
        expect(middlePolicy.cancelNum).toBe(2);
        expect(middlePolicy.cancelTimeUnit).toBe('Hour');

        // Test last external cancel policy
        const lastPolicy = firstRate.cancelPolicies[firstRate.cancelPolicies.length - 1];
        expect(lastPolicy.penaltyDescription).toContain('No refund for cancellations within 2 hours of tour start');
        expect(lastPolicy.cancelNum).toBe(0);
        expect(lastPolicy.cancelTimeUnit).toBe('Hour');
      }
    });

    // Test case for single cancel policy under external rates
    it('should handle single cancel policy under external rates correctly', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'TESTSINGLEEXTERNALCANCEL',
          startDate: '2025-04-01',
          chargeUnitQuantity: 1,
          paxConfigs: [{ roomType: 'DB', adults: 2 }],
        },
      });
      expect(retVal).toMatchSnapshot();
      expect(retVal.bookable).toBeTruthy();
      expect(retVal.rates.length).toBeGreaterThan(0);

      const firstRate = retVal.rates[0];

      // Test that external rates have cancel policies
      expect(firstRate).toHaveProperty('cancelPolicies');
      expect(Array.isArray(firstRate.cancelPolicies)).toBeTruthy();
      expect(firstRate.cancelPolicies.length).toBe(1);

      // Test structure of single cancel policy - only the values that are actually returned
      const singlePolicy = firstRate.cancelPolicies[0];
      expect(singlePolicy).toHaveProperty('penaltyDescription');
      expect(singlePolicy).toHaveProperty('cancelNum');
      expect(singlePolicy).toHaveProperty('cancelTimeUnit');
      expect(typeof singlePolicy.penaltyDescription).toBe('string');
      expect(typeof singlePolicy.cancelNum).toBe('number');
      expect(typeof singlePolicy.cancelTimeUnit).toBe('string');

      // Test specific single external cancel policy
      expect(singlePolicy.penaltyDescription).toContain('No refund for cancellations within 2 hours of tour start');
      expect(singlePolicy.cancelNum).toBe(20);
      expect(singlePolicy.cancelTimeUnit).toBe('Hour');
    });

    it('should modify paxconfigs and return availability', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'TESTMODIFIEDPAXCONFIGS',
          startDate: '2025-04-01',
          chargeUnitQuantity: 1,
          paxConfigs: [{ roomType: 'DB', adults: 6, children: 3, infants: 1 }],
        },
      });
      expect(retVal).toMatchSnapshot();
      expect(retVal.bookable).toBeTruthy();
      expect(retVal.type).toBe('inventory');

      const firstRate = retVal.rates[0];
      expect(firstRate.currency).toBe('ZAR');
      expect(firstRate.totalPrice).toBe(1083800);
      expect(firstRate.agentPrice).toBe(1083800);
      expect(firstRate.rateId).toBe('Default');
    });

    it('should not modify paxconfigs and return not bookable', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'TESTNOCHANGETOMAXPAXCONFIGS',
          startDate: '2025-04-01',
          chargeUnitQuantity: 1,
          paxConfigs: [{ roomType: 'DB', adults: 6, children: 3, infants: 1 }],
        },
      });
      expect(retVal).toMatchSnapshot();
      expect(retVal.bookable).toBeFalsy();
    });

    it('should validate max pax per charge and return not bookable', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.searchAvailabilityForItinerary({
        axios,
        token,
        payload: {
          optionId: 'TESTVALIDATEMAXPAXPERCHARGE',
          startDate: '2025-04-01',
          chargeUnitQuantity: 1,
          paxConfigs: [{ roomType: 'DB', adults: 6, children: 3, infants: 1 }],
        },
      });
      expect(retVal).toMatchSnapshot();
      expect(retVal.bookable).toBeFalsy();
      expect(retVal.message).toBe('Maximum 2 pax allowed per Pax Config. Please update the Pax Config accordingly.');
    });
  });

  describe('convertToAdult method tests', () => {
    it('should convert children to adults correctly', () => {
      const paxConfigs = [
        {
          roomType: 'DB',
          adults: 2,
          children: 1,
          infants: 1,
        },
        {
          roomType: 'TW',
          adults: 1,
          children: 2,
          infants: 2,
        },
      ];

      const result = convertToAdult(paxConfigs, 'Child');

      expect(result).toEqual([
        {
          roomType: 'DB',
          adults: 3,
          children: 0,
          infants: 1,
        },
        {
          roomType: 'TW',
          adults: 3,
          children: 0,
          infants: 2,
        },
      ]);
    });

    it('should convert infants to adults correctly', () => {
      const paxConfigs = [
        {
          roomType: 'DB',
          adults: 2,
          children: 1,
          infants: 1,
        },
        {
          roomType: 'TW',
          adults: 1,
          children: 2,
          infants: 2,
        },
      ];

      const result = convertToAdult(paxConfigs, 'Infant');

      expect(result).toEqual([
        {
          roomType: 'DB',
          adults: 3,
          children: 1,
          infants: 0,
        },
        {
          roomType: 'TW',
          adults: 3,
          children: 2,
          infants: 0,
        },
      ]);
    });

    it('should handle paxConfigs with passengers array', () => {
      const paxConfigs = [
        {
          roomType: 'DB',
          adults: 2,
          children: 1,
          passengers: [
            { passengerType: 'Adult', name: 'John' },
            { passengerType: 'Child', name: 'Jane' }
          ]
        }
      ];

      const result = convertToAdult(paxConfigs, 'Child');

      expect(result).toEqual([
        {
          roomType: 'DB',
          adults: 3,
          children: 0,
          passengers: [
            { passengerType: 'Adult', name: 'John' },
            { passengerType: 'Adult', name: 'Jane' }
          ]
        }
      ]);
    });

    it('should handle paxConfigs without the specified type', () => {
      const paxConfigs = [
        { roomType: 'DB', adults: 2, children: 0, infants: 1 },
        { roomType: 'TW', adults: 1, children: 2, infants: 0 }
      ];

      const result = convertToAdult(paxConfigs, 'Child');

      expect(result).toEqual([
        { roomType: 'DB', adults: 2, children: 0, infants: 1 },
        { roomType: 'TW', adults: 3, children: 0, infants: 0 }
      ]);
    });

    it('should handle paxConfigs with undefined or null values', () => {
      const paxConfigs = [
        { roomType: 'DB', adults: undefined, children: null, infants: 1 },
        { roomType: 'TW', adults: 1, children: 2, infants: undefined }
      ];

      const result = convertToAdult(paxConfigs, 'Child');

      expect(result).toEqual([
        { roomType: 'DB', adults: 0, children: 0, infants: 1 },
        { roomType: 'TW', adults: 3, children: 0, infants: undefined }
      ]);
    });

    it('should return non-array input unchanged', () => {
      const nonArrayInput = { roomType: 'DB', adults: 2, children: 1 };
      const result = convertToAdult(nonArrayInput, 'Child');
      expect(result).toBe(nonArrayInput);
    });

    it('should handle empty array', () => {
      const result = convertToAdult([], 'Child');
      expect(result).toEqual([]);
    });

    it('should handle paxConfigs with passengers array containing mixed types', () => {
      const paxConfigs = [
        {
          roomType: 'DB',
          adults: 1,
          children: 2,
          infants: 1,
          passengers: [
            { passengerType: 'Adult', name: 'John' },
            { passengerType: 'Child', name: 'Jane' },
            { passengerType: 'Child', name: 'Bob' },
            { passengerType: 'Infant', name: 'Alice' }
          ]
        }
      ];

      const result = convertToAdult(paxConfigs, 'Child');

      expect(result).toEqual([
        {
          roomType: 'DB',
          adults: 3,
          children: 0,
          infants: 1,
          passengers: [
            { passengerType: 'Adult', name: 'John' },
            { passengerType: 'Adult', name: 'Jane' },
            { passengerType: 'Adult', name: 'Bob' },
            { passengerType: 'Infant', name: 'Alice' }
          ]
        }
      ]);
    });
  });

  describe('Custom Rate Markup Calculations', () => {
    const isBookingForCustomRatesEnabled = true;
    const conversionRate = 1;
    const settings = {
      costPrice: 0,
      buyCurrency: 'USD',
      agentCurrency: 'USD',
      crossSeason: false,
      isRoundRatesEnabled: false,
      isRoundToTheNearestDollarEnabled: false,
    };
    describe('getRatesObjectArray method tests', () => {
      it('should apply no markup when markupPercentage is 0', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '10000',
          AgentPrice: '9000',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, conversionRate, 0);

        expect(result).toHaveLength(1);
        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME);
        expect(result[0].totalPrice).toBe(10000);
        expect(result[0].agentPrice).toBe(9000);
      });

      it('should apply markup when markupPercentage is within valid range', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '10000',
          AgentPrice: '9000',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, conversionRate, 10); // 10% markup

        expect(result).toHaveLength(1);
        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME);
        expect(result[0].totalPrice).toBe(11000); // 10000 * 1.1
        expect(result[0].agentPrice).toBe(9900); // 9000 * 1.1
      });

      it('should apply minimum markup of 1%', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '10000',
          AgentPrice: '9000',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, conversionRate, 1); // 1% markup

        expect(result).toHaveLength(1);
        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME);
        expect(result[0].totalPrice).toBe(10100); // 10000 * 1.01
        expect(result[0].agentPrice).toBe(9090); // 9000 * 1.01
      });

      it('should apply maximum markup of 100%', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '10000',
          AgentPrice: '9000',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, conversionRate, 100); // 100% markup

        expect(result).toHaveLength(1);
        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME);
        expect(result[0].totalPrice).toBe(20000); // 10000 * 2
        expect(result[0].agentPrice).toBe(18000); // 9000 * 2
      });

      it('should handle decimal markup percentages correctly', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '10000',
          AgentPrice: '9000',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, conversionRate, 15.5); // 15.5% markup

        expect(result).toHaveLength(1);
        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME);
        expect(result[0].totalPrice).toBe(11550); // 10000 * 1.155 = 11550 (already integer)
        expect(result[0].agentPrice).toBe(10395); // 9000 * 1.155 = 10395 (already integer)
      });

      it('should handle extended dates with markup correctly', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '10000',
          AgentPrice: '9000',
        }];

        const OptStayResultsExtendedDates = [{
          RateId: 'TEST_RATE_ID',
          TotalPrice: '5000',
          AgentPrice: '4500',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, 
          conversionRate, 10, OptStayResultsExtendedDates, 0, 1, settings, 1);

        expect(result).toHaveLength(1);
        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME);
        // Total: 10000 + (5000 * 1.1) = 15500
        expect(result[0].totalPrice).toBe(15500);
        // Agent: 9000 + (4500 * 1.1) = 13950
        expect(result[0].agentPrice).toBe(13950);
      });

      it('should handle extended dates with fractional results as integers', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '8333',
          AgentPrice: '7777',
        }];

        const OptStayResultsExtendedDates = [{
          RateId: 'TEST_RATE_ID',
          TotalPrice: '3333',
          AgentPrice: '2999',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, 
          conversionRate, 6.66, OptStayResultsExtendedDates, 0, 1, settings, 1);

        expect(result).toHaveLength(1);
        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME);
        // Total: 8333 + (3333 * 1.0666) = 8333 + 3554.9778 = 11887.9778, rounded to 11888
        expect(result[0].totalPrice).toBe(11888);
        // Agent: 7777 + (2999 * 1.0666) = 7777 + 3198.7334 = 10975.7334, rounded to 10976
        expect(result[0].agentPrice).toBe(10976);
        // Verify results are integers
        expect(Number.isInteger(result[0].totalPrice)).toBe(true);
        expect(Number.isInteger(result[0].agentPrice)).toBe(true);
      });

      it('should round prices to integers', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '10033',
          AgentPrice: '9033',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, conversionRate, 7); // 7% markup

        expect(result).toHaveLength(1);
        expect(result[0].totalPrice).toBe(10735); // 10033 * 1.07 = 10735.31, rounded to integer
        expect(result[0].agentPrice).toBe(9665); // 9033 * 1.07 = 9665.31, rounded to integer
      });

      it('should convert decimal results to integers with proper rounding', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '12345',
          AgentPrice: '11111',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, conversionRate, 3.33); // 3.33% markup

        expect(result).toHaveLength(1);
        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME);
        // 12345 * 1.0333 = 12756.2985, rounded to 12756
        expect(result[0].totalPrice).toBe(12756);
        // 11111 * 1.0333 = 11481.0963, rounded to 11481  
        expect(result[0].agentPrice).toBe(11481);
        // Verify results are integers, not decimals
        expect(Number.isInteger(result[0].totalPrice)).toBe(true);
        expect(Number.isInteger(result[0].agentPrice)).toBe(true);
      });

      it('should handle multiple rates with markup applied', () => {
        const OptStayResults = [
          {
            RateId: 'RATE_1',
            Currency: 'USD',
            TotalPrice: '10000',
            AgentPrice: '9000',
          },
          {
            RateId: 'RATE_2',
            Currency: 'EUR',
            TotalPrice: '20000',
            AgentPrice: '18000',
          }
        ];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, conversionRate, 20); // 20% markup

        expect(result).toHaveLength(2);

        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME);
        expect(result[0].totalPrice).toBe(12000); // 10000 * 1.2
        expect(result[0].agentPrice).toBe(10800); // 9000 * 1.2

        expect(result[1].rateId).toBe(CUSTOM_RATE_ID_NAME);
        expect(result[1].totalPrice).toBe(24000); // 20000 * 1.2
        expect(result[1].agentPrice).toBe(21600); // 18000 * 1.2
      });

      it('should ignore markup below minimum threshold', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '10000',
          AgentPrice: '9000',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, conversionRate, 0.5); // Below MIN_MARKUP_PERCENTAGE

        expect(result).toHaveLength(1);
        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME); // Still creates custom rate but with no markup
        expect(result[0].totalPrice).toBe(10000); // No markup applied
        expect(result[0].agentPrice).toBe(9000); // No markup applied
      });

      it('should ignore markup above maximum threshold', () => {
        const OptStayResults = [{
          RateId: 'TEST_RATE_ID',
          Currency: 'USD',
          TotalPrice: '10000',
          AgentPrice: '9000',
        }];

        const result = getRatesObjectArray(OptStayResults, isBookingForCustomRatesEnabled, conversionRate, 101); // Above MAX_MARKUP_PERCENTAGE

        expect(result).toHaveLength(1);
        expect(result[0].rateId).toBe(CUSTOM_RATE_ID_NAME); // Still creates custom rate but with no markup
        expect(result[0].totalPrice).toBe(10000); // No markup applied
        expect(result[0].agentPrice).toBe(9000); // No markup applied
      });
    });

    describe('Custom rates configuration validation', () => {
      it('should validate markup percentage in searchAvailabilityForItinerary', async () => {
        axios.mockImplementation(getFixture);

        // Test with valid markup percentage
        const result = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesMarkupPercentage: 15,
            customRatesEnableForQuotesAndBookings: 'YES',
          },
          payload: {
            optionId: 'TEST_OPTION_VALID_MARKUP_PERCENTAGE',
            startDate: '2027-04-01',
            chargeUnitQuantity: 1,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(result.bookable).toBeTruthy();
        expect(result.rates[0].rateId).toBe(CUSTOM_RATE_ID_NAME);
        // 15% markup applied: 10000 * 1.15 = 11500
        expect(result.rates[0].totalPrice).toBe(11500);
        expect(result.rates[0].agentPrice).toBe(10350); // 9000 * 1.15
      });

      it('should handle invalid markup percentage gracefully', async () => {
        axios.mockImplementation(getFixture);

        // Test with invalid markup percentage (too high)
        const result = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesMarkupPercentage: 101, // Above maximum
          },
          payload: {
            optionId: 'TEST_OPTION_INVALID_MARKUP_PERCENTAGE',
            startDate: '2025-04-01',
            chargeUnitQuantity: 1,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(result.bookable).toBeTruthy();
        expect(result.rates[0].totalPrice).toBe(10000); // No markup applied
        expect(result.rates[0].agentPrice).toBe(9000); // No markup applied
        expect(result.rates[0].rateId).toBe(CUSTOM_RATE_ID_NAME); // Original rate ID
      });
    });
  });

  describe('Minimum Stay Violations', () => {
    describe('validateDateRanges method tests', () => {
      it('should pass validation when no minimum stay requirements', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-05',
            isClosed: 'N',
            minSCU: 1,
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-01',
          chargeUnitQuantity: 2,
        });

        expect(result).toBeNull(); // No validation errors
      });

      it('should detect minimum stay violation when stay is too short', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-05',
            rateSets: [
              {
                isClosed: 'N',
                minSCU: 3, // Requires minimum 3 nights
              },
            ],
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-01',
          chargeUnitQuantity: 2, // Only staying 2 nights
        });

        expect(result).not.toBeNull();
        expect(result.bookable).toBeFalsy();
        expect(result.type).toBe('inventory');
        expect(result.message).toContain('minimum stay length of 3');
        expect(result.message).toContain('01-Apr-2025 to 05-Apr-2025');
      });

      it('should handle multiple date ranges with different minimum stays', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-03',
            rateSets: [
              {
                isClosed: 'N',
                minSCU: 2, // Requires minimum 2 nights
              },
            ],
          },
          {
            startDate: '2025-04-04',
            endDate: '2025-04-08',
            rateSets: [
              {
                isClosed: 'N',
                minSCU: 4, // Requires minimum 4 nights
              },
            ],
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-01',
          chargeUnitQuantity: 5, // Staying 5 nights total
        });

        expect(result).not.toBeNull();
        expect(result.bookable).toBe(false);
        expect(result.message).toContain('minimum stay length of 4');
      });

      it('should pass validation when stay meets minimum requirements', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-05',
            isClosed: 'N',
            rateSets: [
              {
                isClosed: 'N',
                minSCU: 3,
              },
            ],
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-01',
          chargeUnitQuantity: 4, // Staying 4 nights, meets minimum of 3
        });

        expect(result).toBeNull(); // No validation errors
      });

      it('should handle edge case where stay starts after date range', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-03',
            rateSets: [
              {
                isClosed: 'N',
                minSCU: 2,
              },
            ],
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-05', // Starting after the date range
          chargeUnitQuantity: 2,
        });

        expect(result).toBeNull(); // No validation errors since stay doesn't overlap
      });

      it('should test minimum stay violations in multiple date ranges correctly when start date is in first date range', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-02',
            rateSets: [
              {
                isClosed: 'N',
                minSCU: 3, // Requires minimum 3 nights
              },
            ],
          },
          {
            startDate: '2025-04-03',
            endDate: '2025-04-04',
            rateSets: [
              {
                isClosed: 'N',
                minSCU: 4,
              },
            ],
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-01',
          chargeUnitQuantity: 2,
        });

        expect(result).not.toBeNull();
        expect(result.message).toContain('01-Apr-2025 to 02-Apr-2025 has a minimum stay length of 3');
      });

      it('should test minimum stay violations in multiple date ranges correctly when start date is in second date range', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-02',
            rateSets: [
              {
                isClosed: 'N',
                minSCU: 3, // Requires minimum 3 nights
              },
            ],
          },
          {
            startDate: '2025-04-03',
            endDate: '2025-04-04',
            rateSets: [
              {
                isClosed: 'N',
                minSCU: 4, // Requires minimum 4 nights
              },
            ],
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-04',
          chargeUnitQuantity: 2,
        });

        expect(result).not.toBeNull();
        expect(result.message).toContain('03-Apr-2025 to 04-Apr-2025 has a minimum stay length of 4');
      });
    });

    describe('Integration with searchAvailabilityForItinerary', () => {
      it('should return minimum stay error in availability search', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
          },
          payload: {
            optionId: 'TEST_OPTION_MINIMUM_STAY_NOT_MET',
            startDate: '2025-03-22',
            chargeUnitQuantity: 3, // Only 3 nights, but minimum is 5
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeFalsy();
        expect(retVal.type).toBe('inventory');
        expect(retVal.message).toContain('minimum stay length of 5');
      });

      it('should pass minimum stay in availability search', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
          },
          payload: {
            optionId: 'TEST_OPTION_MINIMUM_STAY_ALLOWED',
            startDate: '2025-03-22',
            chargeUnitQuantity: 5, // 5 nights, minimum is 5
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeTruthy();
        expect(retVal.type).toBe('inventory');
        expect(retVal.message).toBeUndefined();
      });
    });
  });

  describe('Closed Period Handling', () => {
    describe('validateDateRanges closed period tests', () => {
      it('should pass validation when no periods are closed', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-05',
            rateSets: [
              {
                isClosed: 'N',
                minSCU: 1,
              },
            ],
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-01',
          chargeUnitQuantity: 3,
        });

        expect(result).toBeNull(); // No validation errors
      });

      it('should detect single closed period', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-05',
            rateSets: [
              {
                isClosed: 'Y', // Period is closed
                minSCU: 1,
              },
            ],
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-01',
          chargeUnitQuantity: 3,
        });

        expect(result).not.toBeNull();
        expect(result.bookable).toBeFalsy();
        expect(result.type).toBe('inventory');
        expect(result.message).toContain('rates are closed');
        expect(result.message).toContain('01-Apr-2025 to 05-Apr-2025');
      });

      it('should detect multiple closed periods', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-03',
            rateSets: [
              {
                isClosed: 'Y',
                minSCU: 1,
              },
            ],
          },
          {
            startDate: '2025-04-05',
            endDate: '2025-04-07',
            rateSets: [
              {
                isClosed: 'Y',
                minSCU: 1,
              },
            ],
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-01',
          chargeUnitQuantity: 7,
        });

        expect(result).not.toBeNull();
        expect(result.bookable).toBeFalsy();
        expect(result.message).toContain('01-Apr-2025 to 03-Apr-2025');
        expect(result.message).toContain('05-Apr-2025 to 07-Apr-2025');
        expect(result.message).toContain(', '); // Multiple periods joined with comma
      });

      it('should handle mixed open and closed periods', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-02',
            rateSets: [
              {
                isClosed: 'N', // Open
                minSCU: 1,
              },
            ],
          },
          {
            startDate: '2025-04-03',
            endDate: '2025-04-04',
            rateSets: [
              {
                isClosed: 'Y', // Closed
                minSCU: 1,
              },
            ],
            minSCU: 1,
          },
          {
            startDate: '2025-04-05',
            endDate: '2025-04-06',
            rateSets: [
              {
                isClosed: 'N', // Open
                minSCU: 1,
              },
            ],
            minSCU: 1,
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-01',
          chargeUnitQuantity: 6,
        });

        expect(result).not.toBeNull();
        expect(result.bookable).toBeFalsy();
        expect(result.message).toContain('03-Apr-2025 to 04-Apr-2025');
        expect(result.message).not.toContain('01-Apr-2025 to 02-Apr-2025');
        expect(result.message).not.toContain('05-Apr-2025 to 06-Apr-2025');
      });

      it('should prioritize closed period errors over minimum stay errors', () => {
        const dateRanges = [
          {
            startDate: '2025-04-01',
            endDate: '2025-04-05',
            rateSets: [
              {
                isClosed: 'Y', // Closed period
                minSCU: 10, // Also has minimum stay violation
              },
            ],
          },
        ];

        const result = validateDateRanges({
          dateRanges,
          startDate: '2025-04-01',
          chargeUnitQuantity: 3,
        });

        expect(result).not.toBeNull();
        expect(result.bookable).toBeFalsy();
        expect(result.message).toContain('rates are closed');
        expect(result.message).not.toContain('minimum stay'); // Closed period takes precedence
      });
    });

    describe('Integration with searchAvailabilityForItinerary', () => {
      it('should return closed period error in availability search', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
          },
          payload: {
            optionId: 'TEST_OPTION_CLOSED_PERIOD',
            startDate: '2025-04-01',
            chargeUnitQuantity: 3,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeFalsy();
        expect(retVal.type).toBe('inventory');
        expect(retVal.message).toContain('rates are closed for the date(s)');
      });
    });
  });

  describe('Historical Rate Fallback Logic', () => {
    describe('getImmediateLastDateRange method tests', () => {
      it('should return the last available date range', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await getImmediateLastDateRange(
          'TEST_OPTION_HISTORICAL_RATE_LAST_DATE_RANGE',
          'test_endpoint',
          'test_agent',
          'test_password',
          axios,
          '2026-05-01',
          { RoomConfig: [{ Adults: 2 }] },
          mockCallTourplan,
        );

        expect(retVal).not.toBeNull();
        expect(Array.isArray(retVal)).toBe(false); // Ensure it's not an array
        expect(typeof retVal).toBe('object'); // Ensure it's a single object
        expect(retVal.startDate).toBeDefined();
        expect(retVal.startDate).toBe('2024-07-01');
        expect(retVal.endDate).toBeDefined();
        expect(retVal.endDate).toBe('2024-12-31');
      });

      it('should return null when no date ranges are found', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await getImmediateLastDateRange(
          'TEST_OPTION_HISTORICAL_RATE_NO_DATE_RANGES',
          'test_endpoint',
          'test_agent',
          'test_password',
          axios,
          '2028-06-01',
          { RoomConfig: [{ Adults: 2 }] },
          mockCallTourplan,
        );

        expect(retVal).toBeNull();
      });

      it('should limit search period to prevent very long periods', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await getImmediateLastDateRange(
          'TEST_OPTION_HISTORICAL_RATE_MAX_EXTENDED_BOOKING_YEARS',
          'test_endpoint',
          'test_agent',
          'test_password',
          axios,
          '2125-06-01', // Far future date
          { RoomConfig: [{ Adults: 2 }] },
          mockCallTourplan,
        );

        expect(retVal).toBeNull();
      });
    });

    describe('Custom rates with historical fallback', () => {
      it('should use last year rates when useLastYearRate is true', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'YES', // Use last year's rate
            customRatesMarkupPercentage: 10,
          },
          payload: {
            optionId: 'TEST_OPTION_LAST_YEAR_RATE',
            startDate: '2026-08-01',
            chargeUnitQuantity: 2,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeTruthy();
        expect(retVal.rates[0].rateId).toBe('Custom');
        expect(retVal.rates[0].totalPrice).toBe(11000); // 10000 * 1.1 markup
        expect(retVal.rates[0].agentPrice).toBe(99000); // 90000 * 1.1 markup
        expect(retVal.message).toContain('last year\'s rate');
      });

      it('should use last available rates when useLastYearRate is false', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO', // Use last available rate
            customRatesMarkupPercentage: 5,
          },
          payload: {
            optionId: 'TEST_OPTION_LAST_AVAILABLE_RATE',
            startDate: '2026-08-01',
            chargeUnitQuantity: 2,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeTruthy();
        expect(retVal.rates[0].rateId).toBe('Custom');
        expect(retVal.rates[0].totalPrice).toBe(63000); // 60000 * 1.05 markup
        expect(retVal.rates[0].agentPrice).toBe(64050); // 61000 * 1.05 markup
        expect(retVal.message).toContain('last available rate');

        // verify the immediate last date range is correct
        const retVal2 = await getImmediateLastDateRange(
          'TEST_OPTION_LAST_AVAILABLE_RATE',
          'test_endpoint',
          'test_agent',
          'test_password',
          axios,
          '2026-08-01',
          { RoomConfig: [{ Adults: 2 }] },
          mockCallTourplan,
        );

        expect(retVal2).not.toBeNull();
        expect(Array.isArray(retVal)).toBe(false); // Ensure it's not an array
        expect(typeof retVal).toBe('object'); // Ensure it's a single object
        expect(retVal2.startDate).toBeDefined();
        expect(retVal2.startDate).toBe('2026-03-22');
        expect(retVal2.endDate).toBeDefined();
        expect(retVal2.endDate).toBe('2026-04-30');
      });

      it('should validate extended booking years limit', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO',
            customRatesExtendedBookingYears: 1, // Only allow 1 year extension
          },
          payload: {
            optionId: 'TEST_OPTION_LIMIT_EXTENDED_BOOKING_YEARS',
            startDate: '2028-04-01', // More than 1 year after last available rate
            chargeUnitQuantity: 2,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeFalsy();
        expect(retVal.message).toContain('Custom rates can only be extended by 1 year(s)');
        expect(retVal.message).toContain('2026-04-30');
      });

      it('should return error when no immediate last date range is found', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'NO',
            customRatesCalculateWithLastYearsRate: 'NO',
          },
          payload: {
            optionId: 'TEST_OPTION_NO_IMMEDIATE_LAST_DATE_RANGE',
            startDate: '2028-10-01',
            chargeUnitQuantity: 2,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeFalsy();
        expect(retVal.message).toContain('31-Aug-2025');
        expect(retVal.message).toContain('Rates are only available until');
      });

      it('should handle mixed current and historical rates', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'YES',
            customRatesMarkupPercentage: 10,
          },
          payload: {
            optionId: 'TEST_OPTION_MIXED_CURRENT_AND_HISTORICAL_RATES',
            startDate: '2025-08-31',
            chargeUnitQuantity: 3,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        // The rates will be calculated from 2 fixtures
        // 1. __fixtures__/OptionInfoRequest_84c9c36bb9cbd935857118150df03266bdbd3f34.txt
        // The first fixture will be used for the current rates for 1 day
        // Total price: 50000 * 1 = 50000
        // Agent price: 55000 * 1 = 55000
        // 2. __fixtures__/OptionInfoRequest_87ca5ae49fac1bae1564c4055a62e625b3259ea2.txt
        // The second fixture will be used for the historical rates for 2 days
        // Note that TourPlan automatically returns the value for 2 days we do
        // need to calucate it
        // Total price: 60000 * 2 = 120000
        // Agent price: 61000 * 2 = 122000

        // Markup percentage: 10% applied to both total price and agent price

        // The total price will be the sum of the total prices from the 2 fixtures
        //    50000 + 120000 * 1.1 = 182000
        // The agent price will be the sum of the agent prices from the 2 fixtures
        //    55000 + 122000 * 1.1 = 189200
        expect(retVal.bookable).toBeTruthy();
        expect(retVal.rates[0].rateId).toBe('Custom');
        expect(retVal.message).toContain('Custom rate applied');
        expect(retVal.rates[0].totalPrice).toBeDefined();
        expect(retVal.rates[0].totalPrice).toBe(182000);
        expect(retVal.rates[0].agentPrice).toBeDefined();
        expect(retVal.rates[0].agentPrice).toBe(189200);
      });
    });
  });

  describe('Custom Rates Extended Booking Years', () => {
    describe('Extended booking years validation', () => {
      it('should use default extended booking years when parameter is not provided', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO',
            customRatesMarkupPercentage: 10,
            // customRatesExtendedBookingYears not provided - should use default (2)
          },
          payload: {
            optionId: 'TEST_OPTION_USE_DEFAULT_EXTENDED_BOOKING_YEARS',
            startDate: '2027-09-01', // Within 2 years of last available rate (2025-08-31)
            chargeUnitQuantity: 2,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeFalsy();
        expect(retVal.message).toContain('Last available rate until: 2025-08-31');
        expect(retVal.message).toContain('Custom rates can only be extended by 2 year(s)');
      });

      it('should use minimum extended booking years when parameter is below minimum', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO',
            customRatesMarkupPercentage: 10,
            customRatesExtendedBookingYears: 0, // Below minimum, should default to 2
          },
          payload: {
            optionId: 'TEST_OPTION_USE_MINIMUM_EXTENDED_BOOKING_YEARS',
            startDate: '2027-09-01', // Within default 2 years
            chargeUnitQuantity: 2,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeFalsy();
        expect(retVal.message).toContain('Custom rates can only be extended by 2 year(s)');
        expect(retVal.message).toContain('Last available rate until: 2025-08-31');
      });

      it('should use maximum extended booking years when parameter is above maximum', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO',
            customRatesMarkupPercentage: 10,
            customRatesExtendedBookingYears: 150, // Above maximum, should default to 2
          },
          payload: {
            optionId: 'TEST_OPTION_USE_MAXIMUM_EXTENDED_BOOKING_YEARS',
            startDate: '2027-09-01', // Within default 2 years
            chargeUnitQuantity: 2,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeFalsy();
        expect(retVal.message).toContain('Custom rates can only be extended by 2 year(s)');
        expect(retVal.message).toContain('Last available rate until: 2025-08-31');
      });

      it('should accept valid extended booking years within range', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO',
            customRatesMarkupPercentage: 20,
            customRatesExtendedBookingYears: 5, // Valid value
          },
          payload: {
            optionId: 'TEST_OPTION_USE_VALID_EXTENDED_BOOKING_YEARS',
            startDate: '2030-08-28', // Within 5 years of 2025-08-31
            chargeUnitQuantity: 2,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeTruthy();
        expect(retVal.message).toContain('Custom rate applied, calculated using a markup on last available rate.');
        expect(retVal.rates[0].rateId).toBe('Custom');
        expect(retVal.rates[0].totalPrice).toBeDefined();
        expect(retVal.rates[0].totalPrice).toBe(60000); // 50000 * 1.2
        expect(retVal.rates[0].agentPrice).toBeDefined();
        expect(retVal.rates[0].agentPrice).toBe(66000); // 55000 * 1.2
      });

      it('should handle null/undefined extended booking years parameter', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO',
            customRatesMarkupPercentage: 20,
            customRatesExtendedBookingYears: null, // Should use default (2)
          },
          payload: {
            optionId: 'TEST_OPTION_NULL_EXTENDED_BOOKING_YEARS',
            startDate: '2027-09-01', // after 2 years of 2025-08-31
            chargeUnitQuantity: 2,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeFalsy();
        expect(retVal.message).toContain('Custom rates can only be extended by 2 year(s)');
        expect(retVal.message).toContain('Last available rate until: 2025-08-31');
      });

      it('should accept valid booking years as string parameter', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO',
            customRatesMarkupPercentage: 20,
            customRatesExtendedBookingYears: '3', // Valid value
          },
          payload: {
            optionId: 'TEST_OPTION_USE_VALID_BOOKING_YEARS_AS_STRING',
            startDate: '2028-08-28', // Within 3 years of 2025-08-31
            chargeUnitQuantity: 2,
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeTruthy();
        expect(retVal.message).toContain('Custom rate applied, calculated using a markup on last available rate.');
        expect(retVal.rates[0].rateId).toBe('Custom');
        expect(retVal.rates[0].totalPrice).toBeDefined();
        expect(retVal.rates[0].totalPrice).toBe(60000); // 50000 * 1.2
        expect(retVal.rates[0].agentPrice).toBeDefined();
        expect(retVal.rates[0].agentPrice).toBe(66000); // 55000 * 1.2
      });
    });

    describe('Extended booking years limit enforcement', () => {
      it('should reject booking when period of stay exceeds extended booking years limit', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO',
            customRatesMarkupPercentage: 20,
            customRatesExtendedBookingYears: 5, // Valid value
          },
          payload: {
            optionId: 'TEST_OPTION_BOOKING_PERIOD_EXCEEDS_EXTENDED_BOOKING_YEARS_LIMIT',
            startDate: '2030-08-29', // Within 5 years of 2025-08-31
            chargeUnitQuantity: 4, // request booking till 2030-09-02 which is after 2030-08-31
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeFalsy();
        expect(retVal.message).toContain('Custom rates can only be extended by 5 year(s)');
        expect(retVal.message).toContain('Last available rate until: 2025-08-31');
      });

      it('should allow booking when period of stay at the boundary of extended booking years limit', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO',
            customRatesMarkupPercentage: 20,
            customRatesExtendedBookingYears: 5, // Valid value
          },
          payload: {
            optionId: 'TEST_OPTION_BOOKING_PERIOD_AT_BOUNDARY_OF_EXTENDED_BOOKING_YEARS_LIMIT',
            startDate: '2030-08-29', // Within 5 years of 2025-08-31
            chargeUnitQuantity: 2, // at the boundary of the extended booking years limit
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeTruthy();
        expect(retVal.message).toContain('Custom rate applied, calculated using a markup on last available rate.');
        expect(retVal.rates[0].rateId).toBe('Custom');
        expect(retVal.rates[0].totalPrice).toBeDefined();
        expect(retVal.rates[0].totalPrice).toBe(60000); // 50000 * 1.2
        expect(retVal.rates[0].agentPrice).toBeDefined();
        expect(retVal.rates[0].agentPrice).toBe(66000); // 55000 * 1.2
      });

      it('should not apply extended booking years limit when current rates are available', async () => {
        axios.mockImplementation(getFixture);

        const retVal = await app.searchAvailabilityForItinerary({
          axios,
          token: {
            hostConnectEndpoint: 'test',
            hostConnectAgentID: 'test',
            hostConnectAgentPassword: 'test',
            customRatesEnableForQuotesAndBookings: 'YES',
            customRatesCalculateWithLastYearsRate: 'NO',
            customRatesMarkupPercentage: 15,
            customRatesExtendedBookingYears: 3, // Valid value
          },
          payload: {
            optionId: 'TEST_OPTION_DO_NOT_APPLY_EXTENDED_BOOKING_YEARS_LIMIT_WHEN_CURRENT_RATES_ARE_AVAILABLE',
            startDate: '2027-08-29', // Within 5 years of 2025-08-31
            chargeUnitQuantity: 2, // at the boundary of the extended booking years limit
            paxConfigs: [{ roomType: 'DB', adults: 2 }],
          },
        });

        expect(retVal.bookable).toBeTruthy();
        // When current rates are available, they get processed normally
        // The main point of this test is that extended booking years limit doesn't apply
        expect(retVal.rates).toBeDefined();
        expect(retVal.rates).toHaveLength(1);
        expect(retVal.rates[0].totalPrice).toBeDefined();
        expect(retVal.rates[0].totalPrice).toBe(57500); // 50000 * 1.15
        expect(retVal.rates[0].agentPrice).toBeDefined();
        expect(retVal.rates[0].agentPrice).toBe(63250); // 55000 * 1.15
      });
    });
  });

  describe('calculateEndDate method tests', () => {
    it('should calculate end date when duration is provided', () => {
      const startDate = '2025-01-15';
      const duration = 5;
      const chargeUnitQuantity = null;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-01-20');
    });

    it('should calculate end date when chargeUnitQuantity is greater than 1', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = 3;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-01-18');
    });

    it('should prioritize duration over chargeUnitQuantity when both are provided', () => {
      const startDate = '2025-01-15';
      const duration = 7;
      const chargeUnitQuantity = 5;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-01-22');
    });

    it('should return null when neither duration nor chargeUnitQuantity is provided', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = null;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBeNull();
    });

    it('should return null when chargeUnitQuantity is 1 or less', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = 1;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBeNull();
    });

    it('should return null when chargeUnitQuantity is 0', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = 0;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBeNull();
    });

    it('should handle leap year dates correctly', () => {
      const startDate = '2024-02-28';
      const duration = 1;
      const chargeUnitQuantity = null;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2024-02-29');
    });

    it('should handle month boundary transitions correctly', () => {
      const startDate = '2025-01-31';
      const duration = 1;
      const chargeUnitQuantity = null;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-02-01');
    });

    it('should handle year boundary transitions correctly', () => {
      const startDate = '2024-12-31';
      const duration = 1;
      const chargeUnitQuantity = null;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-01-01');
    });

    it('should handle large duration values correctly', () => {
      const startDate = '2025-01-15';
      const duration = 365;
      const chargeUnitQuantity = null;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2026-01-15');
    });

    it('should handle large chargeUnitQuantity values correctly', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = 30;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-02-14');
    });

    it('should handle undefined duration and chargeUnitQuantity', () => {
      const startDate = '2025-01-15';
      const duration = undefined;
      const chargeUnitQuantity = undefined;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBeNull();
    });

    it('should handle null duration and chargeUnitQuantity', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = null;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBeNull();
    });

    it('should handle falsy chargeUnitQuantity values when duration is null', () => {
      const startDate = '2025-01-15';

      // Test with chargeUnitQuantity = 0
      expect(calculateEndDate(startDate, null, 0)).toBeNull();

      // Test with chargeUnitQuantity = false
      expect(calculateEndDate(startDate, null, false)).toBeNull();

      // Test with chargeUnitQuantity = empty string
      expect(calculateEndDate(startDate, null, '')).toBeNull();
    });

    it('should handle different date formats correctly', () => {
      const startDate = '2025-01-15';
      const duration = 2;
      const chargeUnitQuantity = null;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-01-17');
    });

    it('should handle edge case with very large numbers', () => {
      const startDate = '2025-01-15';
      const duration = 999999;
      const chargeUnitQuantity = null;

      const result = calculateEndDate(startDate, duration, chargeUnitQuantity);

      // This should still work with moment.js
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
