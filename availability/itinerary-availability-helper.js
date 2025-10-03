const crypto = require('crypto');
const moment = require('moment');
const R = require('ramda');
const {
  getModifiedPaxConfigs,
  calculateEndDate,
  getOptionMessage,
  parseDateRanges,
  extractCancelPolicies,
  USER_FRIENDLY_DATE_FORMAT,
} = require('./itinerary-availability-utils');
const {
  getRoomConfigs,
  CUSTOM_RATE_ID_NAME,
  CUSTOM_NO_RATE_NAME,
  hostConnectXmlOptions,
} = require('../utils');
const {
  CROSS_SEASON_CAL_USING_RATE_OF_FIRST_RATE_PERIOD,
} = require('./product-connect/itinerary-pc-option-helper');

const NO_RATE_FOUND_FOR_LAST_YEAR_ERROR_MESSAGE = 'Custom rates cannot be calculated as the previous year\'s rate could not be found. Please change the date and try again.';
const NO_RATE_FOUND_FOR_IMMEDIATE_LAST_DATE_RANGE_ERROR_MESSAGE = 'Custom rates cannot be calculated no last rates available. Please change the date and try again.';

// Day of week constants for better readability
const DAY_OF_WEEK = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

// Helper function to calculate rate with minimum stay requirements
const calculateRateWithMinStay = (
  totalPrice,
  agentPrice,
  minStayRequired,
  daysToChargeAtLastRate,
) => {
  if (minStayRequired > daysToChargeAtLastRate) {
    const oneDayTotalPrice = totalPrice / minStayRequired;
    const oneDayAgentPrice = agentPrice / minStayRequired;
    return {
      finalTotalPrice: oneDayTotalPrice * daysToChargeAtLastRate,
      finalAgentPrice: oneDayAgentPrice * daysToChargeAtLastRate,
    };
  }
  return {
    finalTotalPrice: totalPrice,
    finalAgentPrice: agentPrice,
  };
};

// Helper function to apply cross-season calculation
const applyCrossSeasonFirstRate = (
  totalPrice,
  agentPrice,
  noOfDaysRatesAvailable,
  daysToChargeAtLastRate,
  crossSeason,
) => {
  if (crossSeason === CROSS_SEASON_CAL_USING_RATE_OF_FIRST_RATE_PERIOD) {
    // Calculate rate for entire period using rate of first rate period
    const perDayPrice = totalPrice / noOfDaysRatesAvailable;
    const perDayAgentPrice = agentPrice / noOfDaysRatesAvailable;
    const finalTotalPrice = perDayPrice * (daysToChargeAtLastRate + noOfDaysRatesAvailable);
    const finalAgentPrice = perDayAgentPrice * (daysToChargeAtLastRate + noOfDaysRatesAvailable);

    // DO NOT apply markup factor for first rate period cross-season calculation
    return { finalTotalPrice, finalAgentPrice };
  }
  return null; // Indicates no cross-season calculation was applied
};

// Helper function to apply rate rounding
const applyRateRounding = (
  finalTotalPrice,
  finalAgentPrice,
  totalCostPrice,
  currencyPrecision,
  isRoundRatesEnabled,
  isRoundToTheNearestDollarEnabled,
) => {
  if (!isRoundRatesEnabled) {
    return { finalTotalPrice, finalAgentPrice, totalCostPrice };
  }

  const divisor = 10 ** currencyPrecision;

  // Convert from cents to dollars if currency precision indicates cents
  const finalTotalPriceInDollars = finalTotalPrice / divisor;
  const finalAgentPriceInDollars = finalAgentPrice / divisor;
  const finalTotalCostPriceInDollars = totalCostPrice / divisor;

  let roundedTotalPrice = finalTotalPriceInDollars;
  let roundedAgentPrice = finalAgentPriceInDollars;
  let roundedTotalCostPrice = finalTotalCostPriceInDollars;

  if (isRoundToTheNearestDollarEnabled) {
    // Round to the nearest dollar
    roundedTotalPrice = Math.round(finalTotalPriceInDollars);
    roundedAgentPrice = Math.round(finalAgentPriceInDollars);
    roundedTotalCostPrice = Math.round(finalTotalCostPriceInDollars);
  } else {
    // Round UP to the next dollar amount
    roundedTotalPrice = Math.ceil(finalTotalPriceInDollars);
    roundedAgentPrice = Math.ceil(finalAgentPriceInDollars);
    roundedTotalCostPrice = Math.ceil(finalTotalCostPriceInDollars);
  }

  // Convert back to the original currency format
  return {
    finalTotalPrice: roundedTotalPrice * divisor,
    finalAgentPrice: roundedAgentPrice * divisor,
    totalCostPrice: roundedTotalCostPrice * divisor,
  };
};

// Constants
const MIN_MARKUP_PERCENTAGE = 1;
const MAX_MARKUP_PERCENTAGE = 100;
const MIN_EXTENDED_BOOKING_YEARS = 1;
const MAX_EXTENDED_BOOKING_YEARS = 100;

// constants not exported
const GENERIC_AVALABILITY_CHK_ERROR_MESSAGE = 'Not bookable for the requested date/stay. '
  + '(e.g. no rates, block out period, on request, minimum stay etc.)';
const RATES_AVAILABLE_TILL_ERROR_TEMPLATE = 'Rates are only available until {dateTill}. '
  + 'Please change the date and try again.';
/**
 * Calculate days in a year for a given date, accounting for leap years
 * @param {string} dateString - Date string in YYYY-MM-DD format
 * @returns {number} Number of days in the year (365 or 366)
 */
