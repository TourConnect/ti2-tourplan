/* globals describe, it, expect, jest, beforeEach */

jest.mock('./itinerary-availability-utils', () => ({
  validateMaxPaxPerCharge: jest.fn(() => null),
  validateDateRanges: jest.fn(() => null),
  validateStartDay: jest.fn(() => null),
  getMatchingRateSet: jest.fn(() => ({ matchingRateSet: null })),
}));

jest.mock('./product-connect/itinerary-pc-api-validation-helper', () => ({
  validateProductConnect: jest.fn(async () => false),
}));

jest.mock('./itinerary-availability-helper', () => ({
  getAgentCurrencyCode: jest.fn(async () => 'USD'),
  getConversionRate: jest.fn(async () => ({ conversionRate: 1 })),
  findNextValidDate: jest.fn(() => null),
  getAvailabilityConfig: jest.fn(async () => ({
    roomConfigs: [{ Adults: 2 }],
    endDate: null,
    message: null,
    dateRanges: [{ startDate: '2025-04-01', endDate: '2025-04-30', rateSets: [] }],
    duration: null,
    maxPaxPerCharge: null,
  })),
  getNoRatesAvailableError: jest.fn(async () => 'No rates available'),
  getStayResults: jest.fn(async () => ([{
    RateId: 'R1',
    Currency: 'USD',
    TotalPrice: '10000',
    AgentPrice: '9000',
  }])),
  getCustomRateDateRange: jest.fn(async () => ({ dateRangeToUse: null, errorMsg: 'No custom rate' })),
  getRatesObjectArray: jest.fn(() => ([{ rateId: 'R1', totalPrice: 10000, agentPrice: 9000 }])),
  getEmptyRateObject: jest.fn(() => ([{ rateId: 'EMPTY' }])),
  MIN_MARKUP_PERCENTAGE: 0,
  MAX_MARKUP_PERCENTAGE: 100,
  MIN_EXTENDED_BOOKING_YEARS: 1,
  MAX_EXTENDED_BOOKING_YEARS: 10,
  GENERIC_AVALABILITY_CHK_ERROR_MESSAGE: 'Generic availability error',
}));

jest.mock('./product-connect/itinerary-pc-rates-helper', () => ({
  getCostFromProductConnect: jest.fn(async () => ({
    success: false,
    costPriceIncludingTax: 0,
    taxRate: 0,
  })),
}));

jest.mock('./product-connect/itinerary-pc-option-helper', () => ({
  getOptionFromProductConnect: jest.fn(async () => null),
  CROSS_SEASON_NOT_ALLOWED: 'N',
  CROSS_SEASON_CAL_SPLIT_RATE: 'S',
  CROSS_SEASON_CAL_USING_RATE_OF_FIRST_RATE_PERIOD: 'F',
}));

const itineraryAvailabilityUtils = require('./itinerary-availability-utils');
const itineraryAvailabilityHelper = require('./itinerary-availability-helper');
const { searchAvailabilityForItinerary } = require('./itinerary-availability');

describe('searchAvailabilityForItinerary validation flags', () => {
  const baseToken = {
    hostConnectEndpoint: 'https://test-host-connect.com',
    hostConnectAgentID: 'test-agent-id',
    hostConnectAgentPassword: 'test-agent-password',
  };

  const basePayload = {
    optionId: 'OPTION_1',
    startDate: '2025-04-01',
    chargeUnitQuantity: 2,
    paxConfigs: [{ roomType: 'DB', adults: 2 }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs date range validation when duration is not fixed and room type is required', async () => {
    itineraryAvailabilityHelper.getAvailabilityConfig.mockResolvedValueOnce({
      roomConfigs: [{ Adults: 2 }],
      endDate: null,
      message: null,
      dateRanges: [{ startDate: '2025-04-01', endDate: '2025-04-30', rateSets: [] }],
      duration: null,
      maxPaxPerCharge: null,
    });

    const result = await searchAvailabilityForItinerary({
      axios: jest.fn(),
      token: baseToken,
      payload: basePayload,
      callTourplan: jest.fn(),
      cache: { getOrExec: async ({ fn, fnParams }) => fn(...fnParams) },
    });

    expect(itineraryAvailabilityUtils.validateDateRanges).toHaveBeenCalled();
    expect(result.bookable).toBe(true);
    expect(result.type).toBe('inventory');
  });

  it('skips date range validation when roomTypeRequired is false', async () => {
    itineraryAvailabilityHelper.getAvailabilityConfig.mockResolvedValueOnce({
      roomConfigs: [{ Adults: 2 }],
      endDate: null,
      message: null,
      dateRanges: [{ startDate: '2025-04-01', endDate: '2025-04-30', rateSets: [] }],
      duration: null,
      maxPaxPerCharge: null,
    });

    const result = await searchAvailabilityForItinerary({
      axios: jest.fn(),
      token: baseToken,
      payload: { ...basePayload, roomTypeRequired: false },
      callTourplan: jest.fn(),
      cache: { getOrExec: async ({ fn, fnParams }) => fn(...fnParams) },
    });

    expect(itineraryAvailabilityUtils.validateDateRanges).not.toHaveBeenCalled();
    expect(result.bookable).toBe(true);
    expect(result.type).toBe('inventory');
  });

  it('skips date range validation when duration is greater than 1', async () => {
    itineraryAvailabilityHelper.getAvailabilityConfig.mockResolvedValueOnce({
      roomConfigs: [{ Adults: 2 }],
      endDate: '2025-04-02',
      message: 'Duration is fixed',
      dateRanges: [{ startDate: '2025-04-01', endDate: '2025-04-30', rateSets: [] }],
      duration: 2,
      maxPaxPerCharge: null,
    });

    const result = await searchAvailabilityForItinerary({
      axios: jest.fn(),
      token: baseToken,
      payload: basePayload,
      callTourplan: jest.fn(),
      cache: { getOrExec: async ({ fn, fnParams }) => fn(...fnParams) },
    });

    expect(itineraryAvailabilityUtils.validateDateRanges).not.toHaveBeenCalled();
    expect(result.bookable).toBe(true);
    expect(result.type).toBe('inventory');
    expect(result.endDate).toBe('2025-04-02');
  });
});
