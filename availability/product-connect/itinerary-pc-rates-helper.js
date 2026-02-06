// const { race } = require('bluebird');
const R = require('ramda');
const { productConnectXmlOptions } = require('../../utils');

const {
  getMatchingRateSet,
} = require('../itinerary-availability-utils');

const PRODUCT_CONNECT_RATES_INFO_ERROR_MESSAGE = 'Error getting rates info from Product Connect. Check Product Connect credentials and try again.';
const RATE_NOT_ELIGIBLE_ERROR_MESSAGE = 'The rate selected does not have an eligible rate type. Please select another rate or option and try again.';

// Constants for parsing limits
const MAX_PXB_FIELDS = 24; // Maximum number of Pxb fields supported by Product Connect API
const MAX_VTEXT_FIELDS = 20; // Maximum number of Vtext fields supported by Product Connect API

// Rate status constants user readable
const RATE_STATUS_CLOSED = 'Closed';
const RATE_STATUS_CONFIRMED = 'Confirmed';
const RATE_STATUS_MANUAL = 'Manual';
const RATE_STATUS_PROVISIONAL = 'Provisional';
const RATE_STATUS_TERMINAL = 'Terminal';

const RATE_STATUS_MAP = new Map([
  [RATE_STATUS_CLOSED, 'C'],
  [RATE_STATUS_CONFIRMED, 'K'],
  [RATE_STATUS_MANUAL, 'M'],
  [RATE_STATUS_PROVISIONAL, 'P'],
  [RATE_STATUS_TERMINAL, 'T'],
]);

// Helper function to parse rates either per unit or per group
const parseRateStructure = rateStructure => {
  const rates = R.pathOr({}, ['Rates'], rateStructure);

  // Case 1: Room codes: SG (Single), TW (Twin), TR (Triple), QD (Quad), AA (AdditionalAdult)
  const roomRate = R.pathOr(null, ['RoomRate'], rates);
  if (roomRate) {
    const roomRates = {};
    // Parse all room codes dynamically
    Object.keys(roomRate).forEach(roomCode => {
      const rateValue = roomRate[roomCode];
      if (rateValue !== null && rateValue !== undefined && rateValue !== '') {
        roomRates[roomCode] = parseFloat(rateValue);
      }
    });
    return { roomRates };
  }

  // Case 2: Rates are per person
  // Rate per first charge unit (per person, per vehicle, per whatever)
  const ratePerFirstChargeUnitRaw = R.pathOr(null, ['AdultRate'], rates);
  if (ratePerFirstChargeUnitRaw) {
    // if ChildRate and InfantRate then AdultRate must be present
    const ratePerChildOrSupplimentRaw = R.pathOr(null, ['ChildRate'], rates);
    const ratePerInfantOrSupplimentRaw = R.pathOr(null, ['InfantRate'], rates);
    return {
      // eslint-disable-next-line max-len
      ratePerFirstChargeUnit: ratePerFirstChargeUnitRaw ? parseFloat(ratePerFirstChargeUnitRaw) : 0,
      // eslint-disable-next-line max-len
      ratePerChildOrSuppliment: ratePerChildOrSupplimentRaw ? parseFloat(ratePerChildOrSupplimentRaw) : 0,
      // eslint-disable-next-line max-len
      ratePerInfantOrSuppliment: ratePerInfantOrSupplimentRaw ? parseFloat(ratePerInfantOrSupplimentRaw) : 0,
    };
  }

  // Case 3: Rates are per group
  // Dynamically parse all available Price_Pxb fields (up to 24 based on product connect API)
  // Adult
  const paxBreakRate = R.pathOr(null, ['PaxBreakRate'], rates);
  const pricePxbFields = {};
  if (paxBreakRate) {
    // Dynamically parse all available Price_Pxb fields
    for (let i = 1; i <= MAX_PXB_FIELDS; i += 1) {
      const pricePxbKey = `Price_Pxb${i}`;
      const pricePxbValue = R.pathOr(null, [pricePxbKey], paxBreakRate);

      // Only include the field if it exists and has a value
      if (pricePxbValue !== null && pricePxbValue !== undefined && pricePxbValue !== '') {
        pricePxbFields[`pricePxb${i}`] = parseFloat(pricePxbValue);
      }
    }
  }

  // Child
  const paxChildBreakRate = R.pathOr(null, ['ChildBreakRate'], rates);
  const pricePxbChildFields = {};
  if (paxChildBreakRate) {
    // Dynamically parse all available Price_Pxb fields
    for (let i = 1; i <= MAX_PXB_FIELDS; i += 1) {
      const pricePxbKey = `Price_Pxb${i}`;
      const pricePxbValue = R.pathOr(null, [pricePxbKey], paxChildBreakRate);

      // Only include the field if it exists and has a value
      if (pricePxbValue !== null && pricePxbValue !== undefined && pricePxbValue !== '') {
        pricePxbChildFields[`pricePxb${i}`] = parseFloat(pricePxbValue);
      }
    }
  }

  // Infant
  const paxInfantBreakRate = R.pathOr(null, ['InfantBreakRate'], rates);
  const pricePxbInfantFields = {};
  if (paxInfantBreakRate) {
    // Dynamically parse all available Price_Pxb fields
    for (let i = 1; i <= MAX_PXB_FIELDS; i += 1) {
      const pricePxbKey = `Price_Pxb${i}`;
      const pricePxbValue = R.pathOr(null, [pricePxbKey], paxInfantBreakRate);

      // Only include the field if it exists and has a value
      if (pricePxbValue !== null && pricePxbValue !== undefined && pricePxbValue !== '') {
        pricePxbInfantFields[`pricePxb${i}`] = parseFloat(pricePxbValue);
      }
    }
  }
  return {
    Adult: pricePxbFields,
    Child: pricePxbChildFields,
    Infant: pricePxbInfantFields,
  };
};

