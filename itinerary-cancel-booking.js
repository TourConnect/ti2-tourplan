const assert = require('assert');
const R = require('ramda');
const {
  hostConnectXmlOptions,
  escapeInvalidXmlChars,
} = require('./utils');

const getIdentifier = payload => {
  const bookingId = payload.bookingId || payload.id;
  if (bookingId) {
    return {
      field: 'BookingId',
      value: String(bookingId),
    };
  }
  const bookingRef = payload.ref || payload.reference;
  if (bookingRef) {
    return {
      field: 'Ref',
      value: escapeInvalidXmlChars(String(bookingRef)),
    };
  }
  return null;
};

const extractCancellationReply = replyObj => (
  R.path(['CancelServicesReply'], replyObj)
  || {}
);

const getServiceStatusList = cancellationReply => {
  let serviceStatuses = R.pathOr([], ['ServiceStatuses', 'ServiceStatus'], cancellationReply);
  if (!Array.isArray(serviceStatuses)) serviceStatuses = [serviceStatuses];
  return serviceStatuses
    .map(serviceStatus => R.path(['Status'], serviceStatus))
    .filter(Boolean)
    .map(status => String(status).toUpperCase());
};

const getAggregateServiceStatus = cancellationReply => {
  const statuses = getServiceStatusList(cancellationReply);
  if (!statuses.length) return null;
  const uniqueStatuses = [...new Set(statuses)];
  if (uniqueStatuses.length === 1) return uniqueStatuses[0];
  return 'MIXED';
};

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
 * Cancels a booking by id or reference
 * @param {Object} params - The parameters for the cancellation
 * @param {Object} params.axios - The axios instance
 * @param {Object} params.token - The token for the cancellation
 * @param {Object} params.payload - The payload for the cancellation
 * @param {Object} params.callTourplan - The callTourplan function
 * @returns {Promise<Object>} The cancellation response
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
  const identifier = getIdentifier(payload);
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