const getDaysInYear = dateString => {
  const year = moment(dateString).year();
  return moment([year]).isLeapYear() ? 366 : 365;
};
/*
    Get general option information from Tourplan API.

    @param {string} optionId - The option ID to get information for
    @param {string} hostConnectEndpoint - The HostConnect endpoint
    @param {string} hostConnectAgentID - The agent ID
    @param {string} hostConnectAgentPassword - The agent password
    @param {Object} axios - The axios instance
    @param {string} startDate - The start date
    @param {number} chargeUnitQuantity - The number of charge units
    @returns {Object} Object containing general option information
*/
const getGeneralAndDateRangesInfo = async (
  optionId,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
  axios,
  startDate,
  chargeUnitQuantity,
  callTourplan,
) => {
  const getGeneralModel = checkType => ({
    OptionInfoRequest: {
      Opt: optionId,
      Info: checkType,
      AgentID: hostConnectAgentID,
      Password: hostConnectAgentPassword,
      DateFrom: startDate,
      SCUqty: chargeUnitQuantity,
    },
  });

  // Use G (General) & D (Date Ranges) check type to get the option general information
  // and date ranges information
  const replyObj = await callTourplan({
    model: getGeneralModel('GD'),
    endpoint: hostConnectEndpoint,
    axios,
    xmlOptions: hostConnectXmlOptions,
  });
  const GDCheck = R.path(['OptionInfoReply', 'Option'], replyObj);

  const OptGeneralResult = R.pathOr({}, ['OptGeneral'], GDCheck);
  const OptDateRangesResult = R.pathOr({}, ['OptDateRanges'], GDCheck);
  const dateRanges = parseDateRanges(OptDateRangesResult);
  const countChildrenInPaxBreak = R.pathOr(false, ['CountChildrenInPaxBreak'], OptGeneralResult) === 'Y';
  const childrenAllowed = R.pathOr(false, ['ChildrenAllowed'], OptGeneralResult) === 'Y';
  const infantsAllowed = R.pathOr(false, ['InfantsAllowed'], OptGeneralResult) === 'Y';
  const countInfantsInPaxBreak = R.pathOr(false, ['CountInfantsInPaxBreak'], OptGeneralResult) === 'Y';
  const duration = R.pathOr(null, ['Periods'], OptGeneralResult);
  /* Charging multiple:
    As per hostconnect documentation, this field is reported for non-accommodation and apartment
    options (SType is N or A). However, test cases show that it is reported for accommodation
    options as well. (SType is Y)
    1.For apartments it gives the maximum number of adults that one apartment can hold.
    2.For accommodation options, the same logic applies as for apartments. e.g. entire lodge.
    3.For non-accommodation options, if MPFCU has a value of 1 then rates are per-person.
    MPFCU is greater than one then rates for this option are for a group, and MPFCU is the
    maximum number of people (adults plus children) that can be booked per AddService call.
    Hence we need to check if the number of people in roomConfigs is greater than maxPaxPerCharge.
    A rental car might have an MPFCU of 4, for example.
    NOTE: It is possible that we may have to revisit this for cases where value is 1 (per-person)
    and could apply to all types of services.
  */
  const maxPaxPerCharge = R.pathOr(null, ['MPFCU'], OptGeneralResult);
  const chargeUnit = R.pathOr(null, ['SCU'], OptGeneralResult);

  return {
    countChildrenInPaxBreak,
    childrenAllowed,
    infantsAllowed,
    countInfantsInPaxBreak,
    duration,
    maxPaxPerCharge,
    chargeUnit,
    dateRanges,
  };
};

/*
  Get date ranges for an option based on start date, charge unit quantity, and room configs.

  @param {string} optionId - The option ID to get information for
  @param {string} hostConnectEndpoint - The HostConnect endpoint
  @param {string} hostConnectAgentID - The agent ID
  @param {string} hostConnectAgentPassword - The agent password
  @param {Object} axios - The axios instance
  @param {string} startDate - The start date
  @param {number} chargeUnitQuantity - The number of charge units
  @param {Object} roomConfigs - The room configurations
  @returns {Object} Object containing general option information
*/
const getOptionDateRanges = async (
  optionId,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
  axios,
  startDate,
  chargeUnitQuantity,
  roomConfigs,
  callTourplan,
) => {
  const getDateRangesModel = checkType => ({
    OptionInfoRequest: {
      Opt: optionId,
      Info: checkType,
      AgentID: hostConnectAgentID,
      Password: hostConnectAgentPassword,
      DateFrom: startDate,
      SCUqty: chargeUnitQuantity,
      RoomConfig: roomConfigs,
    },
  });

  // Use D (Date Ranges) check type to get the option date ranges information
  const replyObj = await callTourplan({
    model: getDateRangesModel('D'),
    endpoint: hostConnectEndpoint,
    axios,
    xmlOptions: hostConnectXmlOptions,
  });
  const DCheck = R.path(['OptionInfoReply', 'Option'], replyObj);
  const OptDateRangesResult = R.pathOr({}, ['OptDateRanges'], DCheck);
  const dateRanges = parseDateRanges(OptDateRangesResult);
  // Sort results in ascending order by startDate
  dateRanges.sort((a, b) => moment(a.startDate).diff(moment(b.startDate)));
  return dateRanges;
};

