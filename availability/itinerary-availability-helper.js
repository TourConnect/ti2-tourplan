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
const { getRoomConfigs, CUSTOM_RATE_ID_NAME, hostConnectXmlOptions } = require('../utils');

// Constants exported
const MIN_MARKUP_PERCENTAGE = 1;
const MAX_MARKUP_PERCENTAGE = 100;
const MIN_EXTENDED_BOOKING_YEARS = 1;
const MAX_EXTENDED_BOOKING_YEARS = 100;

// constants not exported
const GENERIC_AVALABILITY_CHK_ERROR_MESSAGE = 'Not bookable for the requested date/stay. '
  + '(e.g. no rates, block out period, on request, minimum stay etc.)';
const RATES_AVAILABLE_TILL_ERROR_TEMPLATE = 'Rates are only available until {dateTill}. '
  + 'Please change the date and try again.';
const DAYS_IN_A_YEAR = 365;
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
    3.For non-accommodation options, if MPFCU has a value of 1 then rates for the option are per-person.
    MPFCU is greater than one then rates for this option are for a group, and MPFCU is the maximum
    number of people (adults plus children) that can be booked per AddService call for the option.
    Hence we need to check if the number of people in the roomConfigs is greater than maxPaxPerCharge.
    A rental car might have an MPFCU of 4, for example.
    NOTE: It is possible that we may have to revisit this for cases where the value is 1 (per-person)
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
const getPastYearDateRange = async (
  optionId,
  hostConnectEndpoint,
  hostConnectAgentID,
  hostConnectAgentPassword,
  axios,
  dateToFetchRates,
  chargeUnitQuantityToFetchRates,
  roomConfigs,
  callTourplan,
) => {
  const dateFrom = moment(dateToFetchRates).subtract(1, 'year').format('YYYY-MM-DD');
  const unitQuantity = chargeUnitQuantityToFetchRates || DAYS_IN_A_YEAR;
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
    return results[results.length - 1];
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

  const pastYearDateRange = await getPastYearDateRange(
    optionId,
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    axios,
    dateFrom,
    DAYS_IN_A_YEAR,
    roomConfigs,
    callTourplan,
  );

  return pastYearDateRange;
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
  Returns the rates object array after making the markup calculations.

  @param {Object} OptStayResults - The stay results
  @param {number} markupPercentage - The markup percentage
  @param {Object} OptStayResultsExtendedDates - The extended stay results
  @returns {Object} The rates object array
*/
const getRatesObjectArray = (
  OptStayResults,
  markupPercentage = 0,
  OptStayResultsExtendedDates = [],
  minStayRequired = 0,
  daysToChargeAtLastRate = 0,
) => OptStayResults.map(rate => {
  const rateId = markupPercentage > 0 ? CUSTOM_RATE_ID_NAME : R.path(['RateId'], rate);
  const currency = R.pathOr('', ['Currency'], rate);
  // NOTE: Check if the value is in cents or not
  const totalPrice = Number(R.pathOr(0, ['TotalPrice'], rate));
  const agentPrice = Number(R.pathOr(0, ['AgentPrice'], rate));

  let finalTotalPrice = totalPrice;
  let finalAgentPrice = agentPrice;

  if (minStayRequired > daysToChargeAtLastRate) {
    const oneDayTotalPrice = totalPrice / minStayRequired;
    const oneDayAgentPrice = agentPrice / minStayRequired;
    finalTotalPrice = oneDayTotalPrice * daysToChargeAtLastRate;
    finalAgentPrice = oneDayAgentPrice * daysToChargeAtLastRate;
  }
  let costPrice = finalTotalPrice;

  let markupFactor = 1;
  if (markupPercentage >= MIN_MARKUP_PERCENTAGE && markupPercentage <= MAX_MARKUP_PERCENTAGE) {
    markupFactor = 1 + (Number(markupPercentage) / 100);
  }

  if (OptStayResultsExtendedDates.length > 0) {
    const singleDayRate = OptStayResultsExtendedDates.find(rate2 => rate2.RateId === rate.RateId);
    const totalPriceNoRatesDays = Number(R.pathOr(0, ['TotalPrice'], singleDayRate));
    const agentPriceNoRatesDays = Number(R.pathOr(0, ['AgentPrice'], singleDayRate));
    finalTotalPrice = Math.round(finalTotalPrice + (totalPriceNoRatesDays * markupFactor));
    finalAgentPrice = Math.round(finalAgentPrice + (agentPriceNoRatesDays * markupFactor));
    costPrice += totalPriceNoRatesDays;
  } else if (markupFactor > 1) {
    finalTotalPrice = Math.round(finalTotalPrice * markupFactor);
    finalAgentPrice = Math.round(finalAgentPrice * markupFactor);
  }
  const currencyPrecision = R.pathOr(2, ['currencyPrecision'], rate);
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
          <PenaltyDescription>Cancellation 100% - within 24 hours or no notice</PenaltyDescription>
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
    totalPrice: finalTotalPrice,
    costPrice,
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
  Returns the no rates available error.

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

module.exports = {
  getAvailabilityConfig,
  getNoRatesAvailableError,
  getStayResults,
  getImmediateLastDateRange,
  getPastYearDateRange,
  getRatesObjectArray,
  getOptionDateRanges,
  // Constants
  MIN_MARKUP_PERCENTAGE,
  MAX_MARKUP_PERCENTAGE,
  MIN_EXTENDED_BOOKING_YEARS,
  MAX_EXTENDED_BOOKING_YEARS,
};
