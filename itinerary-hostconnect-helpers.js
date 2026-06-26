const R = require('ramda');
const { escapeInvalidXmlChars } = require('./utils');

const getBookingIdentifier = payload => {
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

const toServiceStatusArray = reply => {
  let serviceStatuses = R.pathOr([], ['ServiceStatuses', 'ServiceStatus'], reply);
  if (!Array.isArray(serviceStatuses)) serviceStatuses = [serviceStatuses];
  return serviceStatuses.filter(Boolean);
};

const getAggregateServiceStatus = reply => {
  const statuses = toServiceStatusArray(reply)
    .map(serviceStatus => R.path(['Status'], serviceStatus))
    .filter(Boolean)
    .map(status => String(status).toUpperCase());
  if (!statuses.length) return null;
  const uniqueStatuses = [...new Set(statuses)];
  if (uniqueStatuses.length === 1) return uniqueStatuses[0];
  return 'MIXED';
};

const mapServiceStatusLines = reply => toServiceStatusArray(reply).map(serviceStatus => ({
  ref: R.path(['Ref'], serviceStatus),
  serviceLineId: R.path(['ServiceLineId'], serviceStatus),
  date: R.path(['Date'], serviceStatus),
  sequenceNumber: R.path(['SequenceNumber'], serviceStatus),
  status: R.path(['Status'], serviceStatus),
}));

module.exports = {
  getBookingIdentifier,
  toServiceStatusArray,
  getAggregateServiceStatus,
  mapServiceStatusLines,
};