/*
  Get the past year date range
  @param {string} optionId - The option ID
  @param {string} hostConnectEndpoint - The HostConnect endpoint
  @param {string} hostConnectAgentID - The agent ID
  @param {string} hostConnectAgentPassword - The agent password
  @param {Object} axios - The axios instance
  @param {string} dateToFetchRates - The date to fetch rates from
  @param {number} chargeUnitQuantityToFetchRates - The charge unit quantity to fetch rates from
  @param {Object} roomConfigs - The room configurations
  @param {Object} callTourplan - The callTourplan function
  @returns {Object} The past year date range
*/
const getPastDateRange = async (
  optionId,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
  axios,
  dateToFetchRates,
  chargeUnitQuantityToFetchRates,
  roomConfigs,
  callTourplan,
  noOfPastYears,
  returnLastDateRange,
) => {
  const dateFrom = moment(dateToFetchRates).subtract(noOfPastYears, 'year').format('YYYY-MM-DD');
  const unitQuantity = chargeUnitQuantityToFetchRates || getDaysInYear(dateFrom) * noOfPastYears;
  // go back a year from the start date
  const results = await getOptionDateRanges(
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    dateFrom,
    unitQuantity,
    roomConfigs,
    callTourplan,
  );
  if (results && results.length > 0) {
    if (returnLastDateRange) {
      return results[results.length - 1];
    }

    // Find date range that includes the start date (dateFrom)
    const dateRangeIncludingStartDate = results.find(dateRange => {
      const rangeStart = moment(dateRange.startDate);
      const rangeEnd = moment(dateRange.endDate);
      const targetDate = moment(dateFrom);

      return targetDate.isSameOrAfter(rangeStart) && targetDate.isSameOrBefore(rangeEnd);
    });
    if (dateRangeIncludingStartDate) {
      return dateRangeIncludingStartDate;
    }
  }
  return null;
};

/*
  Get the immediate last date range (could be in future or past)
  1. Query the date ranges from today till the requested end date
  2. If no date range found in future, fetch date ranges from past year
  @param {string} optionId - The option ID
  @param {string} hostConnectEndpoint - The HostConnect endpoint
  @param {string} hostConnectAgentID - The agent ID
  @param {string} hostConnectAgentPassword - The agent password
  @param {Object} axios - The axios instance
  @param {string} endDate - The end date
  @param {Object} roomConfigs - The room configurations
  @param {Object} callTourplan - The callTourplan function
  @returns {Object} The immediate last date range
*/
const getImmediateLastDateRange = async (
  optionId,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
  axios,
  endDate,
  roomConfigs,
  callTourplan,
  extendedBookingYears = 1,
) => {
  // Prevent a very long period by limiting the number of days
  const unitQuantity = Math.min(MAX_EXTENDED_BOOKING_YEARS * 365, moment(endDate).diff(moment(), 'days'));
  const dateFrom = moment().format('YYYY-MM-DD');
  const dateRanges = await getOptionDateRanges(
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    dateFrom,
    unitQuantity,
    roomConfigs,
    callTourplan,
  );

  if (dateRanges && dateRanges.length > 0) {
    return dateRanges[dateRanges.length - 1];
  }

  const returnLastDateRange = true;
  const pastYearDateRange = await getPastDateRange(
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    dateFrom,
    getDaysInYear(dateFrom) * extendedBookingYears,
    roomConfigs,
    callTourplan,
    extendedBookingYears,
    returnLastDateRange,
  );

  return pastYearDateRange;
};

/**
 * Configuration object for custom rate date range retrieval
 * @typedef {Object} CustomRateDateRangeConfig
 * @property {boolean} useLastYearRate - Whether to use last year's rate
 * @property {string} optionId - The option ID
 * @property {string} hostConnectEndpoint - HostConnect endpoint
 * @property {string} hostConnectAgentID - Agent ID
 * @property {string} hostConnectAgentPassword - Agent password
 * @property {Object} axios - Axios instance
 * @property {string} startDate - Start date
 * @property {number} chargeUnitQuantity - Charge unit quantity
 * @property {Object} roomConfigs - Room configurations
 * @property {Function} callTourplan - TourPlan API function
 * @property {string} [endDate] - End date (optional)
 * @property {number} [extendedBookingYears] - Extended booking years (optional)
 */

/**
 * Get the appropriate date range to use for custom rates
 * @param {CustomRateDateRangeConfig} config - Configuration object
 * @returns {Promise<Object>} Date range and error message
 */
const getCustomRateDateRange = async config => {
  // Parameter validation
  if (!config || typeof config !== 'object') {
    console.error('Configuration object is required');
    return { dateRangeToUse: null, errorMsg: 'Configuration object is required' };
  }

  const {
    useLastYearRate,
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    startDate,
    chargeUnitQuantity,
    roomConfigs,
    callTourplan,
    endDate,
    extendedBookingYears,
  } = config;

  // Validate required parameters
  const requiredParams = {
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    startDate,
    chargeUnitQuantity,
    roomConfigs,
    callTourplan,
  };

  const missingParam = Object.keys(requiredParams).find(key =>
    requiredParams[key] === undefined || requiredParams[key] === null);

  if (missingParam) {
    console.error(`Required parameter '${missingParam}' is missing`);
    return { dateRangeToUse: null, errorMsg: `Required parameter '${missingParam}' is missing` };
  }

  let dateRangeToUse = null;
  let errorMsg = '';

  const noOfYears = 1;
  const returnLastDateRange = false;

  if (useLastYearRate) {
    dateRangeToUse = await getPastDateRange(
      optionId,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      startDate,
      chargeUnitQuantity,
      roomConfigs,
      callTourplan,
      noOfYears,
      returnLastDateRange,
    );
    if (!dateRangeToUse) {
      errorMsg = NO_RATE_FOUND_FOR_LAST_YEAR_ERROR_MESSAGE;
    } else {
      const periodEndDate = moment(startDate).add(chargeUnitQuantity - 1, 'days').subtract(noOfYears, 'year');
      if (periodEndDate.isAfter(moment(dateRangeToUse.endDate))) {
        errorMsg = NO_RATE_FOUND_FOR_LAST_YEAR_ERROR_MESSAGE;
        dateRangeToUse = null;
      }
    }
  } else {
    dateRangeToUse = await getImmediateLastDateRange(
      optionId,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      endDate || startDate,
      roomConfigs,
      callTourplan,
      extendedBookingYears,
    );
    if (!dateRangeToUse) {
      // The code should never reach here
      errorMsg = NO_RATE_FOUND_FOR_IMMEDIATE_LAST_DATE_RANGE_ERROR_MESSAGE;
    }
  }

  return { dateRangeToUse, errorMsg };
};

