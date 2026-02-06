const moment = require('moment');
const R = require('ramda');
const { passengerTypeMap } = require('../utils');

// Constants
const MAX_PAX_EXCEEDED_ERROR_TEMPLATE = 'Maximum {maxPax} pax allowed per Pax Config. '
  + 'Please update the Pax Config accordingly.';
const RATES_CLOSED_ERROR_TEMPLATE = 'The rates are closed for the '
  + '{closedDateRanges}. Please try again with a different date.';
const MIN_STAY_LENGTH_ERROR_TEMPLATE = '{minSCUDateRangesText}. '
  + 'Please adjust the stay length and try again.';
const USER_FRIENDLY_DATE_FORMAT = 'DD-MMM-YYYY';

/**
 * Validate that each RoomConfig does not exceed maxPaxPerCharge.
 * Reason: Tourplan availability check returns success even if the pax configs
 * exceed the maxPaxPerCharge.
 * And then when the booking is made, the booking fails with an error like
 * "002 SCN adults + children exceeds capacity".
 *
 * @param {Object} params - Validation parameters
 * @returns {Object|null} Returns error object if validation fails, null if valid
 */
const validateMaxPaxPerCharge = ({
  roomConfigs,
  maxPaxPerCharge,
}) => {
  // Verify that each RoomConfig does not exceed maxPaxPerCharge
  if (maxPaxPerCharge && maxPaxPerCharge > 1) {
    for (let i = 0; i < roomConfigs.RoomConfig.length; i += 1) {
      const room = roomConfigs.RoomConfig[i];
      const roomPax = (room.Adults || 0) + (room.Children || 0) + (room.Infants || 0);
      if (roomPax > maxPaxPerCharge) {
        // NOTE: As a long term solution, we need to return the errors per pax config
        // so that the UI can display the errors for the particular pax config.
        // For now we return on the 1st error and show the error in availability check.
        return {
          bookable: false,
          type: 'inventory',
          rates: [],
          message: MAX_PAX_EXCEEDED_ERROR_TEMPLATE.replace('{maxPax}', maxPaxPerCharge),
        };
      }
    }
  }

  return null;
};

/**
 * Validate that the start date day of week is valid for the rate set
 * @param {Object} params - Validation parameters
 * @returns {Object|null} Returns error object if validation fails, null if valid
 */
const validateStartDay = ({
  dateRanges,
  startDate,
}) => {
  const invalidDayOfWeekMessages = [];
  let startDayIsValid = false;

  // Filter date ranges to only include those where the date range start date
  // is between the booking startDate and endDate
  const filteredDateRanges = dateRanges.filter(dateRange => {
    const rangeStartDate = moment(dateRange.startDate);
    const rangeEndDate = moment(dateRange.endDate);
    const bookingStartDate = moment(startDate);
    return bookingStartDate.isBetween(rangeStartDate, rangeEndDate, null, '[]');
  });

  filteredDateRanges.some(dateRange => {
    dateRange.rateSets.some(rateSet => {
      // Check if the start date day of week is valid for this rate set
      const dayIsValid = isStartDayValid(rateSet, startDate);
      if (dayIsValid) {
        startDayIsValid = true;
        return true; // Exit both loops
      }

      const allowedDays = getAllowedDaysText(rateSet);
      invalidDayOfWeekMessages.push(allowedDays);
      return false; // Continue iteration
    });
    return false;
  });

  // If the start date is valid for any rate set, return null (no error)
  if (startDayIsValid) {
    return null;
  }

  // Only return error if no rate sets allow this day
  if (invalidDayOfWeekMessages.length > 0) {
    return invalidDayOfWeekMessages.join(', ');
  }

  return null;
};
/**
 * Validates date ranges to check if any rate set is closed
 * and if any rate set has a minimum stay length that is greater than the charge unit quantity
 * @param {Object} params - Validation parameters
 * @returns {Object|null} Returns error object if validation fails, null if valid
 */
