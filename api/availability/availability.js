const moment = require('moment');

const {
  validateMaxPaxPerCharge,
  validateDateRanges,
} = require('./availability-utils');

const {
  getAvailabilityConfig,
  getNoRatesAvailableError,
  getStayResults,
  getImmediateLastDateRange,
  getRatesObjectArray,
  MIN_MARKUP_PERCENTAGE,
  MAX_MARKUP_PERCENTAGE,
  MIN_EXTENDED_BOOKING_YEARS,
  MAX_EXTENDED_BOOKING_YEARS,
} = require('./availability-helper');

const DEFAULT_CUSTOM_RATE_MARKUP_PERCENTAGE = 0;
const DEFAULT_CUSTOM_RATES_EXTENDED_BOOKING_YEARS = 2;
const GENERIC_AVALABILITY_CHK_ERROR_MESSAGE = 'Not bookable for the requested date/stay. (e.g. no rates, block out period, on request, minimum stay etc.)';
const EXTENDED_BOOKING_YEARS_ERROR_TEMPLATE = 'Last available rate until: {lastRateEndDate}. Custom rates can only be extended by {extendedBookingYears} year(s), please change the date and try again.';

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

  console.log('SACHIN useLastYearRate', useLastYearRate);
  console.log('SACHIN markupPercentage', markupPercentage);
  console.log('SACHIN extendedBookingYears', extendedBookingYears);
  console.log('SACHIN isBookingForCustomRatesEnabled', isBookingForCustomRatesEnabled);

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

  const ratesRequiredTillDate = moment(startDate).add(chargeUnitQuantity - 1, 'days').format('YYYY-MM-DD');
  const lastDateRangeEndDate = dateRanges.length > 0 ? moment(dateRanges[dateRanges.length - 1].endDate) : null; // eslint-disable-line max-len
  const atLeastOneDateDoesNotHaveRatesAvailable = dateRanges.length === 0 ||
    (lastDateRangeEndDate && lastDateRangeEndDate.isBefore(ratesRequiredTillDate));
  if (atLeastOneDateDoesNotHaveRatesAvailable) {
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

    // Step1 : Get rates for the days that have rates available
    const noOfDaysRatesAvailable = lastDateRangeEndDate ? lastDateRangeEndDate.diff(moment(startDate), 'days') + 1 : 0;
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

    // Step2 : Get rates for the days that do not have any rates available
    // This is done by getting the past rates based on the useLastYearRate flag.
    // If true use last year's rates, otherwise use last available rates.
    let pastDateAsStartDate = moment(startDate).subtract(1, 'year').format('YYYY-MM-DD');
    if (!useLastYearRate) {
      const immediateLastDateRange = await getImmediateLastDateRange(
        optionId,
        hostConnectEndpoint,
        hostConnectAgentID,
        hostConnectAgentPassword,
        axios,
        endDate || startDate,
        roomConfigs,
        callTourplan,
      );
      if (!immediateLastDateRange) {
        // If no immediate last date range found, return error
        return {
          bookable: false,
          type: 'inventory',
          rates: [],
          message: GENERIC_AVALABILITY_CHK_ERROR_MESSAGE,
        };
      }

      // If immediate last date range found, use the last rate's start date
      pastDateAsStartDate = immediateLastDateRange.startDate;

      // Check if the start date is beyond the permitted future booking years
      const extendedBookingPermittedDate = moment(immediateLastDateRange.endDate).add(extendedBookingYears, 'years').format('YYYY-MM-DD');
      const periodEndDate = moment(startDate).add(chargeUnitQuantity - 1, 'days');
      if (moment(startDate).isAfter(extendedBookingPermittedDate) ||
            periodEndDate.isAfter(extendedBookingPermittedDate)) {
        return {
          bookable: false,
          type: 'inventory',
          rates: [],
          message: EXTENDED_BOOKING_YEARS_ERROR_TEMPLATE.replace('{lastRateEndDate}', immediateLastDateRange.endDate).replace('{extendedBookingYears}', extendedBookingYears),
        };
      }
    }

    // Format the success message for the custom rates
    const customPeriodInfoMsg = useLastYearRate ? 'last year\'s rate.' : 'last available rate.';
    const customRateInfoMsg = markupPercentage > 0 ? `Custom rate applied, calculated using a markup on ${customPeriodInfoMsg}` : `Custom rate applied with no markup on ${customPeriodInfoMsg}`;
    const successMessage = message ? `${message}. ${customRateInfoMsg}` : `${customRateInfoMsg}`;

    // Calculate the number of days to charge at the last rate
    const daysToChargeAtLastRate = noOfDaysRatesAvailable > 0
      ? chargeUnitQuantity - noOfDaysRatesAvailable : chargeUnitQuantity;

    // Get stay rates
    let OptStayResultsExtendedDates = await getStayResults(
      optionId,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      pastDateAsStartDate,
      daysToChargeAtLastRate,
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
        rates: getRatesObjectArray(OptStayResults, markupPercentage, OptStayResultsExtendedDates),
      };
    }
    return {
      bookable: false,
      type: 'inventory',
      rates: [],
      message: GENERIC_AVALABILITY_CHK_ERROR_MESSAGE,
    };
  }

  // Validate date ranges and room configurations
  const dateRangesError = validateDateRanges({
    dateRanges,
    startDate,
    chargeUnitQuantity,
  });

  if (dateRangesError) {
    return dateRangesError;
  }

  // Get stay rates for the given dates
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
};

module.exports = {
  searchAvailabilityForItinerary,
};