/* Helper function to extract time from datetime string
  @param {string} dateTimeString - The datetime string
  @returns {string} The time string
*/
const extractTimeFromDateTime = dateTimeString => {
  if (!dateTimeString) return null;

  try {
    // Parse the datetime string and extract time in HH:MM format
    const date = new Date(dateTimeString);
    if (Number.isNaN(date.getTime())) {
      // Fallback to string manipulation if Date parsing fails
      const fallbackMsg = `Invalid date format: ${dateTimeString}, falling back to string parsing`;
      console.warn(fallbackMsg);
      const timePart = dateTimeString.split('T')[1];
      if (timePart) {
        // Extract HH:MM from time part, handling various formats
        const timeMatch = timePart.match(/^(\d{2}):(\d{2})/);
        return timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : null;
      }
      return null;
    }

    // Format as HH:MM using proper date methods
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  } catch (error) {
    console.error(`Error parsing datetime: ${dateTimeString}`, error);
    return null;
  }
};

/*
  Get the stay results for an option based on start date, charge unit quantity, and room configs.

  @param {string} optionId - The option ID
  @param {string} hostConnectEndpoint - The HostConnect endpoint
  @param {string} hostConnectAgentID - The agent ID
  @param {string} hostConnectAgentPassword - The agent password
  @param {Object} axios - The axios instance
  @param {string} startDate - The start date
  @param {number} chargeUnitQuantity - The number of charge units
  @param {Object} roomConfigs - The room configurations
  @param {string} displayRateInSupplierCurrency - See the availability rate in the supplier currency
  @returns {Object} The stay results
*/
const getStayResults = async (
  optionId,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
  axios,
  startDate,
  chargeUnitQuantity,
  roomConfigs,
  displayRateInSupplierCurrency,
  callTourplan,
) => {
  // The rate conversion flag:
  //    Y = convert to the currency of the agent, N = show in original currency
  // From TP DOCS:
  //    If the value is Y then all rate information is converted to the currency associated
  //    with the specified agent. If it is false, no rate conversions are performed, and rates
  //    are returned in the currency in which they are stored. If RateConvert is not specified
  //    then whether currency conversion occurs or not is determined by a system default.
  //    Note: has no effect if R or S is not specified in Info.
  const rateConvert = displayRateInSupplierCurrency
    && displayRateInSupplierCurrency.toUpperCase() === 'YES'
    ? 'N'
    : 'Y';
  const getModel = checkType => ({
    OptionInfoRequest: {
      Opt: optionId,
      Info: checkType,
      DateFrom: startDate,
      RateConvert: rateConvert, // for details see comments above
      SCUqty: (() => {
        const num = parseInt(chargeUnitQuantity, 10);
        if (Number.isNaN(num) || num < 1) return 1;
        return num;
      })(),
      RoomConfigs: roomConfigs,
      AgentID: hostConnectAgentID,
      Password: hostConnectAgentPassword,
    },
  });
  // Always use G (General) & S (Stay & Availability) check types
  const replyObj = await callTourplan({
    model: getModel('GS'),
    endpoint: hostConnectEndpoint,
    axios,
    xmlOptions: hostConnectXmlOptions,
  });
  const GSCheck = R.path(['OptionInfoReply', 'Option'], replyObj);
  let OptStayResults = R.pathOr([], ['OptStayResults'], GSCheck);
  if (!Array.isArray(OptStayResults)) OptStayResults = [OptStayResults];
  return OptStayResults;
};

/*
  Get the empty rate object
  @param {string} currency - The currency
  @returns {Object} The empty rate object
*/
const getEmptyRateObject = agentCurrency => {
  const rateObj = [{
    rateId: CUSTOM_NO_RATE_NAME,
    currency: agentCurrency,
    agentCurrency,
    totalPrice: 0,
    costPrice: 0,
    agentPrice: 0,
    currencyPrecision: 2,
    cancelHours: '72',
    externalRateText: '',
    cancelPolicies: [],
    startTimes: [],
    puInfoList: [],
    doInfoList: [],
    additionalDetails: [],
  }];
  return rateObj;
};