// Helper function to parse a single rate set
const parseRateSet = rateSet => {
  const rateSetInfo = {
    stayType: R.pathOr('', ['Stay_Type'], rateSet),
    stayType2: R.pathOr('', ['Stay_Type2'], rateSet),
    rateText: R.pathOr('', ['Rate_Text'], rateSet),
    rateText2: R.pathOr('', ['Rate_Text2'], rateSet),
    minSCU: parseInt(R.pathOr('1', ['Min_SCU'], rateSet), 10),
    maxSCU: parseInt(R.pathOr('999999', ['Max_SCU'], rateSet), 10),

    // get rate status
    rateStatus: R.pathOr('', ['Prov'], rateSet),

    commissionable: R.pathOr('', ['Commissionable'], rateSet) === 'Y',
    commOride: parseFloat(R.pathOr('0', ['Comm_Oride'], rateSet)),
    prefer: parseInt(R.pathOr('0', ['Prefer'], rateSet), 10),
    grossNett: R.pathOr('', ['Gross_Nett'], rateSet) === 'Y',
    sellCode: R.pathOr('', ['Sell_Code'], rateSet) === 'Y',
    // Specifies which days of the week this rate set applies to
    // (at least one must be true). Optional (each defaults to true).
    applyMon: R.pathOr('', ['Apply_Mon'], rateSet) === 'Y',
    applyTue: R.pathOr('', ['Apply_Tue'], rateSet) === 'Y',
    applyWed: R.pathOr('', ['Apply_Wed'], rateSet) === 'Y',
    applyThu: R.pathOr('', ['Apply_Thu'], rateSet) === 'Y',
    applyFri: R.pathOr('', ['Apply_Fri'], rateSet) === 'Y',
    applySat: R.pathOr('', ['Apply_Sat'], rateSet) === 'Y',
    applySun: R.pathOr('', ['Apply_Sun'], rateSet) === 'Y',
    validateMinMax: R.pathOr('', ['Validate_Min_Max'], rateSet) === 'Y',
    cancelHours: parseInt(R.pathOr('0', ['Cancel_Hours'], rateSet), 10),
  };

  // Parse Vtext fields
  const vtextFields = {};
  const editVtextFields = {};
  for (let i = 1; i <= MAX_VTEXT_FIELDS; i += 1) {
    vtextFields[`vtext${i}`] = R.pathOr('', [`Vtext${i}`], rateSet);
    editVtextFields[`editVtext${i}`] = R.pathOr('', [`EditVtext${i}`], rateSet) === 'Y';
  }

  // Parse rate structures (GroupCost, FITCost, GroupSell, FITSell)
  const rates = {
    groupCost: parseRateStructure(R.pathOr({}, ['GroupCost'], rateSet)),
    fitCost: parseRateStructure(R.pathOr({}, ['FITCost'], rateSet)),
    groupSell: parseRateStructure(R.pathOr({}, ['GroupSell'], rateSet)),
    fitSell: parseRateStructure(R.pathOr({}, ['FITSell'], rateSet)),
  };

  return {
    ...rateSetInfo,
    ...vtextFields,
    editVtextFields,
    rates,
  };
};

