const R = require('ramda');
const moment = require('moment');
const Promise = require('bluebird');
const { escapeInvalidXmlChars } = require('./utils');
const { hostConnectXmlOptions } = require('./utils');
const { translateItineraryBooking } = require('../resolvers/itinerary');

const searchItineraries = async ({
  token: {
    hostConnectAgentID,
    hostConnectAgentPassword,
    hostConnectEndpoint,
  },
  axios,
  typeDefsAndQueries: {
    itineraryBookingTypeDefs,
    itineraryBookingQuery,
  },
  payload: {
    purchaseDateStart,
    purchaseDateEnd,
    bookingId,
    name,
  },
  callTourplan,
}) => {
  const getPayload = (RequestType, RequestInput) => ({
    model: {
      [RequestType]: {
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
        ...RequestInput,
      },
    },
    endpoint: hostConnectEndpoint,
    axios,
    xmlOptions: hostConnectXmlOptions,
  });
  const listBookingPayload = getPayload('ListBookingsRequest', {
    EnteredDateFrom: purchaseDateStart || moment().subtract(6, 'month').format('YYYY-MM-DD'),
    EnteredDateTo: purchaseDateEnd || moment().format('YYYY-MM-DD'),
  });
  let searchCriterias = [];
  if (bookingId) {
    searchCriterias = ['BookingId', 'Ref', 'AgentRef'].map(key => ({ [key]: escapeInvalidXmlChars(bookingId) }));
  }
  if (name) {
    searchCriterias.push({ NameContains: escapeInvalidXmlChars(name) });
  }
  const allSearches = searchCriterias.length
    ? searchCriterias.map(async keyObj => {
      let reply;
      try {
        reply = await callTourplan(getPayload('ListBookingsRequest', keyObj));
      } catch (err) {
        if (err.includes && err.includes('Request failed with status code')) {
          throw Error(err);
        }
        // if it's not server error, we just considered as no booking is found
        // console.log('error in searchBooking', err);
        reply = { ListBookingsReply: { BookingHeaders: { BookingHeader: [] } } };
      }

      // {"ListBookingsReply":
      //  {"BookingHeaders":
      //    {"BookingHeader":[
      //        {"AgentRef":"2399181","BookingId":"314164","BookingStatus":"Quotation","BookingType":"F",
      //          "Consult":null,"Currency":"GBP","EnteredDate":"2024-05-23","IsInternetBooking":"Y",
      //          "Name":"Mr. Robert Slavonia x2 2399181","QB":"Q","Ref":"ALFI393309","TotalPrice":"583143",
      //          "TravelDate":"2024-07-09"},{"AgentRef":"666666/1","BookingId":"315357",
      //          "BookingStatus":"Quotation","BookingType":"F","Consult":null,"Currency":"GBP",
      //          "EnteredDate":"2024-06-04","IsInternetBooking":"Y","Name":"Robert Guerrerio x3 2413898",
      //          "QB":"Q","Ref":"ALFI393503","TotalPrice":"2309452","TravelDate":"2024-08-31"
      //        }
      //     ]}
      // }}
      return reply;
    })
    : [callTourplan(listBookingPayload)];
  const replyObjs = await Promise.all(allSearches);
  const bookingHeaders = R.flatten(replyObjs.map(o => R.pathOr([], ['ListBookingsReply', 'BookingHeaders', 'BookingHeader'], o)));
  const bookings = await Promise.map(bookingHeaders, async bookingHeader => {
    try {
      const getBookingPayload = getPayload('GetBookingRequest', {
        BookingId: R.prop('BookingId', bookingHeader),
        ReturnAccountInfo: 'Y',
        ReturnRoomConfigs: 'Y',
      });
      const bookingReply = await callTourplan(getBookingPayload);
      const booking = R.path(['GetBookingReply'], bookingReply);
      const newBooking = await translateItineraryBooking({
        rootValue: booking,
        typeDefs: itineraryBookingTypeDefs,
        query: itineraryBookingQuery,
      });
      return newBooking;
    } catch (err) {
      console.error('error in searchBooking', err.message);
      return null;
    }
  }, { concurrency: 10 });
  return {
    bookings: bookings.filter(b => b),
  };
};

module.exports = {
  searchItineraries,
};