/*
  Returns the rates object array after making the markup calculations.

  @param {Object} OptStayResults - The stay results
  @param {number} markupPercentage - The markup percentage
  @param {Object} OptStayResultsExtendedDates - The extended stay results
  @returns {Object} The rates object array
*/
const getRatesObjectArray = (
  OptStayResults,
  conversionRate = 1,
  markupPercentage = 0,
  OptStayResultsExtendedDates = [],
  minStayRequired = 0,
  daysToChargeAtLastRate = 0,
  settings = {},
  noOfDaysRatesAvailable = 0,
) => {
  // Add input validation
  if (!Array.isArray(OptStayResults)) {
    console.error('OptStayResults must be an array');
    return [];
  }

  return OptStayResults.map(rate => {
    // Add null/undefined check for rate object
    if (!rate || typeof rate !== 'object') {
      console.error('Invalid rate object provided');
      return [];
    }

    const {
      costPrice,
      buyCurrency,
      agentCurrency,
      crossSeason,
      isRoundRatesEnabled,
      isRoundToTheNearestDollarEnabled,
    } = settings;

    const rateId = markupPercentage > 0 ? CUSTOM_RATE_ID_NAME : R.path(['RateId'], rate);
    const currency = R.pathOr('', ['Currency'], rate);

    const totalPriceRaw = R.pathOr(0, ['TotalPrice'], rate);
    const agentPriceRaw = R.pathOr(0, ['AgentPrice'], rate);

    // Ensure prices are valid numbers
    const totalPrice = Number(totalPriceRaw);
    const agentPrice = Number(agentPriceRaw);

    let finalTotalPrice = 0;
    let finalAgentPrice = 0;
    let totalCostPrice = 0;
    let markupFactor = 1;

    if (Number.isNaN(totalPrice) || Number.isNaN(agentPrice)) {
      console.error(`Invalid price values: totalPrice=${totalPriceRaw}, agentPrice=${agentPriceRaw}`);
      return [];
    }

    // Get the markup factor
    if (markupPercentage >= MIN_MARKUP_PERCENTAGE && markupPercentage <= MAX_MARKUP_PERCENTAGE) {
      markupFactor = 1 + (Number(markupPercentage) / 100);
    }

    // Apply minimum stay calculation if needed
    const { finalTotalPrice: adjustedTotalPrice, finalAgentPrice: adjustedAgentPrice } =
      calculateRateWithMinStay(totalPrice, agentPrice, minStayRequired, daysToChargeAtLastRate);

    finalTotalPrice = adjustedTotalPrice;
    finalAgentPrice = adjustedAgentPrice;

    // the cost price is always in dollars
    const currencyPrecision = R.pathOr(2, ['currencyPrecision'], rate);
    const divisor = 10 ** currencyPrecision;

    if (noOfDaysRatesAvailable > 0) {
      // Case: Partial rates (some days have rates available & some days don't have rates available)
      const firstRateResult = applyCrossSeasonFirstRate(
        finalTotalPrice,
        finalAgentPrice,
        noOfDaysRatesAvailable,
        daysToChargeAtLastRate,
        crossSeason,
        markupFactor,
      );

      if (firstRateResult) {
        // the cross season is use first rate
        finalTotalPrice = firstRateResult.finalTotalPrice;
        finalAgentPrice = firstRateResult.finalAgentPrice;

        // in this case no markup to be applied to the cost price
        totalCostPrice = costPrice > 0 ? costPrice * divisor : finalTotalPrice;
      // eslint-disable-next-line max-len
      } else if (Array.isArray(OptStayResultsExtendedDates) && OptStayResultsExtendedDates.length > 0) {
        // Handle extended dates with different markup calculation
        const rateOfNoRatesDays = OptStayResultsExtendedDates.find(rate2 =>
          rate2 && rate2.RateId === rate.RateId);

        if (rateOfNoRatesDays) {
          const totalPriceNoRatesDaysRaw = R.pathOr(0, ['TotalPrice'], rateOfNoRatesDays);
          const agentPriceNoRatesDaysRaw = R.pathOr(0, ['AgentPrice'], rateOfNoRatesDays);

          const totalPriceNoRatesDays = Number(totalPriceNoRatesDaysRaw);
          const agentPriceNoRatesDays = Number(agentPriceNoRatesDaysRaw);

          if (!Number.isNaN(totalPriceNoRatesDays) && !Number.isNaN(agentPriceNoRatesDays)) {
            finalTotalPrice = Math.round(finalTotalPrice + (totalPriceNoRatesDays * markupFactor));
            finalAgentPrice = Math.round(finalAgentPrice + (agentPriceNoRatesDays * markupFactor));
          }
        }

        totalCostPrice = costPrice > 0 ? costPrice * divisor * markupFactor : finalTotalPrice;
      }
    } else if (markupFactor > 1) {
      // Case: Rates for NO dates are available
      finalTotalPrice = Math.round(finalTotalPrice * markupFactor);
      finalAgentPrice = Math.round(finalAgentPrice * markupFactor);

      totalCostPrice = costPrice > 0 ? costPrice * divisor * markupFactor : finalTotalPrice;
    }

    // Apply rate rounding if enabled
    const roundingResult = applyRateRounding(
      finalTotalPrice,
      finalAgentPrice,
      totalCostPrice,
      currencyPrecision,
      isRoundRatesEnabled,
      isRoundToTheNearestDollarEnabled,
    );

    finalTotalPrice = roundingResult.finalTotalPrice;
    finalAgentPrice = roundingResult.finalAgentPrice;
    totalCostPrice = roundingResult.totalCostPrice;

    // Cancellations within this number of hours of service date incur a cancellation
    // penalty of some sort.
    const cancelHours = R.pathOr('', ['CancelHours'], rate);

    /* Sample data: for cancel policies for the option id (not the external rate)
      <CancelPolicies>
        <CancelPenalty>
            <Deadline>
              <OffsetUnitMultiplier>168</OffsetUnitMultiplier>
              <OffsetTimeUnit>Hour</OffsetTimeUnit>
              <DeadlineDateTime>2025-07-18T22:00:00Z</DeadlineDateTime>
            </Deadline>
            <InEffect>N</InEffect>
            <LinePrice>1021200</LinePrice>
            <AgentPrice>1021200</AgentPrice>
        </CancelPenalty>
        <CancelPenalty>
            <Deadline>
              <OffsetUnitMultiplier>720</OffsetUnitMultiplier>
              <OffsetTimeUnit>Hour</OffsetTimeUnit>
              <DeadlineDateTime>2025-06-25T22:00:00Z</DeadlineDateTime>
            </Deadline>
            <InEffect>Y</InEffect>
            <LinePrice>204240</LinePrice>
            <AgentPrice>204240</AgentPrice>
        </CancelPenalty>
      </CancelPolicies>
    */
    let cancelPolicies = extractCancelPolicies(rate, ['CancelPolicies', 'CancelPenalty'], true)
      .filter(policy => policy.inEffect === true);

    let externalRateText = R.pathOr('', ['ExternalRateDetails', 'ExtOptionDescr'], rate);
    const extRatePlanDescr = R.pathOr('', ['ExternalRateDetails', 'ExtRatePlanDescr'], rate);
    if (extRatePlanDescr && !externalRateText.includes(extRatePlanDescr)) {
      externalRateText = `${externalRateText} (${extRatePlanDescr})`;
    }

    /* Sample data: For external start times
      <ExternalRateDetails>
        <ExtStartTimes>
          <ExtStartTime>2026-04-01T06:30:00</ExtStartTime>
          <ExtStartTime>2026-04-01T07:30:00</ExtStartTime>
          ...
        </ExtStartTimes>
      </ExternalRateDetails>
    */
    // Extract external start times
    const extStartTimes = (() => {
      // Note: Tourplan expects the start time in HH:MM format, so convert before sending to UI
      const startTimes = R.pathOr([], ['ExternalRateDetails', 'ExtStartTimes', 'ExtStartTime'], rate);
      if (!Array.isArray(startTimes)) {
        // If single item, convert to array
        const timeString = extractTimeFromDateTime(startTimes);
        return timeString ? [{ startTime: timeString }] : [];
      }
      return startTimes
        .map(startTime => extractTimeFromDateTime(startTime))
        .filter(timeString => timeString !== null)
        .map(timeString => ({ startTime: timeString }));
    })();

    /* Sample data: For external pickup and dropoff details
      Address & ExtPointInfo are optional

      <ExternalRateDetails>
        <ExtPickupDetails>
          <ExtPickupDetail>
            <ExtPointName>Adina/Vibe Waterfront</ExtPointName>
            <MinutesPrior>30</MinutesPrior>
            <Address>7 Kitchener Dr, Darwin</Address>
            <ExtPointInfo>Additional Info.</ExtPointInfo>
          </ExtPickupDetail>
          <ExtPickupDetail>
            <ExtPointName>Argus Hotel</ExtPointName>
            <MinutesPrior>30</MinutesPrior>
            <Address>13 Shepherd St, Darwin (Front of Hotel)</Address>
            <ExtPointInfo>Additional Info.</ExtPointInfo>
          </ExtPickupDetail>
          ...
        </ExtDropoffDetails>
      </ExternalRateDetails>
    */
    const extPickupDetails = (() => {
      const pickupDetails = R.pathOr([], ['ExternalRateDetails', 'ExtPickupDetails', 'ExtPickupDetail'], rate);
      if (!Array.isArray(pickupDetails)) {
        // If single item, convert to array
        return pickupDetails ? [pickupDetails] : [];
      }
      return pickupDetails.map(detail => ({
        pointName: R.pathOr('', ['ExtPointName'], detail),
        minutesPrior: R.pathOr('', ['MinutesPrior'], detail),
        address: R.pathOr('', ['Address'], detail),
        pointInfo: R.pathOr('', ['ExtPointInfo'], detail),
      }));
    })();

    const extDropoffDetails = (() => {
      const dropoffDetails = R.pathOr([], ['ExternalRateDetails', 'ExtDropoffDetails', 'ExtDropoffDetail'], rate);
      if (!Array.isArray(dropoffDetails)) {
        // If single item, convert to array
        return dropoffDetails ? [dropoffDetails] : [];
      }
      return dropoffDetails.map(detail => ({
        pointName: R.pathOr('', ['ExtPointName'], detail),
        minutesPrior: R.pathOr('', ['MinutesPrior'], detail),
        address: R.pathOr('', ['Address'], detail),
        pointInfo: R.pathOr('', ['ExtPointInfo'], detail),
      }));
    })();

    /* Sample data: for cancel policies for the external rate
      <ExternalRateDetails>
        <CancelPolicies>
          <CancelPenalty>
            <PenaltyDescription>Cancellation 100% - within 24 hours</PenaltyDescription>
          </CancelPenalty>
          <CancelPenalty>
            <Deadline>
              <OffsetUnitMultiplier>2</OffsetUnitMultiplier>
              <OffsetTimeUnit>Day</OffsetTimeUnit>
            </Deadline>
            <PenaltyDescription>Day Tour Cancellation within 48hrs - 50%</PenaltyDescription>
          </CancelPenalty>
          <CancelPenalty>
            <PenaltyDescription>Day Tour Cancellation within 24hrs - 100%</PenaltyDescription>
          </CancelPenalty>
        </CancelPolicies>
      </ExternalRateDetails>
    */
    if (cancelPolicies.length === 0) {
      // If no cancel policies for the option, check the external rate
      cancelPolicies = extractCancelPolicies(rate, ['ExternalRateDetails', 'CancelPolicies', 'CancelPenalty'], false);
    }
    /* Sample data: For additional details
      <AdditionalDetails>
        <AdditionalDetail>
          <DetailName>Keywords</DetailName>
          <DetailDescription>1|king|bed|classic|non|smoking</DetailDescription>
        </AdditionalDetail>
      </AdditionalDetails>
    */
    const additionalDetails = (() => {
      const addDetails = R.pathOr([], ['ExternalRateDetails', 'AdditionalDetails', 'AdditionalDetail'], rate);
      if (!Array.isArray(addDetails)) {
        // If single item, convert to array
        return addDetails ? [addDetails] : [];
      }
      return addDetails.map(detail => ({
        detailName: R.pathOr('', ['DetailName'], detail),
        detailDescription: R.pathOr('', ['DetailDescription'], detail),
      }));
    })();

    return {
      rateId,
      currency,
      agentCurrency,
      conversionRate,
      totalPrice: finalTotalPrice,
      costPrice: totalCostPrice,
      buyCurrency,
      agentPrice: finalAgentPrice,
      currencyPrecision,
      cancelHours,
      externalRateText,
      cancelPolicies,
      startTimes: extStartTimes,
      puInfoList: extPickupDetails.length ? extPickupDetails : [],
      doInfoList: extDropoffDetails.length ? extDropoffDetails : [],
      additionalDetails,
    };
  });
};