const parseTaxes = dateRange => {
  const taxes = R.pathOr({}, ['Taxes'], dateRange);
  const taxInfo = R.pathOr({}, ['TaxInfo'], taxes);
  const taxData = {
    tax: R.pathOr('', ['Tax'], taxInfo),
    taxMainOption: R.pathOr('', ['TaxMainOption'], taxInfo) === 'Y',
    taxSs: R.pathOr('', ['TaxSs'], taxInfo) === 'Y',
    taxTr: R.pathOr('', ['TaxTr'], taxInfo) === 'Y',
    taxQr: R.pathOr('', ['TaxQr'], taxInfo) === 'Y',
    taxEx1: R.pathOr('', ['TaxEx1'], taxInfo) === 'Y',
    taxEx2: R.pathOr('', ['TaxEx2'], taxInfo) === 'Y',
    taxEx3: R.pathOr('', ['TaxEx3'], taxInfo) === 'Y',
    taxEx4: R.pathOr('', ['TaxEx4'], taxInfo) === 'Y',
    taxEx5: R.pathOr('', ['TaxEx5'], taxInfo) === 'Y',
  };
  return taxData;
};

// Basic date range information
const parseBasicInfo = dateRange => ({
  optionCode: R.pathOr('', ['OptionCode'], dateRange),
  optId: R.pathOr('', ['Opt_ID'], dateRange),
  lastUpdate: R.pathOr('', ['LastUpdate'], dateRange),
  priceCode: R.pathOr('', ['Price_Code'], dateRange),
  dateFrom: R.pathOr('', ['Date_From'], dateRange),
  dateTo: R.pathOr('', ['Date_To'], dateRange),
  saleFrom: R.pathOr('', ['Sale_From'], dateRange),
  saleTo: R.pathOr('', ['Sale_To'], dateRange),
  sellBeforeTravel: parseInt(R.pathOr('0', ['SellBeforeTravel'], dateRange), 10),
  sellBeforeType: R.pathOr('', ['SellBeforeType'], dateRange),
  buyCurrency: R.pathOr('', ['Buy_Currency'], dateRange),
  sellCurrency: R.pathOr('', ['Sell_Currency'], dateRange),
});

/**
 * Parse GetRateReply XML structure into a normalized JavaScript object
 * @param {Object} dateRanges - The parsed dateRanges object from XML
 * @returns {Object} Normalized rate data array
 */
const parseGetRatesData = dateRanges => {
  // Ensure DateRange is always an array
  const dateRangesArray = Array.isArray(dateRanges) ? dateRanges : [dateRanges];

  const parsedDateRanges = dateRangesArray.map(dateRange => {
    // Parse Basic information
    const basicInfo = parseBasicInfo(dateRange);

    // Parse RateSet information - handle both single RateSet and multiple RateSets
    const rateSetsContainer = R.pathOr([], ['RateSet'], dateRange);
    const rateSetArrayNormalized = Array.isArray(rateSetsContainer)
      ? rateSetsContainer
      : [rateSetsContainer];
    // Sort rate sets by minSCU in ascending order
    // eslint-disable-next-line max-len
    const rateSets = rateSetArrayNormalized.map(parseRateSet).sort((a, b) => (a.minSCU || 0) - (b.minSCU || 0));

    // Parse Taxes information
    const taxData = parseTaxes(dateRange);

    return {
      ...basicInfo,
      rateSets,
      taxes: taxData,
    };
  });

  return parsedDateRanges;
};