const validateDateRanges = ({
  dateRanges,
  startDate,
  chargeUnitQuantity,
}) => {
  // Check if any rate set is closed
  const closedDateRanges = [];
  dateRanges.forEach(dateRange => {
    if (dateRange.rateSets && dateRange.rateSets.some(rateSet => rateSet.isClosed === 'Y')) {
      closedDateRanges.push(dateRange);
    }
  });

  if (closedDateRanges.length > 0) {
    const closedDateRangesText = closedDateRanges.map(dateRange => {
      const formattedStartDate = moment(dateRange.startDate).format(USER_FRIENDLY_DATE_FORMAT);
      const formattedEndDate = moment(dateRange.endDate).format(USER_FRIENDLY_DATE_FORMAT);
      return formattedStartDate === formattedEndDate ? `date ${formattedStartDate}` : `date(s): ${formattedStartDate} to ${formattedEndDate}`;
    }).join(', ');
    return {
      bookable: false,
      type: 'inventory',
      rates: [],
      message: RATES_CLOSED_ERROR_TEMPLATE.replace('{closedDateRanges}', closedDateRangesText),
    };
  }

  // Check if any rate set in any date range has a minimum stay length
  // that is more than the charge unit quantity
  const minSCUDateRangesText = [];
  dateRanges.forEach(dateRange => {
    if (dateRange.rateSets) {
      const dateRangeStartDate = dateRange.startDate || dateRange.dateFrom;
      const dateRangeEndDate = dateRange.endDate || dateRange.dateTo;
      const daysBeforeDateRange = moment(dateRangeStartDate)
        .diff(moment(startDate), 'days');
      const daysAfterDateRange = daysBeforeDateRange > 0
        ? Number(chargeUnitQuantity) - daysBeforeDateRange
        : Number(chargeUnitQuantity);
      // Check if any rate set has a minimum stay length that is less than
      // the charge unit quantity
      const rateSetsWithMinSCULessThanQuantity = dateRange.rateSets
        .filter(rateSet => daysAfterDateRange >= Number(rateSet.minSCU))
        .slice(0, 1);
      if (rateSetsWithMinSCULessThanQuantity.length > 0) {
        return;
      }

      // Check if any rate set has a minimum stay length that is greater than
      // the charge unit quantity
      const rateSetWithMinSCUGreaterThanQuantity = dateRange.rateSets
        .filter(rateSet => daysAfterDateRange < Number(rateSet.minSCU))
        .slice(0, 1);
      if (rateSetWithMinSCUGreaterThanQuantity.length === 0) {
        return;
      }
      // Return min stay length error message
      const formattedStartDate = moment(dateRangeStartDate)
        .format(USER_FRIENDLY_DATE_FORMAT);
      const formattedEndDate = moment(dateRangeEndDate)
        .format(USER_FRIENDLY_DATE_FORMAT);
      minSCUDateRangesText.push(
        `The date range ${formattedStartDate} to ${formattedEndDate} `
        + `has a minimum stay length of ${rateSetWithMinSCUGreaterThanQuantity[0].minSCU}`,
      );
    }
  });

  if (minSCUDateRangesText.length > 0) {
    return {
      bookable: false,
      type: 'inventory',
      rates: [],
      message: MIN_STAY_LENGTH_ERROR_TEMPLATE.replace(
        '{minSCUDateRangesText}',
        minSCUDateRangesText.join(', '),
      ),
    };
  }

  return null; // No validation errors
};

/*
  Calculate the end date for an option based on start date, duration, and charge unit quantity.

  @param {string} startDate - The start date in YYYY-MM-DD format
  @param {number|null} duration - The duration in days (optional)
  @param {number|null} chargeUnitQuantity - The number of charge units (optional)
  @returns {string|null} The end date in YYYY-MM-DD format or null if not applicable
*/
const calculateEndDate = (startDate, duration, chargeUnitQuantity) => {
  const startMoment = moment(startDate, 'YYYY-MM-DD');
  let endDate = null;

  if (duration) {
    endDate = startMoment.clone().add(duration, 'days');
  } else if (chargeUnitQuantity && chargeUnitQuantity > 1) {
    endDate = startMoment.clone().add(chargeUnitQuantity, 'days');
  }

  return endDate ? endDate.format('YYYY-MM-DD') : null;
};

