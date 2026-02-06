const moment = require('moment');

const {
  validateMaxPaxPerCharge,
  validateDateRanges,
  validateStartDay,
  getMatchingRateSet,
} = require('./itinerary-availability-utils');

const {
  validateProductConnect,
} = require('./product-connect/itinerary-pc-api-validation-helper');

const {
  getAgentCurrencyCode,
  getConversionRate,
  findNextValidDate,
} = require('./itinerary-availability-helper');

const {
  getAvailabilityConfig,
  getNoRatesAvailableError,
  getStayResults,
  getCustomRateDateRange,
  getRatesObjectArray,
  getEmptyRateObject,
  MIN_MARKUP_PERCENTAGE,
  MAX_MARKUP_PERCENTAGE,
  MIN_EXTENDED_BOOKING_YEARS,
  MAX_EXTENDED_BOOKING_YEARS,
  GENERIC_AVALABILITY_CHK_ERROR_MESSAGE,
} = require('./itinerary-availability-helper');

const {
  getCostFromProductConnect,
} = require('./product-connect/itinerary-pc-rates-helper');

const {
  getOptionFromProductConnect,
  CROSS_SEASON_NOT_ALLOWED,
  CROSS_SEASON_CAL_SPLIT_RATE,
  CROSS_SEASON_CAL_USING_RATE_OF_FIRST_RATE_PERIOD,
} = require('./product-connect/itinerary-pc-option-helper');

const MIN_STAY_WARNING_MESSAGE = 'Please note that the a minimum stay requirement of {minSCU} was required for {customPeriodInfoMsg}';
const PREVIOUS_RATE_CLOSED_PERIODS_ERROR_MESSAGE = 'Not bookable for the requested date/stay using {customPeriodInfoMsg} {closedDateRanges}';
const INVALID_DAY_OF_WEEK_ERROR_TEMPLATE = 'The start date day can only be on {allowedDays}. Please try again with the allowed day.';
const INVALID_DAY_OF_WEEK_WARNING_TEMPLATE = 'Please note that start day of {allowedDays} was required in the {customPeriodInfoMsg}';

const DEFAULT_CUSTOM_RATE_MARKUP_PERCENTAGE = 0;
const DEFAULT_CUSTOM_RATES_EXTENDED_BOOKING_YEARS = 2;
const CUSTOM_PERIOD_LAST_AVAILABLE_INFO_MSG = 'last available rate.';
const CUSTOM_PERIOD_LAST_YEAR_INFO_MSG = 'last year\'s rate.';
const CUSTOM_RATE_WITHMARKUP_INFO_MSG = 'Custom rate applied, calculated using a markup on {customPeriodInfoMsg} {sWarningMsg}';
const CUSTOM_RATE_NO_MARKUP_INFO_MSG = 'Custom rate applied with no markup on {customPeriodInfoMsg} {sWarningMsg}';
const EXTENDED_BOOKING_YEARS_ERROR_TEMPLATE = 'Last available rate until: {lastRateEndDate}. Custom rates can only be extended by {extendedBookingYears} year(s), please change the date and try again.';
const SERVICE_WITHOUT_A_RATE_APPLIED_WARNING_MESSAGE = 'No rates available for the requested date/stay. Rates will be sent as 0.00 per your company settings.';
const CROSS_SEASON_NOT_ALLOWED_ERROR_MESSAGE = 'Cross season is not allowed for this option. Please select another rate or option and try again.';
const PRODUCT_CONNECT_OPTION_INFO_ERROR_MESSAGE = 'Error getting option info from Product Connect. Check Product Connect credentials and try again.';

const doAllDatesHaveRatesAvailable = (lastDateRangeEndDate, startDate, chargeUnitQuantity) => {
  const ratesRequiredTillDate = moment(startDate).add(chargeUnitQuantity - 1, 'days').format('YYYY-MM-DD');
  // eslint-disable-next-line max-len
  const atLeastOneDateDoesNotHaveRatesAvailable = lastDateRangeEndDate.isBefore(ratesRequiredTillDate);
  return !atLeastOneDateDoesNotHaveRatesAvailable;
};