const getEligibleRateTypesCodes = customRatesEligibleRateTypes => {
  // default allow all rate types
  const eligibleRateTypesCodes = Array.from(RATE_STATUS_MAP.values());

  // get eligible rate types codes from the settings
  if (customRatesEligibleRateTypes && customRatesEligibleRateTypes.length > 0) {
    // Convert customRatesEligibleRateTypes to array
    const rateTypesArray = Array.isArray(customRatesEligibleRateTypes)
      ? customRatesEligibleRateTypes
      : customRatesEligibleRateTypes.split(',').map(s => {
        const trimmed = s.trim();
        // ensure that our matching is case insensitive
        return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
      });
    // Filter eligibleRateTypes to only include those that match customRatesEligibleRateTypes
    const matchingRateTypesCodes = rateTypesArray
      .map(key => RATE_STATUS_MAP.get(key))
      .filter(code => code);
    if (matchingRateTypesCodes.length > 0) {
      eligibleRateTypesCodes.length = 0; // Clear the array
      eligibleRateTypesCodes.push(...matchingRateTypesCodes); // Add only matching rate type codes
    }
  }
  return eligibleRateTypesCodes;
};

/*
  Get rates info from Tourplan using Product Connect API

  @param {Object} params - Configuration parameters
  @param {string} optionId - The option ID
  @param {string} productConnectEndpoint - The product connect endpoint
  @param {string} productConnectUser - The product connect user
  @param {string} productConnectUserPassword - The product connect user password
  @param {string} startDate - The start date
  @param {number} chargeUnitQuantity - The charge unit quantity
  @param {Object} axios - The axios instance
  @param {Object} callTourplan - The callTourplan function
  @returns {Object} Parsed configuration object
*/
const getRatesInfoFromProductConnect = async ({
  optionId,
  productConnectEndpoint,
  productConnectUser,
  productConnectUserPassword,
  startDate,
  endDate,
  axios,
  callTourplan,
}) => {
  // Input validation
  if (!optionId || typeof optionId !== 'string') {
    return null;
  }
  if (!productConnectEndpoint || typeof productConnectEndpoint !== 'string') {
    return null;
  }
  if (!productConnectUser || typeof productConnectUser !== 'string') {
    return null;
  }
  if (!productConnectUserPassword || typeof productConnectUserPassword !== 'string') {
    return null;
  }
  if (!startDate || typeof startDate !== 'string') {
    return null;
  }
  if (!endDate || typeof endDate !== 'string') {
    return null;
  }
  const getRatesModel = ({
    GetRateRequest: {
      User: productConnectUser,
      Password: productConnectUserPassword,
      OptionCode: optionId,
      Date_From: startDate,
      Date_To: endDate,
    },
  });

  // Call product connect to get rates info
  const replyObj = await callTourplan({
    model: getRatesModel,
    endpoint: productConnectEndpoint,
    axios,
    xmlOptions: productConnectXmlOptions,
  });
  const dataRanges = R.pathOr([], ['GetRateReply', 'DateRange'], replyObj);
  // Parse the data ranges
  const parsedDateRanges = parseGetRatesData(dataRanges);

  return parsedDateRanges;
};