/*
  Get the message for an option based on duration, charge unit quantity, and charge unit.

  @param {number|null} duration - The duration in days (optional)
  @param {number|null} chargeUnitQuantity - The number of charge units (optional)
  @param {string|null} chargeUnit - The charge unit type (optional)
  @returns {string|null} The message or null if not applicable
*/
const getOptionMessage = (duration, chargeUnitQuantity, chargeUnit) => {
  const chargeUnitText = chargeUnit || 'Nights/Days';
  let message = null;
  if (duration && chargeUnitQuantity && duration !== chargeUnitQuantity) {
    message = `This option allows exactly ${duration} ${chargeUnitText}. The end date is adjusted accordingly.`;
  }
  return message;
};

/*
  Convert children or infants in the pax configs to adults.
  Reason: Tourplan API doesn't support children or infants in the availability check
  when,
    ChildrenAllowed = N & CountChildrenInPaxBreak = Y
    or InfantsAllowed = N & CountInfantsInPaxBreak = Y.

  Example:
  const originalPaxConfigs = [
    { roomType: 'DB', adults: 2, children: 1, infants: 1 },
    { roomType: 'TW', adults: 1, children: 2, infants: 2 }
  ];

  OUTPUT:
  const convertedPaxConfigs = convertToAdult(originalPaxConfigs, passengerTypeMap.Child);
  Result: [
    { roomType: 'DB', adults: 3, children: 0, infants: 1 },
    { roomType: 'TW', adults: 2, children: 0, infants: 2 }
  ]
  OR
  const convertedPaxConfigs = convertToAdult(originalPaxConfigs, passengerTypeMap.Infant);
  Result: [
    { roomType: 'DB', adults: 3, children: 1, infants: 0 },
    { roomType: 'TW', adults: 2, children: 2, infants: 0 }
  ]
  NOTE: This method only converts children or infants to adults (based on the type parameter),
  it doesn't convert the other type to adults.
*/
const convertToAdult = (paxConfigs, type) => {
  if (!Array.isArray(paxConfigs)) {
    return paxConfigs;
  }

  return paxConfigs.map(paxConfig => {
    const newPaxConfig = { ...paxConfig };

    // Convert children or infants to adults
    const typeKey = type === passengerTypeMap.Child ? 'children' : 'infants';
    const totalAdults = (newPaxConfig.adults || 0) + (newPaxConfig[typeKey] || 0);
    newPaxConfig.adults = totalAdults;
    newPaxConfig[typeKey] = 0;

    // now update the type of the passengers to adults
    if (newPaxConfig.passengers && Array.isArray(newPaxConfig.passengers)) {
      newPaxConfig.passengers = newPaxConfig.passengers.map(passenger => ({
        ...passenger,
        passengerType: passenger.passengerType === type
          ? passengerTypeMap.Adult
          : passenger.passengerType,
      }));
    }

    return newPaxConfig;
  });
};

/*
  Create modified passenger configurations based on the count flags.
  This function handles the conversion of children and infants to adults
  when the respective count flags are enabled, which is necessary for
  Tourplan API compatibility, see comments for treatChildrenAsAdults
  and treatInfantsAsAdults for more details.
*/
const getModifiedPaxConfigs = (
  countChildrenInPaxBreak,
  childrenAllowed,
  countInfantsInPaxBreak,
  infantsAllowed,
  paxConfigs,
) => {
  let modifiedPaxConfigs = paxConfigs;
  if (countChildrenInPaxBreak && !childrenAllowed) {
    // NOTE: If children are allowed let the availaiblity check happen with children
    modifiedPaxConfigs = convertToAdult(paxConfigs, passengerTypeMap.Child);
  }
  if (countInfantsInPaxBreak && !infantsAllowed) {
    // NOTE: If infants are allowed let the availaiblity check happen with infants
    modifiedPaxConfigs = convertToAdult(modifiedPaxConfigs, passengerTypeMap.Infant);
  }
  return modifiedPaxConfigs;
};

