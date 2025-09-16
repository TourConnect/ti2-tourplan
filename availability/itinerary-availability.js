const moment = require('moment');

const {
  validateMaxPaxPerCharge,
  validateDateRanges,
} = require('./itinerary-availability-utils');

const {
  getAvailabilityConfig,
  getNoRatesAvailableError,
  getStayResults,
  getImmediateLastDateRange,
  getPastYearDateRange,
  getRatesObjectArray,
  MIN_MARKUP_PERCENTAGE,
  MAX_MARKUP_PERCENTAGE,
  MIN_EXTENDED_BOOKING_YEARS,
  MAX_EXTENDED_BOOKING_YEARS,
} = require('./itinerary-availability-helper');

const DEFAULT_CUSTOM_RATE_MARKUP_PERCENTAGE = 0;
const DEFAULT_CUSTOM_RATES_EXTENDED_BOOKING_YEARS = 2;
const CUSTOM_PERIOD_LAST_AVAILABLE_INFO_MSG = 'last available rate.';
const CUSTOM_PERIOD_LAST_YEAR_INFO_MSG = 'last year\'s rate.';
const CUSTOM_RATE_WITHMARKUP_INFO_MSG = 'Custom rate applied, calculated using a markup on {customPeriodInfoMsg} {sWarningMsg}';
const CUSTOM_RATE_NO_MARKUP_INFO_MSG = 'Custom rate applied with no markup on {customPeriodInfoMsg} {sWarningMsg}';
const GENERIC_AVALABILITY_CHK_ERROR_MESSAGE = 'Not bookable for the requested date/stay. (e.g. no rates, block out period, on request, minimum stay etc.)';
const EXTENDED_BOOKING_YEARS_ERROR_TEMPLATE = 'Last available rate until: {lastRateEndDate}. Custom rates can only be extended by {extendedBookingYears} year(s), please change the date and try again.';
const MIN_STAY_WARNING_MESSAGE = 'Please note that the previous rate had a minimum stay requirement of  {minSCU}.';
const PREVIOUS_RATE_CLOSED_PERIODS_WARNING_MESSAGE = 'Not bookable for the requested date/stay using {customPeriodInfoMsg} {closedDateRanges}';
const NO_RATE_FOUND_FOR_LAST_YEAR_ERROR_MESSAGE = 'No rates found for the last year';
const NO_RATE_FOUND_FOR_IMMEDIATE_LAST_DATE_RANGE_ERROR_MESSAGE = 'No rates found for the immediate last date range';

const doAllDatesHaveRatesAvailable = (lastDateRangeEndDate, startDate, chargeUnitQuantity) => {
  const ratesRequiredTillDate = moment(startDate).add(chargeUnitQuantity - 1, 'days').format('YYYY-MM-DD');
  // eslint-disable-next-line max-len
  const atLeastOneDateDoesNotHaveRatesAvailable = lastDateRangeEndDate.isBefore(ratesRequiredTillDate);
  return !atLeastOneDateDoesNotHaveRatesAvailable;
};