// Generic function to extract tax rate from tax code (e.g., V20 -> 0.2, G15 -> 0.15)
const extractTaxRate = taxCode => {
  if (!taxCode || typeof taxCode !== 'string') {
    return 0;
  }

  // Extract numeric part from tax code (e.g., "V20" -> "20", "G15" -> "15")
  const numericMatch = taxCode.match(/(\d+)/);
  if (!numericMatch) {
    return 0;
  }

  const percentage = parseInt(numericMatch[0], 10);
  return percentage / 100; // Convert percentage to decimal (20 -> 0.2)
};
/*
  Get price for pax breaks
  @param {Object} rateSets - The rate sets
  @param {Object} paxConfigs - The pax configs
  @param {Object} paxBreaks - The pax breaks
  @returns {Object} The rate sets

  EXAMPLE 1: Room
      paxBreaks:  { childInPxb: false, infantInPxb: false, pxbFields: { pxb1: 9999 } }
      paxConfigs:  {
        RoomConfig: [ { Adults: 2, Children: 0, Infants: 0, RoomType: 'DB' } ]
      }
      rateSets:  {
        groupCost: { roomRates: { SG: 350, TW: 350 } },
        fitCost: { roomRates: { SG: 350, TW: 350 } },
        groupSell: { roomRates: { SG: 350, TW: 350 } },
        fitSell: { roomRates: { SG: 350, TW: 350 } }
      }

  EXAMPLE 2: Car Rental
      paxBreaks:  { childInPxb: true, infantInPxb: true, pxbFields: { pxb1: 9999 } }
      paxConfigs:  { RoomConfig: [ { Adults: 2, Children: 0, Infants: 0 } ] }
      rateSets:  {
        groupCost: {
          ratePerFirstChargeUnit: 132,
          ratePerChildOrSuppliment: 0,
          ratePerInfantOrSuppliment: 0
        },
        fitCost: {
          ratePerFirstChargeUnit: 132,
          ratePerChildOrSuppliment: 0,
          ratePerInfantOrSuppliment: 0
        },
        groupSell: {
          ratePerFirstChargeUnit: 132,
          ratePerChildOrSuppliment: 0,
          ratePerInfantOrSuppliment: 0
        },
        fitSell: {
          ratePerFirstChargeUnit: 132,
          ratePerChildOrSuppliment: 0,
          ratePerInfantOrSuppliment: 0
        }
      }

  EXAMPLE 3: Trasfer
      paxBreaks:  {
        childInPxb: true,
        infantInPxb: true,
        pxbFields: { pxb1: 2, pxb2: 4, pxb3: 9999 }
      }
      paxConfigs:  { RoomConfig: [ { Adults: 2, Children: 0, Infants: 0 } ] }
      rateSets:  {
        groupCost: {
          Adult: { pricePxb1: 129, pricePxb2: 141, pricePxb3: 153 },
          Child: {},
          Infant: {}
        },
        fitCost: {
          Adult: { pricePxb1: 129, pricePxb2: 141, pricePxb3: 153 },
          Child: {},
          Infant: {}
        },
        groupSell: {
          Adult: { pricePxb1: 129, pricePxb2: 141, pricePxb3: 153 },
          Child: {},
          Infant: {}
        },
        fitSell: {
          Adult: { pricePxb1: 129, pricePxb2: 141, pricePxb3: 153 },
          Child: {},
          Infant: {}
        }
      }
*/
const getPriceForPaxBreaks = (rates, paxConfigs, paxBreaks, chargeUnitQuantity) => {
  if (!rates || !rates.fitCost || !paxConfigs || !paxBreaks) {
    return 0;
  }

  const { fitCost } = rates;

  // Get room configuration - assuming first room config for now
  const roomConfig = paxConfigs.RoomConfig && paxConfigs.RoomConfig[0];

  const totalPax = roomConfig.Adults + roomConfig.Children + roomConfig.Infants;

  // CASE 1: Room-based pricing (Example 1)
  if (fitCost.roomRates) {
    // Determine room type based on adults count or explicit room type
    let roomType = roomConfig.RoomType;
    if (roomType === 'DB') {
      // Tourplan treats DB as TW
      roomType = 'TW';
    }
    const roomRate = fitCost.roomRates[roomType];
    if (roomRate !== undefined) {
      return roomRate * chargeUnitQuantity;
    }
    // Fallback to first available room rate
    const firstRoomType = Object.keys(fitCost.roomRates)[0];
    if (firstRoomType) {
      const fallbackRate = fitCost.roomRates[firstRoomType];
      return fallbackRate;
    }
  }

  // CASE 2: Per-person pricing (Example 3 - Car Rental)
  if (fitCost.ratePerFirstChargeUnit !== undefined) {
    let totalCost = 0;

    // Base rate for adults
    totalCost += fitCost.ratePerFirstChargeUnit * chargeUnitQuantity;

    // Add child rates if children are included in pax breaks
    if (paxBreaks.childInPxb && roomConfig.Children > 0) {
      totalCost += (fitCost.ratePerChildOrSuppliment || 0) * chargeUnitQuantity;
    }

    // Add infant rates if infants are included in pax breaks
    if (paxBreaks.infantInPxb && roomConfig.Infants > 0) {
      totalCost += (fitCost.ratePerInfantOrSuppliment || 0) * chargeUnitQuantity;
    }

    return totalCost;
  }

  // CASE 3: Pax break pricing (Example 2 - Transfer)
  if (fitCost.Adult && typeof fitCost.Adult === 'object') {
    // Find the appropriate pax break based on total passengers
    let selectedPxbKey = null;

    // Sort pax breaks to find the right one
    const pxbKeys = Object.keys(paxBreaks.pxbFields || {}).sort((a, b) => {
      const numA = parseInt(a.replace('pxb', ''), 10);
      const numB = parseInt(b.replace('pxb', ''), 10);
      return numA - numB;
    });

    pxbKeys.some(pxbKey => {
      const paxLimit = paxBreaks.pxbFields[pxbKey];
      if (totalPax <= paxLimit) {
        selectedPxbKey = `price${pxbKey.charAt(0).toUpperCase()}${pxbKey.slice(1)}`;
        return true; // Break out of some loop
      }
      return false;
    });

    if (selectedPxbKey) {
      let totalCost = 0;

      // Adult pricing
      if (fitCost.Adult[selectedPxbKey] !== undefined) {
        totalCost += fitCost.Adult[selectedPxbKey];
      }

      // Child pricing (if children are in pax breaks and we have rates)
      const hasChildRate = paxBreaks.childInPxb && roomConfig.Children > 0
        && fitCost.Child && fitCost.Child[selectedPxbKey] !== undefined;
      if (hasChildRate) {
        totalCost += fitCost.Child[selectedPxbKey];
      }

      // Infant pricing (if infants are in pax breaks and we have rates)
      const hasInfantRate = paxBreaks.infantInPxb && roomConfig.Infants > 0
        && fitCost.Infant && fitCost.Infant[selectedPxbKey] !== undefined;
      if (hasInfantRate) {
        totalCost += fitCost.Infant[selectedPxbKey];
      }
      return totalCost;
    }
  }

  return 0;
};

