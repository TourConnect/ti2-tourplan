const R = require('ramda');
const {
  getRoomConfigs,
  escapeInvalidXmlChars,
  CUSTOM_RATE_ID_NAME,
  CUSTOM_NO_RATE_NAME,
  hostConnectXmlOptions,
} = require('./utils');

const DEFAULT_TOURPLAN_SERVICE_STATUS = 'IR';
const SERVICE_CANNOT_BE_ADDED_ERROR_MESSAGE = 'Service cannot be added to quote for the requested date/stay. (e.g. no rates, block out period, on request, minimum stay etc.)';

const addServiceToItinerary = async ({
  axios,
  token: {
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
    customRateServiceStatus,
  },
  payload: {
    quoteName,
    itineraryOwner,
    rateId,
    quoteId,
    optionId,
    startDate,
    reference,
    /*
    paxConfigs: [{ roomType: 'DB', adults: 2 }, { roomType: 'TW', children: 2 }]
    */
    paxConfigs,
    /*
    The number of second charge units required (second charge units are discussed
    in the OptionInfo section). Should only be specified for options that have SCUs.
    Defaults to 1.
    */
    chargeUnitQuantity,
    extras,
    startTime,
    puInfo,
    doInfo,
    notes,
    QB,
    directHeaderPayload,
    directLinePayload,
    customFieldValues = [],
    availCheckObj,
  },
  callTourplan,
}) => {
  let pricing = null;
  const tourplanServiceStatus = customRateServiceStatus || DEFAULT_TOURPLAN_SERVICE_STATUS;
  const cfvPerService = customFieldValues.filter(f => f.isPerService && f.value)
    .reduce((acc, f) => {
      if (f.type === 'extended-option') {
        acc[f.id] = f.value.value || f.value;
      } else {
        acc[f.id] = f.value;
      }
      return acc;
    }, {});

  const rateIdFromAvailCheckObj = R.path(['rateId'], availCheckObj);
  if (availCheckObj &&
    (rateIdFromAvailCheckObj === CUSTOM_RATE_ID_NAME
      || rateIdFromAvailCheckObj === CUSTOM_NO_RATE_NAME)) {
    const itemDescription = `${rateIdFromAvailCheckObj} - ${paxConfigs[0].roomType || 'Double'}`;
    pricing = {
      ItemDescription: itemDescription,
      CostCurrency: R.path(['currency'], availCheckObj),
      AgentCurrency: R.path(['agentCurrency'], availCheckObj),
      CostConversionRate: R.pathOr(1, ['conversionRate'], availCheckObj),
      CostExclusive: R.path(['costPrice'], availCheckObj),
      RetailExclusive: R.path(['totalPrice'], availCheckObj),
      SellExclusive: R.path(['sellPrice'], availCheckObj),
      AgentExclusive: R.path(['agentPrice'], availCheckObj),

      // Tax - adding only mandatory ones
      RetailTax: R.pathOr(0, ['retailTax'], availCheckObj), // necessary if RetailExclusive is provided
      SellTax: R.pathOr(0, ['sellTax'], availCheckObj), // necessary if SellExclusive is provided
      CostTax: R.pathOr(0, ['costTax'], availCheckObj), // necessary if CostExclusive is provided
      AgentTax: R.pathOr(0, ['agentTax'], availCheckObj), // necessary if AgentExclusive is provided
    };
  }
  // if external pickup and dropoff details are provided, use that info
  // 1. If start time is provided send it in puTime
  // 2. if extenral details are provided, send them in puRemark in the format:
  //    (ExtPointName, ExtPointInfo, Address, Minutes prior)
  // 3. the following shoud be sent:
  //    puTime: '0930'
  //    puRemark: 'Airport Pickup,Meet at arrivals hall,Airport Terminal 1,45,'
  //    doTime: '1130' (Note: this is not used for external dropoff details)
  //    doRemark: 'Hotel Dropoff,Drop at hotel entrance,456 Downtown Ave, City Center,15,',
  let puTime = null;
  let puRemark = null;
  if (puInfo) {
    if (puInfo.time || puInfo.location || puInfo.flightDetails) {
      const puLocation = puInfo.location ? `${puInfo.location},` : '';
      const puFlightDetails = puInfo.flightDetails ? `${puInfo.flightDetails},` : '';
      if (puInfo.time && puInfo.time.replace(/\D/g, '')) {
        puTime = puInfo.time.replace(/\D/g, '');
      }
      puRemark = escapeInvalidXmlChars(`${puLocation}${puFlightDetails}`);
    } else if (puInfo.address || puInfo.pointName || puInfo.pointInfo || puInfo.minutesPrior) {
      if (startTime) {
        puTime = startTime.replace(/\D/g, '');
      }
      puRemark = escapeInvalidXmlChars(`${puInfo.pointName ? `${puInfo.pointName},` : ''}${puInfo.pointInfo ? `${puInfo.pointInfo},` : ''}${puInfo.address ? `${puInfo.address},` : ''}${puInfo.minutesPrior ? `${puInfo.minutesPrior},` : ''}`);
    }
  }

  let doTime = null;
  let doRemark = null;
  if (doInfo) {
    if (doInfo.time || doInfo.location || doInfo.flightDetails) {
      const doLocation = doInfo.location ? `${doInfo.location},` : '';
      const doFlightDetails = doInfo.flightDetails ? `${doInfo.flightDetails},` : '';
      if (doInfo.time && doInfo.time.replace(/\D/g, '')) {
        doTime = doInfo.time.replace(/\D/g, '');
      }
      doRemark = escapeInvalidXmlChars(`${doLocation}${doFlightDetails}`);
    } else if (doInfo.address || doInfo.pointName || doInfo.pointInfo || doInfo.minutesPrior) {
      // Note: There is no doTime for external dropoff details
      doRemark = escapeInvalidXmlChars(`${doInfo.pointName ? `${doInfo.pointName},` : ''}${doInfo.pointInfo ? `${doInfo.pointInfo},` : ''}${doInfo.address ? `${doInfo.address},` : ''}${doInfo.minutesPrior ? `${doInfo.minutesPrior},` : ''}`);
    }
  }

  const model = {
    AddServiceRequest: {
      AgentID: hostConnectAgentID,
      Password: hostConnectAgentPassword,
      // Note: Consult is optional but if provided is limited to 60 characters.
      // In some systems is forced to uppercase. It is ignored if the Agent ID
      // supplied is a sub-login.
      // The field name in XML is Consult but on the TourPlan UI it is called Contact.
      ...(itineraryOwner ? {
        Consult: escapeInvalidXmlChars(itineraryOwner).substring(0, 60),
      } : {}),
      ...(quoteId ? {
        ExistingBookingInfo: { BookingId: quoteId },
      } : {
        NewBookingInfo: {
          Name: escapeInvalidXmlChars(quoteName),
          QB: QB || 'Q',
          ...(directHeaderPayload || {}),
        },
      }),
      ...(puTime ? { puTime } : {}),
      ...(puRemark ? { puRemark } : {}),
      ...(doTime ? { doTime } : {}),
      ...(doRemark ? { doRemark } : {}),
      ...(extras && extras.filter(e => e.selectedExtra && e.selectedExtra.id).length ? {
        ExtraQuantities: {
          ExtraQuantityItem: extras.filter(e => e.selectedExtra && e.selectedExtra.id).map(e => ({
            SequenceNumber: e.selectedExtra.id,
            ExtraQuantity: e.quantity,
          })),
        },
      } : {}),
      Remarks: escapeInvalidXmlChars(notes).slice(0, 220),
      Opt: optionId,
      DateFrom: startDate,
      RateId: rateId || 'Default',
      ...(pricing ? { Pricing: pricing } : {}),
      ...(pricing ? { TourplanServiceStatus: tourplanServiceStatus } : {}),
      SCUqty: (() => {
        const num = parseInt(chargeUnitQuantity, 10);
        if (Number.isNaN(num) || num < 1) return 1;
        return num;
      })(),
      AgentRef: reference,
      RoomConfigs: getRoomConfigs(paxConfigs),
      ...(directLinePayload || {}),
      ...(cfvPerService || {}),
    },
  };
  const replyObj = await callTourplan({
    model,
    endpoint: hostConnectEndpoint,
    axios,
    xmlOptions: hostConnectXmlOptions,
  });
  return {
    message: R.path(['AddServiceReply', 'Status'], replyObj)
    === 'NO' ? SERVICE_CANNOT_BE_ADDED_ERROR_MESSAGE : '',
    booking: {
      id: R.path(['AddServiceReply', 'BookingId'], replyObj) || quoteId,
      reference: R.path(['AddServiceReply', 'Ref'], replyObj),
      linePrice: R.path(['AddServiceReply', 'Services', 'Service', 'LinePrice'], replyObj),
      lineId: R.path(['AddServiceReply', 'ServiceLineId'], replyObj),
    },
  };
};

module.exports = {
  addServiceToItinerary,
};