const searchAvailabilityForItinerary = async ({
  axios,
  token: {
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    displayRateInSupplierCurrency,
    customRatesEnableForQuotesAndBookings,
    customRatesMarkupPercentage,
    customRatesCalculateWithLastYearsRate,
    customRatesExtendedBookingYears,
  },
  payload: {
    optionId,
    startDate,
    /*
    paxConfigs: [{ roomType: 'DB', adults: 2 }, { roomType: 'TW', children: 2 }]
    */
    paxConfigs,
    // passengers,
    /*
      The number of second charge units required (second charge units are discussed
      in the OptionInfo section). Should only be specified for options that have SCUs.
      Defaults to 1.
    */
    chargeUnitQuantity,
  },
  callTourplan,
}) => {
  // Get application configuration parameters for custom rates
  const isBookingForCustomRatesEnabled = !!(
    customRatesEnableForQuotesAndBookings
    && customRatesEnableForQuotesAndBookings.toUpperCase() === 'YES'
  );
  const useLastYearRate = !!(
    customRatesCalculateWithLastYearsRate
    && customRatesCalculateWithLastYearsRate.toUpperCase() === 'YES'
  );
  // Assign default values when parameters are empty, null, undefined,
  // or not a valid number between MIN_MARKUP_PERCENTAGE-MAX_MARKUP_PERCENTAGE
  const markupPercentage = (() => {
    const numValue = customRatesMarkupPercentage
      ? Number(customRatesMarkupPercentage)
      : DEFAULT_CUSTOM_RATE_MARKUP_PERCENTAGE;
    return (numValue >= MIN_MARKUP_PERCENTAGE && numValue <= MAX_MARKUP_PERCENTAGE)
      ? numValue
      : DEFAULT_CUSTOM_RATE_MARKUP_PERCENTAGE;
  })();
  // Assign default values when parameters are empty, null, undefined,
  // or not a valid number between MIN_EXTENDED_BOOKING_YEARS-MAX_EXTENDED_BOOKING_YEARS
  const extendedBookingYears = (() => {
    const years = customRatesExtendedBookingYears
      ? Number(customRatesExtendedBookingYears)
      : DEFAULT_CUSTOM_RATES_EXTENDED_BOOKING_YEARS;
    return (years >= MIN_EXTENDED_BOOKING_YEARS && years <= MAX_EXTENDED_BOOKING_YEARS)
      ? years
      : DEFAULT_CUSTOM_RATES_EXTENDED_BOOKING_YEARS;
  })();

  // Get availability configuration parameters from Tourplan(General and Date Ranges)
  const availabilityConfig = await getAvailabilityConfig({
    optionId,
    startDate,
    chargeUnitQuantity,
    paxConfigs,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    callTourplan,
  });

  const {
    roomConfigs,
    endDate,
    message,
    dateRanges,
    maxPaxPerCharge,
  } = availabilityConfig;

  // Validate max pax per charge
  const maxPaxPerChargeError = validateMaxPaxPerCharge({
    roomConfigs,
    maxPaxPerCharge,
  });
  if (maxPaxPerChargeError) {
    return maxPaxPerChargeError;
  }

  let noOfDaysRatesAvailable = 0;
  let allDatesHaveRatesAvailable = false;

  if (dateRanges.length > 0) {
    const lastDateRangeEndDate = moment(dateRanges[dateRanges.length - 1].endDate);
    noOfDaysRatesAvailable = lastDateRangeEndDate.diff(moment(startDate), 'days') + 1;
    // eslint-disable-next-line max-len
    allDatesHaveRatesAvailable = doAllDatesHaveRatesAvailable(lastDateRangeEndDate, startDate, chargeUnitQuantity);
  }

  if (allDatesHaveRatesAvailable) {
    // all dates have rates available get stay rates for the given dates
    const dateRangesError = validateDateRanges({
      dateRanges,
      startDate,
      chargeUnitQuantity,
    });

    if (dateRangesError) {
      return dateRangesError;
    }

    // get stay rates for the given dates
    const OptStayResults = await getStayResults(
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
    );

    const SCheckPass = Boolean(OptStayResults.length);
    return {
      bookable: Boolean(SCheckPass),
      type: 'inventory',
      ...(endDate && SCheckPass ? { endDate } : {}),
      ...(message && SCheckPass ? { message } : {}),
      rates: getRatesObjectArray(OptStayResults),
    };
  }

  // At least one date does not have rates available.
  if (!isBookingForCustomRatesEnabled) {
    // If custom rates are not enabled, return error
    return getNoRatesAvailableError({
      optionId,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      endDate: endDate || startDate,
      roomConfigs,
      callTourplan,
    });
  }

  // Custom Rates are Enabled
  // Step1 : Get date range to use for the days that do not have any rates available
  // This is done by getting the past rates based on the useLastYearRate flag.
  // If true use last year's rates, otherwise use last available rates.
  let dateRangeToUse = null;
  let errorMsg = '';

  if (useLastYearRate) {
    dateRangeToUse = await getPastYearDateRange(
      optionId,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      startDate,
      chargeUnitQuantity,
      roomConfigs,
      callTourplan,
    );
    errorMsg = NO_RATE_FOUND_FOR_LAST_YEAR_ERROR_MESSAGE;
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
    );
    errorMsg = NO_RATE_FOUND_FOR_IMMEDIATE_LAST_DATE_RANGE_ERROR_MESSAGE;
  }
  if (!dateRangeToUse) {
    // no date range to use, return error
    return {
      bookable: false,
      type: 'inventory',
      rates: [],
      message: errorMsg,
    };
  }
  console.log('dateRangeToUse: ', dateRangeToUse);

  // Check if the start date of the date range to use is beyond the permitted future booking years
  const extendedBookingPermittedDate = moment(dateRangeToUse.endDate).add(extendedBookingYears, 'years').format('YYYY-MM-DD');
  const periodEndDate = moment(startDate).add(chargeUnitQuantity - 1, 'days');
  if (moment(startDate).isAfter(extendedBookingPermittedDate) ||
        periodEndDate.isAfter(extendedBookingPermittedDate)) {
    return {
      bookable: false,
      type: 'inventory',
      rates: [],
      message: EXTENDED_BOOKING_YEARS_ERROR_TEMPLATE.replace('{lastRateEndDate}', dateRangeToUse.endDate).replace('{extendedBookingYears}', extendedBookingYears),
    };
  }

  // eslint-disable-next-line max-len
  const customPeriodInfoMsg = useLastYearRate ? CUSTOM_PERIOD_LAST_YEAR_INFO_MSG : CUSTOM_PERIOD_LAST_AVAILABLE_INFO_MSG;

  // Validate date ranges and room configurations
  const dateRangesError = validateDateRanges({
    dateRanges: [dateRangeToUse],
    startDate: dateRangeToUse.startDate,
    chargeUnitQuantity,
  });

  let sWarningMsg = '';
  let minStayRequired = 0;
  if (dateRangesError) {
    if (dateRangesError.message.includes('minimum stay')) {
      // If minimum stay error, return availability with a warning message
      minStayRequired = dateRangeToUse.minSCU;
      sWarningMsg = MIN_STAY_WARNING_MESSAGE.replace('{minSCU}', dateRangeToUse.minSCU);
    } else if (dateRangesError.message.includes('rates are closed')) {
      // If rates are closed, return an error message
      return {
        bookable: false,
        type: 'inventory',
        rates: [],
        message: PREVIOUS_RATE_CLOSED_PERIODS_WARNING_MESSAGE.replace('{customPeriodInfoMsg}', customPeriodInfoMsg).replace('{closedDateRanges}', dateRangesError.message),
      };
    }
  }

  // Format the success message for the custom rates
  const customRateInfoMsg = markupPercentage > 0
    ? CUSTOM_RATE_WITHMARKUP_INFO_MSG.replace('{customPeriodInfoMsg}', customPeriodInfoMsg).replace('{sWarningMsg}', sWarningMsg)
    : CUSTOM_RATE_NO_MARKUP_INFO_MSG.replace('{customPeriodInfoMsg}', customPeriodInfoMsg).replace('{sWarningMsg}', sWarningMsg);
  const successMessage = message ? `${message}. ${customRateInfoMsg}` : `${customRateInfoMsg}`;

  // Step1 : Get rates for the days that have rates available
  let OptStayResults = [];
  // Get stay rates for the given dates
  if (noOfDaysRatesAvailable > 0) {
    OptStayResults = await getStayResults(
      optionId,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      startDate,
      noOfDaysRatesAvailable,
      roomConfigs,
      displayRateInSupplierCurrency,
      callTourplan,
    );
    const SCheckPass = Boolean(OptStayResults.length);
    if (!SCheckPass) {
      return {
        bookable: Boolean(SCheckPass),
        type: 'inventory',
        rates: [],
        message: GENERIC_AVALABILITY_CHK_ERROR_MESSAGE,
      };
    }
  }

  // Calculate the number of days to charge at the last rate
  const daysToChargeAtLastRate = noOfDaysRatesAvailable > 0
    ? chargeUnitQuantity - noOfDaysRatesAvailable : chargeUnitQuantity;

  if (daysToChargeAtLastRate > 0) {
    // Get stay rates
    let OptStayResultsExtendedDates = await getStayResults(
      optionId,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      dateRangeToUse.startDate,
      Math.max(daysToChargeAtLastRate, minStayRequired),
      roomConfigs,
      displayRateInSupplierCurrency,
      callTourplan,
    );
    const SCheckPass = Boolean(OptStayResultsExtendedDates.length);
    if (SCheckPass) {
      if (OptStayResults.length === 0) {
        OptStayResults = OptStayResultsExtendedDates;
        OptStayResultsExtendedDates = [];
      }
      return {
        bookable: Boolean(SCheckPass),
        type: 'inventory',
        ...(endDate && SCheckPass ? { endDate } : {}),
        ...(successMessage && SCheckPass ? { message: successMessage } : {}),
        rates: getRatesObjectArray(
          OptStayResults,
          markupPercentage,
          OptStayResultsExtendedDates,
          minStayRequired,
          daysToChargeAtLastRate,
        ),
      };
    }
  }
  return {
    bookable: false,
    type: 'inventory',
    rates: [],
    message: GENERIC_AVALABILITY_CHK_ERROR_MESSAGE,
  };
};

module.exports = {
  searchAvailabilityForItinerary,
};