/*
  Get cost info from Product Connect API

  @param {Object} params - Configuration parameters
  @param {string} optionId - The option ID
  @param {string} productConnectEndpoint - The product connect endpoint
  @param {string} productConnectUser - The product connect user
  @param {string} productConnectUserPassword - The product connect user password
  @param {Object} axios - The axios instance
  @param {Object} callTourplan - The callTourplan function
  @param {string} agentCurrency - Agent currency code; only rates in this currency are returned
  @returns {Object} Parsed cost info
*/
const getCostFromProductConnect = async ({
  optionId,
  productConnectEndpoint,
  productConnectUser,
  productConnectUserPassword,
  axios,
  callTourplan,
  startDate,
  endDate,
  startDateToUse,
  customRatesEligibleRateTypes,
  roomConfigs,
  paxBreaks,
  daysToChargeAtLastRate,
  agentCurrency,
}) => {
  // Parallelize Product Connect API calls for better performance
  const productConnectDateRanges = await getRatesInfoFromProductConnect({
    optionId,
    productConnectEndpoint,
    productConnectUser,
    productConnectUserPassword,
    startDate,
    endDate,
    axios,
    callTourplan,
  });
  if (!productConnectDateRanges || productConnectDateRanges.length === 0) {
    console.warn(PRODUCT_CONNECT_RATES_INFO_ERROR_MESSAGE);
    return null;
  }

  // Get rates from the first date range that has a matching rate set with eligible rate status
  const eligibleRateTypesCodes = getEligibleRateTypesCodes(customRatesEligibleRateTypes);

  const matchingProductConnectRateSet = productConnectDateRanges.find(dateRange => {
    // eslint-disable-next-line max-len
    if (agentCurrency && dateRange.sellCurrency && dateRange.sellCurrency.toUpperCase() !== agentCurrency.toUpperCase()) {
      return false;
    }
    const { matchingRateSet, rateSetMatchingError } = getMatchingRateSet(
      dateRange.rateSets,
      startDateToUse,
      daysToChargeAtLastRate,
      eligibleRateTypesCodes,
    );
    // eslint-disable-next-line max-len
    return matchingRateSet && !rateSetMatchingError ? matchingRateSet : null;
  });

  if (!matchingProductConnectRateSet) {
    return {
      cost: null,
      error: true,
      message: RATE_NOT_ELIGIBLE_ERROR_MESSAGE,
    };
  }

  let cost = 0;
  const taxRate = extractTaxRate(matchingProductConnectRateSet.taxes.tax);
  cost = getPriceForPaxBreaks(
    matchingProductConnectRateSet.rates,
    roomConfigs,
    paxBreaks,
    daysToChargeAtLastRate,
  );

  return {
    cost,
    taxRate,
    error: false,
    message: matchingProductConnectRateSet.rateSetMatchingError,
  };
};

module.exports = {
  getCostFromProductConnect,
};