const returnEmptyRatesOrError = (allowSendingServicesWithoutARate, agentCurrencyCode, errorMsg) => {
  // if sending services without a rate is enabled return empty rates (0.00)
  if (allowSendingServicesWithoutARate && agentCurrencyCode) {
    return {
      bookable: true,
      type: 'inventory',
      rates: getEmptyRateObject(agentCurrencyCode.toUpperCase()),
      message: SERVICE_WITHOUT_A_RATE_APPLIED_WARNING_MESSAGE,
    };
  }

  // return generic error - failed to get rates for an avaialble date range
  // and sending services without a rate is not enabled
  return {
    bookable: false,
    type: 'inventory',
    rates: [],
    message: errorMsg,
  };
};

const searchAvailabilityForItinerary = async ({
  axios,
  token: {
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    productConnectEndpoint,
    productConnectUser,
    productConnectUserPassword,
    displayRateInSupplierCurrency,
    customRatesEnableForQuotesAndBookings,
    customRatesMarkupPercentage,
    customRatesCalculateWithLastYearsRate,
    customRatesExtendedBookingYears,
    customRatesEligibleRateTypes,
    customRatesRoundRates,
    customRatesRoundToTheNearestDollar,
    sendServicesWithoutARate,
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
  cache,
}) => {
  // Get agent currency code & cache it
  const agentCurrencyCode = await getAgentCurrencyCode({
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    callTourplan,
    cache,
  });

  // Validate product connect credentials and cache the result
  const isProductConnectAvailable = await validateProductConnect({
    productConnectEndpoint,
    productConnectUser,
    productConnectUserPassword,
    axios,
    callTourplan,
    cache,
    useCache: true,
  });

  // Get application configuration parameters for custom rates
  const isBookingForCustomRatesEnabled = !!(
    customRatesEnableForQuotesAndBookings
    && customRatesEnableForQuotesAndBookings.toUpperCase() === 'YES'
  );
  const useLastYearRate = !!(
    customRatesCalculateWithLastYearsRate
    && customRatesCalculateWithLastYearsRate.toUpperCase() === 'YES'
  );
  const allowSendingServicesWithoutARate = !!(
    sendServicesWithoutARate
    && sendServicesWithoutARate.toUpperCase() === 'YES'
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
  const isRoundRatesEnabled = !!(
    customRatesRoundRates
    && customRatesRoundRates.toUpperCase() === 'YES'
  );
  // Yes to round to the nearest dollar, No to round UP to the next dollar
  const isRoundToTheNearestDollarEnabled = !!(
    customRatesRoundToTheNearestDollar
    && customRatesRoundToTheNearestDollar.toUpperCase() === 'YES'
  );

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
    const startDateIsInvalid = validateStartDay({
      dateRanges,
      startDate,
      endDate,
    });
    if (startDateIsInvalid) {
      return {
        bookable: false,
        type: 'inventory',
        rates: [],
        message: INVALID_DAY_OF_WEEK_ERROR_TEMPLATE.replace('{allowedDays}', startDateIsInvalid),
      };
    }

    const lastDateRangeEndDate = moment(dateRanges[dateRanges.length - 1].endDate);
    noOfDaysRatesAvailable = lastDateRangeEndDate.diff(moment(startDate), 'days') + 1;
    // eslint-disable-next-line max-len
    allDatesHaveRatesAvailable = doAllDatesHaveRatesAvailable(lastDateRangeEndDate, startDate, chargeUnitQuantity);

    if (allDatesHaveRatesAvailable) {
      // all dates have rates available, get stay rates for the given dates
      // Validate date ranges and room configurations
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
      if (SCheckPass) {
        return {
          bookable: SCheckPass,
          type: 'inventory',
          ...(endDate && SCheckPass ? { endDate } : {}),
          ...(message && SCheckPass ? { message } : {}),
          rates: getRatesObjectArray(OptStayResults, false),
        };
      }

      return returnEmptyRatesOrError(
        allowSendingServicesWithoutARate,
        agentCurrencyCode,
        GENERIC_AVALABILITY_CHK_ERROR_MESSAGE,
      );
    }
  }

  // At least one date does not have rates available
  if (!isBookingForCustomRatesEnabled) {
    // custom rates are not enabled
    const noRatesAvailableError = await getNoRatesAvailableError({
      optionId,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      endDate: endDate || startDate,
      roomConfigs,
      callTourplan,
      extendedBookingYears,
    });
    return returnEmptyRatesOrError(
      allowSendingServicesWithoutARate,
      agentCurrencyCode,
      noRatesAvailableError,
    );
  }

  // Custom Rates are Enabled or Sending Services Without a Rate is Enabled
  // Step1 : Get date range to use for the days that do not have any rates available

  // This is done by getting the past rates based on the useLastYearRate flag.
  // If true use last year's rates, otherwise use last available rates.
  const startDateToUse = noOfDaysRatesAvailable > 0 ? moment(startDate).add(noOfDaysRatesAvailable, 'days').format('YYYY-MM-DD') : startDate;
  // Calculate the number of days to charge at the last rate
  const daysToChargeAtLastRate = noOfDaysRatesAvailable > 0
    ? chargeUnitQuantity - noOfDaysRatesAvailable : chargeUnitQuantity;

  const { dateRangeToUse, errorMsg } = await getCustomRateDateRange({
    useLastYearRate,
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    startDate: startDateToUse,
    chargeUnitQuantity: daysToChargeAtLastRate,
    roomConfigs,
    callTourplan,
    endDate,
    extendedBookingYears,
  });

  if (!dateRangeToUse) {
    return returnEmptyRatesOrError(allowSendingServicesWithoutARate, agentCurrencyCode, errorMsg);
  }

  // Check if the end date of the date range to use is beyond the permitted future booking years
  const extendedBookingPermittedDate = moment(dateRangeToUse.endDate).add(extendedBookingYears, 'years').format('YYYY-MM-DD');
  const periodEndDate = moment(startDateToUse).add(daysToChargeAtLastRate - 1, 'days');
  if (moment(startDateToUse).isAfter(extendedBookingPermittedDate) ||
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

  let sWarningMsg = '';

  // Validate date ranges
  const dateRangesError = validateDateRanges({
    dateRanges: [dateRangeToUse],
    startDate: dateRangeToUse.startDate,
    chargeUnitQuantity,
  });

  let minStayRequired = 0;
  if (dateRangesError) {
    if (dateRangesError.message.includes('minimum stay')) {
      // If minimum stay error, return availability with a warning message
      const { matchingRateSet } = getMatchingRateSet(dateRangeToUse.rateSets, dateRangeToUse.startDate, chargeUnitQuantity);
      minStayRequired = matchingRateSet ? matchingRateSet.minSCU : 0;
      sWarningMsg = MIN_STAY_WARNING_MESSAGE.replace('{minSCU}', minStayRequired);
    } else if (dateRangesError.message.includes('rates are closed')) {
      // If rates are closed, return an error message
      return {
        bookable: false,
        type: 'inventory',
        rates: [],
        message: PREVIOUS_RATE_CLOSED_PERIODS_ERROR_MESSAGE.replace('{customPeriodInfoMsg}', customPeriodInfoMsg).replace('{closedDateRanges}', dateRangesError.message),
      };
    }
  }

  const startDateIsInvalid = validateStartDay({
    dateRanges: [dateRangeToUse],
    startDate: dateRangeToUse.startDate,
  });
  if (startDateIsInvalid) {
    // if start day is not valid find the date for the next valid day
    sWarningMsg += INVALID_DAY_OF_WEEK_WARNING_TEMPLATE.replace('{allowedDays}', startDateIsInvalid).replace('{customPeriodInfoMsg}', customPeriodInfoMsg);
    const newStartDate = findNextValidDate(dateRangeToUse.startDate, [dateRangeToUse]);
    if (newStartDate) {
      dateRangeToUse.startDate = newStartDate;
      dateRangeToUse.endDate = moment(newStartDate).add(chargeUnitQuantity - 1, 'days').format('YYYY-MM-DD');
    }
  }

  const settings = {
    crossSeason: CROSS_SEASON_CAL_SPLIT_RATE, // default to split rate
    isRoundRatesEnabled,
    isRoundToTheNearestDollarEnabled,
    // default set to 0, so that if product connect is not enabled or if there is
    // an error getting info from product connect then in the method getRatesObjectArray
    // the retail price will be used as the cost price
    costPriceIncludingTax: 0,
    taxRate: 0,
    buyCurrency: dateRangeToUse.buyCurrency,
    agentCurrency: agentCurrencyCode,
  };

  if (isProductConnectAvailable) {
    let paxBreaks = {};
    let costForDaysWithRates = 0;
    let costForDaysWithoutRates = 0;
    let taxRateForDaysWithRates = 0;
    let taxRateForDaysWithoutRates = 0;
    const optionInfo = await getOptionFromProductConnect(
      optionId,
      productConnectEndpoint,
      productConnectUser,
      productConnectUserPassword,
      axios,
      callTourplan,
      dateRangeToUse,
    );
    if (!optionInfo) {
      console.warn(PRODUCT_CONNECT_OPTION_INFO_ERROR_MESSAGE);
    } else {
      settings.crossSeason = optionInfo.crossSeason;
      paxBreaks = optionInfo.paxBreaks;
    }
    if (settings.crossSeason === CROSS_SEASON_NOT_ALLOWED) {
      return {
        bookable: false,
        type: 'inventory',
        rates: [],
        message: CROSS_SEASON_NOT_ALLOWED_ERROR_MESSAGE,
      };
    }

    // get cost for the days that have rates available
    if (noOfDaysRatesAvailable > 0) {
      const costInfoForDaysWithRates = await getCostFromProductConnect({
        optionId,
        productConnectEndpoint,
        productConnectUser,
        productConnectUserPassword,
        axios,
        callTourplan,
        startDate,
        endDate,
        startDateToUse: startDate,
        customRatesEligibleRateTypes,
        roomConfigs,
        paxBreaks,
        daysToChargeAtLastRate: noOfDaysRatesAvailable,
        agentCurrency: agentCurrencyCode,
      });

      if (costInfoForDaysWithRates) {
        if (costInfoForDaysWithRates.error) {
          return returnEmptyRatesOrError(
            allowSendingServicesWithoutARate,
            agentCurrencyCode,
            costInfoForDaysWithRates.message,
          );
        }

        if (costInfoForDaysWithRates.message) {
          sWarningMsg = INVALID_DAY_OF_WEEK_WARNING_TEMPLATE.replace('{allowedDays}', costInfoForDaysWithRates.message).replace('{customPeriodInfoMsg}', customPeriodInfoMsg);
        }
        costForDaysWithRates = costInfoForDaysWithRates.cost;
        taxRateForDaysWithRates = costInfoForDaysWithRates.taxRate;
      }
    }

    // get cost for the days that do not have rates available
    const costInfoForDaysWithoutRates = await getCostFromProductConnect({
      optionId,
      productConnectEndpoint,
      productConnectUser,
      productConnectUserPassword,
      axios,
      callTourplan,
      startDate: dateRangeToUse.startDate,
      endDate: dateRangeToUse.endDate,
      startDateToUse,
      customRatesEligibleRateTypes,
      roomConfigs,
      paxBreaks,
      daysToChargeAtLastRate,
      agentCurrency: agentCurrencyCode,
    });

    if (costInfoForDaysWithoutRates) {
      if (costInfoForDaysWithoutRates.error) {
        return {
          bookable: false,
          type: 'inventory',
          rates: [],
          message: costInfoForDaysWithoutRates.message,
        };
      }
      if (costInfoForDaysWithoutRates.message) {
        sWarningMsg = INVALID_DAY_OF_WEEK_WARNING_TEMPLATE.replace('{allowedDays}', costInfoForDaysWithoutRates.message).replace('{customPeriodInfoMsg}', customPeriodInfoMsg);
      }
      costForDaysWithoutRates = costInfoForDaysWithoutRates.cost;
      taxRateForDaysWithoutRates = costInfoForDaysWithoutRates.taxRate;
    }
    settings.costPriceIncludingTax = costForDaysWithoutRates + costForDaysWithRates;
    settings.taxRate = Math.max(taxRateForDaysWithRates, taxRateForDaysWithoutRates);
  }

  // Format the success message for the custom rates
  // eslint-disable-next-line max-len
  const bShowMarkupMsg = ((settings.crossSeason === CROSS_SEASON_CAL_USING_RATE_OF_FIRST_RATE_PERIOD
    && noOfDaysRatesAvailable === 0)
    || settings.crossSeason !== CROSS_SEASON_CAL_USING_RATE_OF_FIRST_RATE_PERIOD);
  const customRateInfoMsg = (markupPercentage > 0 && bShowMarkupMsg)
    ? CUSTOM_RATE_WITHMARKUP_INFO_MSG.replace('{customPeriodInfoMsg}', customPeriodInfoMsg).replace('{sWarningMsg}', sWarningMsg)
    : CUSTOM_RATE_NO_MARKUP_INFO_MSG.replace('{customPeriodInfoMsg}', customPeriodInfoMsg).replace('{sWarningMsg}', sWarningMsg);
  const successMessage = message ? `${message}. ${customRateInfoMsg}` : `${customRateInfoMsg}`;

  let conversionRate = 1;
  let conversionRateFetched = false;
  let OptStayResults = [];
  // Step 2 : Now get rates
  // Step 2.1 : First get rates for the days that have rates available
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
      return returnEmptyRatesOrError(
        allowSendingServicesWithoutARate,
        agentCurrencyCode,
        GENERIC_AVALABILITY_CHK_ERROR_MESSAGE,
      );
    }
  }

  if (daysToChargeAtLastRate > 0) {
    const daysInDateRangeToUse = moment(dateRangeToUse.endDate).diff(moment(dateRangeToUse.startDate), 'days') + 1;
    const ratesForDays = Math.min(daysToChargeAtLastRate, daysInDateRangeToUse);
    const lastRateProratedDays = Math.max(ratesForDays, minStayRequired);
    // Step 2.2 : Get rates for the days that do not have rates available
    let OptStayResultsExtendedDates = await getStayResults(
      optionId,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      dateRangeToUse.startDate,
      lastRateProratedDays,
      roomConfigs,
      displayRateInSupplierCurrency,
      callTourplan,
    );
    const SCheckPass = Boolean(OptStayResultsExtendedDates.length);
    if (SCheckPass) {
      // fetch the conversion rate if the rate are displayed in supplier currency
      if (displayRateInSupplierCurrency && !conversionRateFetched) {
        conversionRate = await getConversionRate({
          OptStayResultsInSupplierCurrency: OptStayResultsExtendedDates,
          optionId,
          hostConnectEndpoint,
          hostConnectAgentID,
          hostConnectAgentPassword,
          axios,
          startDate: dateRangeToUse.startDate,
          noOfDaysRatesAvailable: lastRateProratedDays,
          roomConfigs,
          callTourplan,
        });
        conversionRateFetched = true;
      }

      if (OptStayResults.length === 0 && SCheckPass) {
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
          isBookingForCustomRatesEnabled,
          conversionRate,
          markupPercentage,
          OptStayResultsExtendedDates,
          lastRateProratedDays,
          daysToChargeAtLastRate,
          settings,
          noOfDaysRatesAvailable,
        ),
      };
    }
  }
  const noRatesAvailableError = await getNoRatesAvailableError({
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    endDate: endDate || startDate,
    roomConfigs,
    callTourplan,
    extendedBookingYears,
  });
  return returnEmptyRatesOrError(
    allowSendingServicesWithoutARate,
    agentCurrencyCode,
    noRatesAvailableError,
  );
};

module.exports = {
  searchAvailabilityForItinerary,
};
