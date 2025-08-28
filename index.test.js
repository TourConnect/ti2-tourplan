/* globals describe, it, expect, jest, afterEach */
const { readFile } = require('fs').promises;
const axios = require('axios');
const path = require('path');
const xml2js = require('xml2js');
const R = require('ramda');
const hash = require('object-hash');
const { typeDefs: itineraryProductTypeDefs, query: itineraryProductQuery } = require('./node_modules/ti2/controllers/graphql-schemas/itinerary-product');
const { typeDefs: itineraryBookingTypeDefs, query: itineraryBookingQuery } = require('./node_modules/ti2/controllers/graphql-schemas/itinerary-booking');

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

const getFixture = async requestObject => {
  // Extract request name using regex
  const requestName = requestObject.data && typeof requestObject.data === 'string' && R.pathOr('UnknownRequest', [1], requestObject.data.match(/<(\w+Request)>/))
    ? R.pathOr('UnknownRequest', [1], requestObject.data.match(/<(\w+Request)>/))
    : 'UnknownRequest';
  const requestHash = hash(requestObject);
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
        optionId: 'LONTRDAVIDSHDWBVC',
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
          chargeUnitQuantity: 1,
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
      expect(retVal).toMatchSnapshot();
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

  describe('getOptionGeneralInfo tests', () => {
    it('should return correct general option information', async () => {
      axios.mockImplementation(getFixture);
      const retVal = await app.getOptionGeneralInfo(
        'TESTGENERALINFO',
        token.hostConnectEndpoint,
        token.hostConnectAgentID,
        token.hostConnectAgentPassword,
        axios,
      );

      expect(retVal).toHaveProperty('childrenAllowed');
      expect(retVal).toHaveProperty('countChildrenInPaxBreak');
      expect(retVal).toHaveProperty('infantsAllowed');
      expect(retVal).toHaveProperty('countInfantsInPaxBreak');
      expect(retVal).toHaveProperty('duration');
      expect(retVal).toHaveProperty('maxPaxPerCharge');
      expect(retVal).toHaveProperty('chargeUnit');

      // Verify the values based on the fixture data
      expect(retVal.childrenAllowed).toBe(true);
      expect(retVal.countChildrenInPaxBreak).toBe(true);
      expect(retVal.infantsAllowed).toBe(true);
      expect(retVal.countInfantsInPaxBreak).toBe(true);
      expect(retVal.duration).toBe(2);
      expect(retVal.maxPaxPerCharge).toBe(6);
      expect(retVal.chargeUnit).toBe('day');
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

      const result = app.convertToAdult(paxConfigs, 'Child');

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

      const result = app.convertToAdult(paxConfigs, 'Infant');

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

      const result = app.convertToAdult(paxConfigs, 'Child');

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

      const result = app.convertToAdult(paxConfigs, 'Child');

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

      const result = app.convertToAdult(paxConfigs, 'Child');

      expect(result).toEqual([
        { roomType: 'DB', adults: 0, children: 0, infants: 1 },
        { roomType: 'TW', adults: 3, children: 0, infants: undefined }
      ]);
    });

    it('should return non-array input unchanged', () => {
      const nonArrayInput = { roomType: 'DB', adults: 2, children: 1 };
      const result = app.convertToAdult(nonArrayInput, 'Child');
      expect(result).toBe(nonArrayInput);
    });

    it('should handle empty array', () => {
      const result = app.convertToAdult([], 'Child');
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

      const result = app.convertToAdult(paxConfigs, 'Child');

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

  describe('calculateEndDate method tests', () => {
    it('should calculate end date when duration is provided', () => {
      const startDate = '2025-01-15';
      const duration = 5;
      const chargeUnitQuantity = null;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-01-20');
    });

    it('should calculate end date when chargeUnitQuantity is greater than 1', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = 3;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-01-18');
    });

    it('should prioritize duration over chargeUnitQuantity when both are provided', () => {
      const startDate = '2025-01-15';
      const duration = 7;
      const chargeUnitQuantity = 5;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-01-22');
    });

    it('should return null when neither duration nor chargeUnitQuantity is provided', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = null;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBeNull();
    });

    it('should return null when chargeUnitQuantity is 1 or less', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = 1;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBeNull();
    });

    it('should return null when chargeUnitQuantity is 0', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = 0;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBeNull();
    });

    it('should handle leap year dates correctly', () => {
      const startDate = '2024-02-28';
      const duration = 1;
      const chargeUnitQuantity = null;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2024-02-29');
    });

    it('should handle month boundary transitions correctly', () => {
      const startDate = '2025-01-31';
      const duration = 1;
      const chargeUnitQuantity = null;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-02-01');
    });

    it('should handle year boundary transitions correctly', () => {
      const startDate = '2024-12-31';
      const duration = 1;
      const chargeUnitQuantity = null;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-01-01');
    });

    it('should handle large duration values correctly', () => {
      const startDate = '2025-01-15';
      const duration = 365;
      const chargeUnitQuantity = null;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2026-01-15');
    });

    it('should handle large chargeUnitQuantity values correctly', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = 30;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-02-14');
    });

    it('should handle undefined duration and chargeUnitQuantity', () => {
      const startDate = '2025-01-15';
      const duration = undefined;
      const chargeUnitQuantity = undefined;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBeNull();
    });

    it('should handle null duration and chargeUnitQuantity', () => {
      const startDate = '2025-01-15';
      const duration = null;
      const chargeUnitQuantity = null;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBeNull();
    });

    it('should handle falsy chargeUnitQuantity values when duration is null', () => {
      const startDate = '2025-01-15';

      // Test with chargeUnitQuantity = 0
      expect(app.calculateEndDate(startDate, null, 0)).toBeNull();

      // Test with chargeUnitQuantity = false
      expect(app.calculateEndDate(startDate, null, false)).toBeNull();

      // Test with chargeUnitQuantity = empty string
      expect(app.calculateEndDate(startDate, null, '')).toBeNull();
    });

    it('should handle different date formats correctly', () => {
      const startDate = '2025-01-15';
      const duration = 2;
      const chargeUnitQuantity = null;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      expect(result).toBe('2025-01-17');
    });

    it('should handle edge case with very large numbers', () => {
      const startDate = '2025-01-15';
      const duration = 999999;
      const chargeUnitQuantity = null;

      const result = app.calculateEndDate(startDate, duration, chargeUnitQuantity);

      // This should still work with moment.js
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