/**
 * Get and prepare availability configuration parameters (General and Date Ranges)
 * @param {Object} params - Configuration parameters
 * @returns {Object} Parsed configuration object
 */
const getAvailabilityConfig = async ({
  optionId,
  startDate,
  chargeUnitQuantity,
  paxConfigs,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
  axios,
  callTourplan,
}) => {
  const optionInfo = await getGeneralAndDateRangesInfo(
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    startDate,
    chargeUnitQuantity,
    callTourplan,
  );
  const {
    countChildrenInPaxBreak,
    childrenAllowed,
    countInfantsInPaxBreak,
    infantsAllowed,
    duration,
    maxPaxPerCharge,
    chargeUnit,
    dateRanges,
  } = optionInfo;

  const modifiedPaxConfigs = getModifiedPaxConfigs(
    countChildrenInPaxBreak,
    childrenAllowed,
    countInfantsInPaxBreak,
    infantsAllowed,
    paxConfigs,
  );
  const roomConfigs = getRoomConfigs(modifiedPaxConfigs, true);

  // Get the end date and message
  const endDate = calculateEndDate(startDate, duration, chargeUnitQuantity);
  const message = getOptionMessage(duration, chargeUnitQuantity, chargeUnit);

  return {
    roomConfigs,
    endDate,
    message,
    dateRanges,
    maxPaxPerCharge,
  };
};