// Helper function to parse AppliesDaysOfWeek object
const parseAppliesDaysOfWeek = appliesDaysOfWeek => {
  if (!appliesDaysOfWeek || typeof appliesDaysOfWeek !== 'object') {
    // If no apply days are specified, default to all days being allowed
    return {
      applyMon: true,
      applyTue: true,
      applyWed: true,
      applyThu: true,
      applyFri: true,
      applySat: true,
      applySun: true,
    };
  }

  return {
    applyMon: appliesDaysOfWeek['@Mon'] === 'Y',
    applyTue: appliesDaysOfWeek['@Tue'] === 'Y',
    applyWed: appliesDaysOfWeek['@Wed'] === 'Y' || appliesDaysOfWeek['@Weds'] === 'Y',
    applyThu: appliesDaysOfWeek['@Thu'] === 'Y' || appliesDaysOfWeek['@Thur'] === 'Y',
    applyFri: appliesDaysOfWeek['@Fri'] === 'Y',
    applySat: appliesDaysOfWeek['@Sat'] === 'Y',
    applySun: appliesDaysOfWeek['@Sun'] === 'Y',
  };
};

const parseDateRanges = dateRanges => {
  const dateRangesResult = [];

  if (!dateRanges) {
    return dateRangesResult;
  }

  // Extract OptDateRange items from the dateRanges object
  const optDateRanges = R.pathOr([], ['OptDateRange'], dateRanges);
  const dateRangeArray = Array.isArray(optDateRanges) ? optDateRanges : [optDateRanges];

  dateRangeArray.forEach(dateRange => {
    const rateSets = R.pathOr({}, ['RateSets', 'RateSet'], dateRange);
    const rateSetsArray = Array.isArray(rateSets) ? rateSets : [rateSets];

    // Process all rate sets for this date range
    const processedRateSets = rateSetsArray.map(rateSet => {
      // const roomRates = R.pathOr({}, ['OptRate', 'RoomRates'], rateSet);
      // const extrasRates = R.pathOr({}, ['OptRate', 'ExtrasRates', 'ExtrasRate'], rateSet);

      // Extract OptionRates from OptRate if available
      const optionRates = R.pathOr([], ['OptRate', 'OptionRates', 'OptionRate'], rateSet);
      const optionRatesArray = Array.isArray(optionRates) ? optionRates : [optionRates];

      // Parse the AppliesDaysOfWeek object to individual day flags
      const appliesDaysOfWeek = parseAppliesDaysOfWeek(rateSet.AppliesDaysOfWeek);

      return {
        rateName: rateSet.RateName,
        rateText: rateSet.RateText,
        minSCU: rateSet.MinSCU,
        maxSCU: rateSet.MaxSCU,
        cancelHours: rateSet.CancelHours,
        isClosed: rateSet.IsClosed,
        scuCheckOverlapOnly: rateSet.ScuCheckOverlapOnly,
        ...appliesDaysOfWeek,
        optionRates: optionRatesArray.filter(rate => rate !== undefined && rate !== null),
      };
    });

    // Sort rate sets by minSCU in ascending order
    processedRateSets.sort((a, b) => (a.minSCU || 0) - (b.minSCU || 0));

    dateRangesResult.push({
      startDate: dateRange.DateFrom,
      endDate: dateRange.DateTo,
      currency: dateRange.Currency,
      priceCode: dateRange.PriceCode,
      rateSets: processedRateSets,
    });
  });
  // Sort results in ascending order by startDate
  dateRangesResult.sort((a, b) => moment(a.startDate).diff(moment(b.startDate)));
  return dateRangesResult;
};

