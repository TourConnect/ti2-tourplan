const assert = require('assert');
const R = require('ramda');
const { hostConnectXmlOptions } = require('./utils');
const {
  getBookingIdentifier,
  getAggregateServiceStatus,
  mapServiceStatusLines,
} = require('./itinerary-hostconnect-helpers');

const extractConfirmBookingReply = replyObj => (
  R.path(['QuoteToBookReply'], replyObj)
  || {}
);

const normalizeConfirmBookingResponse = (replyObj, payload, identifier) => {
  const confirmBookingReply = extractConfirmBookingReply(replyObj);
  const aggregateServiceStatus = getAggregateServiceStatus(confirmBookingReply);
  return {
    confirmBookingReply,
    booking: {
      ref: R.path(['Ref'], confirmBookingReply),
      id: R.path(['BookingId'], confirmBookingReply) || identifier.value,
      status: aggregateServiceStatus
        || R.path(['BookingStatus'], confirmBookingReply)
        || R.path(['Status'], confirmBookingReply)
        || payload.status
        || 'Confirmed',
      serviceLines: mapServiceStatusLines(confirmBookingReply),
    },
  };
};

/**
 * Converts a quote to a confirmed booking via HostConnect QuoteToBookRequest.
 * Inventory is allocated for each service line; returned ServiceStatus values
 * indicate whether allocation succeeded per line.
 */
const confirmBooking = async ({
  axios,
  token: {
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
  },
  payload = {},
  callTourplan,
}) => {
  assert(hostConnectEndpoint, 'Must provide token.hostConnectEndpoint for confirm booking');
  assert(hostConnectAgentID, 'Must provide token.hostConnectAgentID for confirm booking');
  assert(hostConnectAgentPassword, 'Must provide token.hostConnectAgentPassword for confirm booking');
  const identifier = getBookingIdentifier(payload);
  assert(identifier, 'Must provide booking id or reference for confirm booking');

  const baseRequest = {
    AgentID: hostConnectAgentID,
    Password: hostConnectAgentPassword,
    [identifier.field]: identifier.value,
  };
  const replyObj = await callTourplan({
    model: {
      QuoteToBookRequest: baseRequest,
    },
    endpoint: hostConnectEndpoint,
    axios,
    xmlOptions: hostConnectXmlOptions,
  });
  return normalizeConfirmBookingResponse(replyObj, payload, identifier);
};

module.exports = {
  confirmBooking,
};
