const assert = require('assert');
const R = require('ramda');
const {
  hostConnectXmlOptions,
} = require('./utils');
const {
  getBookingIdentifier,
  getAggregateServiceStatus,
} = require('./itinerary-hostconnect-helpers');

const extractCancellationReply = replyObj => (
  R.path(['CancelServicesReply'], replyObj)
  || {}
);

const normalizeCancellationResponse = (replyObj, payload, identifier) => {
  const cancellationReply = extractCancellationReply(replyObj);
  const aggregateServiceStatus = getAggregateServiceStatus(cancellationReply);
  return {
    cancelServicesReply: cancellationReply,
    cancellation: {
      id: R.path(['BookingId'], cancellationReply) || identifier.value,
      status: aggregateServiceStatus
        || R.path(['BookingStatus'], cancellationReply)
        || R.path(['Status'], cancellationReply)
        || payload.status
        || 'Cancelled',
    },
  };
};

/**
 * Cancels a booking by id or reference via HostConnect CancelServicesRequest.
 */
const cancelBooking = async ({
  axios,
  token: {
    hostConnectEndpoint,
    hostConnectAgentID,
    hostConnectAgentPassword,
  },
  payload = {},
  callTourplan,
}) => {
  assert(hostConnectEndpoint, 'Must provide token.hostConnectEndpoint for booking cancellation');
  assert(hostConnectAgentID, 'Must provide token.hostConnectAgentID for booking cancellation');
  assert(hostConnectAgentPassword, 'Must provide token.hostConnectAgentPassword for booking cancellation');
  const identifier = getBookingIdentifier(payload);
  assert(identifier, 'Must provide booking id or reference for cancellation');

  const baseRequest = {
    AgentID: hostConnectAgentID,
    Password: hostConnectAgentPassword,
    [identifier.field]: identifier.value,
  };
  const replyObj = await callTourplan({
    model: {
      CancelServicesRequest: {
        ...baseRequest,
        ReturnBooking: 'Y',
      },
    },
    endpoint: hostConnectEndpoint,
    axios,
    xmlOptions: hostConnectXmlOptions,
  });
  return normalizeCancellationResponse(replyObj, payload, identifier);
};

module.exports = {
  cancelBooking,
};