/*
  Returns the no rates available error.If immediate last date range is available:
  1. returns the error message with the last date range end date
  2. else returns generic availability check error message

  @param {Object} params - Configuration parameters
  @param {string} optionId - The option ID
  @param {string} hostConnectEndpoint - The HostConnect endpoint
  @param {string} hostConnectAgentID - The agent ID
  @param {string} hostConnectAgentPassword - The agent password
  @param {Object} axios - The axios instance
  @param {string} endDate - The end date
  @param {Object} roomConfigs - The room configurations
  @param {Object} callTourplan - The callTourplan function
  @returns {Object} Parsed configuration object
*/
const getNoRatesAvailableError = async ({
  optionId,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
  axios,
  endDate,
  roomConfigs,
  callTourplan,
}) => {
  let errorMessage = GENERIC_AVALABILITY_CHK_ERROR_MESSAGE;
  const immediateLastDateRange = await getImmediateLastDateRange(
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    endDate,
    roomConfigs,
    callTourplan,
  );
  const dateTill = immediateLastDateRange ? immediateLastDateRange.endDate : null;
  if (dateTill) {
    const formattedDateTill = moment(dateTill).format(USER_FRIENDLY_DATE_FORMAT);
    errorMessage = RATES_AVAILABLE_TILL_ERROR_TEMPLATE.replace('{dateTill}', formattedDateTill);
  }
  return {
    bookable: false,
    type: 'inventory',
    rates: [],
    message: errorMessage,
  };
};

// Get agent currency code from cache or fetch it
const getAgentCurrencyCode = async ({
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
  axios,
  callTourplan,
  cache,
}) => {
  if (cache && cache.getOrExec) {
    try {
      const sanitizedHostConnectEndpoint = hostConnectEndpoint.replace(/[^a-zA-Z0-9]/g, '');
      const sensitiveKey = `${hostConnectAgentID}|${hostConnectAgentPassword}|${sanitizedHostConnectEndpoint}`;
      const cacheKey = `agentCurrencyCode_${crypto.createHash('sha256').update(sensitiveKey).digest('hex').slice(0, 16)}`;
      const model = {
        AgentInfoRequest: {
          AgentID: hostConnectAgentID,
          Password: hostConnectAgentPassword,
        },
      };

      const replyObj = await cache.getOrExec({
        fnParams: [cacheKey],
        fn: () => callTourplan({
          model,
          endpoint: hostConnectEndpoint,
          axios,
          xmlOptions: hostConnectXmlOptions,
        }),
        ttl: 60 * 60 * 24 * 7, // 7 days
      });
      const agentCurrencyCode = R.path(['AgentInfoReply', 'Currency'], replyObj);
      return agentCurrencyCode;
    } catch (cacheErr) {
      console.warn('WARNING: Cache read error:', cacheErr.message);
    }
  }
  return null;
};

/*
  This method return the conversion rate to convert from supplier currency
  to the agent currency. This is done by fetching the rates in the agent currency
  and then dividing it by the total price of the rates in the supplier currency

  NOTE: The hostconnect Extensions do have an API (GetCurrencyConversionsRequest)
  to get the conversion rate, but it is not used here because it is not efficient.
  It return all the conversion rates with different date ranges etc. It could be
  a very large XML with more than 41K lines. The method below is one additonal
  call but it will always get the current conversion rate and more efficiently.

  @param {Object} OptStayResultsInSupplierCurrency - The stay results in the supplier currency
  @param {string} optionId - The option ID
  @param {string} hostConnectEndpoint - The HostConnect endpoint
  @param {string} hostConnectAgentID - The agent ID
  @param {string} hostConnectAgentPassword - The agent password
  @param {Object} axios - The axios instance
  @param {string} startDate - The start date
  @param {number} noOfDaysRatesAvailable - The number of days rates available
  @param {Object} roomConfigs - The room configurations
  @param {Object} callTourplan - The callTourplan function
  @returns {number} The conversion rate
*/
const getConversionRate = async ({
  OptStayResultsInSupplierCurrency,
  optionId,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
  axios,
  startDate,
  noOfDaysRatesAvailable,
  roomConfigs,
  callTourplan,
}) => {
  let conversionRate = 1;

  if (OptStayResultsInSupplierCurrency.length === 0) {
    return conversionRate;
  }
  const OptStayResultsInAgentCurrency = await getStayResults(
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    startDate,
    noOfDaysRatesAvailable,
    roomConfigs,
    'No', // fetch the rates in the agent currency
    callTourplan,
  );
  const SCheckPassInAgentCurrency = Boolean(OptStayResultsInAgentCurrency.length);
  if (!SCheckPassInAgentCurrency) {
    return conversionRate;
  }
  if (OptStayResultsInSupplierCurrency.length > 0) {
    const rate = OptStayResultsInSupplierCurrency[0];
    const totalPrice = Number(R.pathOr(0, ['TotalPrice'], rate));
    const rateGetInAgentCurrency = OptStayResultsInAgentCurrency.find(rate2 =>
      rate2 && rate2.RateId === rate.RateId);
    const totalPriceGetInAgentCurrency = Number(R.pathOr(0, ['TotalPrice'], rateGetInAgentCurrency));
    conversionRate = totalPrice > 0 && totalPriceGetInAgentCurrency > 0
      ? totalPrice / totalPriceGetInAgentCurrency : 1;
    // Round to 3 decimal places
    conversionRate = Math.round(conversionRate * 1000) / 1000;
  }

  return conversionRate;
};