const extractCancelPolicies = (rate, path, isOptionCancelPolicy) => {
  const rawPolicies = R.pathOr([], path, rate);
  let policies = [];
  if (!Array.isArray(rawPolicies)) {
    policies = [rawPolicies]; // If single item, convert to array
  } else {
    policies = rawPolicies;
  }
  return policies.map(policy => {
    const mappedPolicy = {
      // The description of the penalty (optional)
      penaltyDescription: R.path(['PenaltyDescription'], policy),
      // The number of OffsetTimeUnit in this relative deadline
      cancelNum: R.path(['Deadline', 'OffsetUnitMultiplier'], policy),
      // One of Second, Hour, Day, Week, Month or Year
      cancelTimeUnit: R.path(['Deadline', 'OffsetTimeUnit'], policy),
    };

    if (isOptionCancelPolicy) {
      // The absolute deadline, i.e. the final date and time of the deadline. (optional)
      mappedPolicy.deadlineDateTime = R.path(['Deadline', 'DeadlineDateTime'], policy);
      // Y if this penalty is the one used if a service line is cancelled now (N otherwise)
      mappedPolicy.inEffect = R.path(['InEffect'], policy) && R.path(['InEffect'], policy) === 'Y';
      // Amount of the cancellation penalty
      mappedPolicy.cancelFee = R.path(['LinePrice'], policy);
      // Line price less commission.
      mappedPolicy.agentPrice = R.path(['AgentPrice'], policy);
    }
    return Object.fromEntries(
      Object.entries(mappedPolicy).filter(([_, value]) => value !== undefined),
    );
  });
};

const getAllowedDaysText = rateSet => {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayProperties = ['applySun', 'applyMon', 'applyTue', 'applyWed', 'applyThu', 'applyFri', 'applySat'];
  const allowedDays = [];
  for (let i = 0; i < dayProperties.length; i += 1) {
    if (rateSet[dayProperties[i]]) {
      allowedDays.push(dayNames[i]);
    }
  }
  if (allowedDays.length === 0) {
    return 'any day';
  }
  if (allowedDays.length === 1) {
    return allowedDays[0];
  }
  if (allowedDays.length === 2) {
    return `${allowedDays[0]} and ${allowedDays[1]}`;
  }
  return `${allowedDays.slice(0, -1).join(', ')}, and ${allowedDays[allowedDays.length - 1]}`;
};

// Helper function to check if start date day matches rate set apply days
const isStartDayValid = (rateSet, date) => {
  const dayOfWeek = moment(date).day(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  // Map days to corresponding apply properties
  const dayMapping = {
    0: rateSet.applySun,
    1: rateSet.applyMon,
    2: rateSet.applyTue,
    3: rateSet.applyWed,
    4: rateSet.applyThu,
    5: rateSet.applyFri,
    6: rateSet.applySat,
  };

  return dayMapping[dayOfWeek] === true;
};

// eslint-disable-next-line max-len
const getMatchingRateSet = (rateSets, startDate, chargeUnitQuantityRaw, eligibleRateTypesCodes = []) => {
  const chargeUnitQuantity = Number(chargeUnitQuantityRaw);
  let rateSetMatchingError = null;
  const invalidDayOfWeekMessages = [];

  const matchingRateSet = rateSets.find(rateSet => {
    // First check if the charge unit quantity matches
    const quantityMatches = (chargeUnitQuantity < Number(rateSet.maxSCU) &&
                            chargeUnitQuantity > Number(rateSet.minSCU)) ||
                           (chargeUnitQuantity === Number(rateSet.minSCU) ||
                            chargeUnitQuantity === Number(rateSet.maxSCU)) ||
                           (chargeUnitQuantity < Number(rateSet.minSCU));

    // Then check if the start date day of week is valid for this rate set
    const dayIsValid = isStartDayValid(rateSet, startDate);
    if (!dayIsValid) {
      const allowedDays = getAllowedDaysText(rateSet);
      invalidDayOfWeekMessages.push(allowedDays);
    }

    const isEligibleRateStatus = eligibleRateTypesCodes.length === 0 ||
          eligibleRateTypesCodes.includes(rateSet.rateStatus);
    return quantityMatches && dayIsValid && isEligibleRateStatus;
  });

  if (!matchingRateSet) {
    rateSetMatchingError = invalidDayOfWeekMessages.join(', ');
  }

  return { matchingRateSet, rateSetMatchingError };
};

module.exports = {
  validateMaxPaxPerCharge,
  validateStartDay,
  validateDateRanges,
  calculateEndDate,
  getOptionMessage,
  convertToAdult,
  getModifiedPaxConfigs,
  parseDateRanges,
  extractCancelPolicies,
  getMatchingRateSet,
  USER_FRIENDLY_DATE_FORMAT,
};