/**
 * Create day mapping for a rate set
 * @param {Object} rateSet - The rate set object
 * @returns {Object} Day mapping object
 */
const createDayMapping = rateSet => ({
  [DAY_OF_WEEK.SUNDAY]: rateSet.applySun,
  [DAY_OF_WEEK.MONDAY]: rateSet.applyMon,
  [DAY_OF_WEEK.TUESDAY]: rateSet.applyTue,
  [DAY_OF_WEEK.WEDNESDAY]: rateSet.applyWed,
  [DAY_OF_WEEK.THURSDAY]: rateSet.applyThu,
  [DAY_OF_WEEK.FRIDAY]: rateSet.applyFri,
  [DAY_OF_WEEK.SATURDAY]: rateSet.applySat,
});

/**
 * Filter date ranges that contain the given date
 * @param {Array} dateRanges - Array of date ranges
 * @param {moment.Moment} targetDate - The target date to check
 * @returns {Array} Filtered date ranges
 */
const filterDateRangesContainingDate = (dateRanges, targetDate) => dateRanges.filter(dateRange => {
  const rangeStartDate = moment(dateRange.startDate);
  const rangeEndDate = moment(dateRange.endDate);
  return targetDate.isBetween(rangeStartDate, rangeEndDate, null, '[]');
});

/**
 * Get valid days from rate sets for the given current day of week
 * @param {Array} dateRanges - Filtered date ranges
 * @param {number} currentDayOfWeek - Current day of week (0-6)
 * @returns {Array} Valid days of week
 */
const getValidDaysFromRateSets = (dateRanges, currentDayOfWeek) => dateRanges.map(dateRange => {
  if (!dateRange.rateSets) return [];

  return dateRange.rateSets.map(rateSet => {
    const dayMapping = createDayMapping(rateSet);

    // Filter to only include days that are true and >= current day
    const validDays = Object.fromEntries(
      Object.entries(dayMapping).filter(([day, isApplicable]) =>
        isApplicable === true && parseInt(day, 10) >= currentDayOfWeek),
    );

    return validDays;
  });
});

/**
 * Extract the next valid day from the nested valid days structure
 * @param {Array} validDaysOfWeek - Nested array of valid days
 * @returns {number|null} Next valid day of week or null if none found
 */
const extractNextValidDay = validDaysOfWeek => {
  if (!validDaysOfWeek || validDaysOfWeek.length === 0) {
    return null;
  }

  // Get the first dateRange's rateSets
  const firstDateRangeRateSets = validDaysOfWeek[0];
  if (!firstDateRangeRateSets || firstDateRangeRateSets.length === 0) {
    return null;
  }

  // Get the first rateSet's filtered day mapping
  const firstRateSetDays = firstDateRangeRateSets[0];
  if (!firstRateSetDays || Object.keys(firstRateSetDays).length === 0) {
    return null;
  }

  // Get the first valid day number (convert string key to number)
  const firstValidDayStr = Object.keys(firstRateSetDays)[0];
  return parseInt(firstValidDayStr, 10);
};

/**
 * Find the next valid date based on rateset day-of-week criteria
 * @param {string} startDate - The initial start date in YYYY-MM-DD format
 * @param {Array} dateRanges - Array of date ranges with rateSets
 * @returns {string} The next valid date in YYYY-MM-DD format
 */
const findNextValidDate = (startDate, dateRanges) => {
  // Parameter validation
  if (!startDate || typeof startDate !== 'string') {
    console.error('startDate must be a non-empty string');
    return null;
  }

  if (!Array.isArray(dateRanges)) {
    console.error('dateRanges must be an array');
    return null;
  }

  const nextValidDate = moment(startDate);

  // Validate date format
  if (!nextValidDate.isValid()) {
    console.error('startDate must be a valid date string');
    return null;
  }

  const currentDayOfWeek = nextValidDate.day();

  // Filter date ranges to only include those containing the target date
  const filteredDateRanges = filterDateRangesContainingDate(dateRanges, nextValidDate);

  // Get valid days from rate sets
  const validDaysOfWeek = getValidDaysFromRateSets(filteredDateRanges, currentDayOfWeek);

  // Extract the next valid day
  const nextValidDay = extractNextValidDay(validDaysOfWeek);

  // Calculate and return the next valid date
  if (nextValidDay !== null) {
    const daysToAdd = nextValidDay - currentDayOfWeek;
    nextValidDate.add(daysToAdd, 'day');
  }

  return nextValidDate.format('YYYY-MM-DD');
};

module.exports = {
  getAgentCurrencyCode,
  getAvailabilityConfig,
  getNoRatesAvailableError,
  getStayResults,
  getImmediateLastDateRange,
  getCustomRateDateRange,
  getPastDateRange,
  getRatesObjectArray,
  getOptionDateRanges,
  getEmptyRateObject,
  getConversionRate,
  findNextValidDate,
  // Constants
  MIN_MARKUP_PERCENTAGE,
  MAX_MARKUP_PERCENTAGE,
  MIN_EXTENDED_BOOKING_YEARS,
  MAX_EXTENDED_BOOKING_YEARS,
};
