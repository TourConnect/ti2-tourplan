const R = require('ramda');
const Promise = require('bluebird');
const { escapeInvalidXmlChars, hostConnectXmlOptions } = require('./utils');
const { translateItineraryBooking } = require('./resolvers/itinerary');

const toIsoDate = date => date.toISOString().slice(0, 10);

const shiftIsoDateByYears = (isoDate, years) => {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCFullYear(parsed.getUTCFullYear() + years);
  return toIsoDate(parsed);
};

/** Years to extend the travel window when start or end is missing. */
const TRAVEL_WINDOW_SPAN_YEARS = 2;

/**
 * Get the default travel date window based on the travelDateStart and travelDateEnd
 * @param {string} travelDateStart - The start date of the travel date window
 * @param {string} travelDateEnd - The end date of the travel date window
 * @returns {Object} - The travel date window
 */
const getDefaultTravelDateWindow = (travelDateStart, travelDateEnd) => {
  if (travelDateStart && travelDateEnd) {
    return {
      travelDateFrom: travelDateStart,
      travelDateTo: travelDateEnd,
    };
  }

  if (travelDateStart && !travelDateEnd) {
    const derivedEnd = shiftIsoDateByYears(
      travelDateStart,
      TRAVEL_WINDOW_SPAN_YEARS,
    );
    return {
      travelDateFrom: travelDateStart,
      travelDateTo: derivedEnd || travelDateStart,
    };
  }

  if (!travelDateStart && travelDateEnd) {
    const derivedStart = shiftIsoDateByYears(
      travelDateEnd,
      -TRAVEL_WINDOW_SPAN_YEARS,
    );
    return {
      travelDateFrom: derivedStart || travelDateEnd,
      travelDateTo: travelDateEnd,
    };
  }

  const now = new Date();
  const from = new Date(now);
  const to = new Date(now);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  to.setUTCFullYear(to.getUTCFullYear() + 1);
  return {
    travelDateFrom: toIsoDate(from),
    travelDateTo: toIsoDate(to),
  };
};

const fetchFullBookingByBookingId = async (
  fieldName,
  fieldValue,
  callTourplan,
  getPayload,
  hostConnectAgentID,
  itineraryBookingTypeDefs,
  itineraryBookingQuery,
) => {
  try {
    const getBookingPayload = getPayload('GetBookingRequest', {
      [fieldName]: escapeInvalidXmlChars(fieldValue),
      ReturnAccountInfo: 'Y',
      ReturnRoomConfigs: 'Y',
    });
    const bookingReply = await callTourplan(getBookingPayload);
    const booking = R.path(['GetBookingReply'], bookingReply);
    return await translateItineraryBooking({
      rootValue: booking && { ...booking, agentId: hostConnectAgentID },
      typeDefs: itineraryBookingTypeDefs,
      query: itineraryBookingQuery,
    });
  } catch (err) {
    const detail = err instanceof Error ? (err.stack || err.message) : String(err);
    console.error('error in searchBooking', detail);
    return null;
  }
};

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
    travelDateStart,
    travelDateEnd,
    bookingReferenceIds,
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

  // if bookingReferenceIds are provided, we use them to search for bookings
  // and ignore the other search filters
  const normalizedBookingReferenceIds = (
    Array.isArray(bookingReferenceIds) ? bookingReferenceIds : [bookingReferenceIds]
  )
    .filter(v => v != null)
    .map(v => String(v).trim())
    .filter(Boolean);
  if (normalizedBookingReferenceIds.length) {
    const bookings = await Promise.map(
      R.uniq(normalizedBookingReferenceIds),
      bookingIdValue => fetchFullBookingByBookingId(
        'Ref',
        bookingIdValue,
        callTourplan,
        getPayload,
        hostConnectAgentID,
        itineraryBookingTypeDefs,
        itineraryBookingQuery,
      ),
      { concurrency: 10 },
    );
    const filtered = bookings.filter(b => b);
    return { bookings: filtered };
  }

  // if traveldates are provided those are used else default to +/- 1 year
  // along with purchase dates, booking id & name are used to search for bookings
  const travelDateWindow = getDefaultTravelDateWindow(travelDateStart, travelDateEnd);
  const baseSearchFilters = {
    // Keep search bounded: use explicit travel window, otherwise default to +/- 1 year.
    TravelDateFrom: travelDateWindow.travelDateFrom,
    TravelDateTo: travelDateWindow.travelDateTo,
    ...(purchaseDateStart && { EnteredDateFrom: purchaseDateStart }),
    ...(purchaseDateEnd && { EnteredDateTo: purchaseDateEnd }),
  };
  const listBookingPayload = getPayload('ListBookingsRequest', baseSearchFilters);
  let searchCriterias = [];
  if (bookingId) {
    searchCriterias = ['BookingId', 'Ref', 'AgentRef'].map(key => ({ [key]: escapeInvalidXmlChars(bookingId) }));
  }
  if (name) {
    searchCriterias.push({ NameContains: escapeInvalidXmlChars(name) });
  }
  // Remove duplicate criteria so repeated refs don't trigger duplicate upstream calls.
  searchCriterias = R.uniqBy(JSON.stringify, searchCriterias);

  const allSearches = searchCriterias.length
    ? searchCriterias.map(async keyObj => {
      let reply;
      try {
        reply = await callTourplan(getPayload('ListBookingsRequest', {
          ...baseSearchFilters,
          ...keyObj,
        }));
      } catch (err) {
        const errMsg = typeof err === 'string' ? err : (err && err.message) || String(err);
        if (errMsg.includes('Request failed with status code')) {
          throw Error(errMsg);
        }
        // if it's not server error, we just considered as no booking is found
        reply = { ListBookingsReply: { BookingHeaders: { BookingHeader: [] } } };
      }

      // {"ListBookingsReply":
      //  {"BookingHeaders":
      //    {"BookingHeader":[
      //        {"AgentRef":"2399181","BookingId":"314164",
      //          "BookingStatus":"Quotation","BookingType":"F",
      //          "Consult":null,"Currency":"GBP","EnteredDate":"2024-05-23",
      //          "IsInternetBooking":"Y",
      //          "Name":"Mr. Robert Slavonia x2 2399181","QB":"Q","Ref":"ALFI393309",
      //          "TotalPrice":"583143",
      //          "TravelDate":"2024-07-09"},{"AgentRef":"666666/1","BookingId":"315357",
      //          "BookingStatus":"Quotation","BookingType":"F","Consult":null,
      //          "Currency":"GBP",
      //          "EnteredDate":"2024-06-04","IsInternetBooking":"Y",
      //          "Name":"Robert Guerrerio x3 2413898",
      //          "QB":"Q","Ref":"ALFI393503","TotalPrice":"2309452","TravelDate":"2024-08-31"
      //        }
      //     ]}
      // }}
      return reply;
    })
    : [callTourplan(listBookingPayload)];
  const replyObjs = await Promise.all(allSearches);
  const bookingHeadersRaw = R.flatten(
    replyObjs.map(o => R.pathOr(
      [],
      ['ListBookingsReply', 'BookingHeaders', 'BookingHeader'],
      o,
    )),
  );
  const bookingHeaders = R.uniqBy(
    R.prop('BookingId'),
    bookingHeadersRaw.filter(h => {
      const id = R.prop('BookingId', h);
      return id != null && String(id).trim() !== '';
    }),
  );
  const bookings = await Promise.map(
    bookingHeaders,
    header => fetchFullBookingByBookingId(
      'BookingId',
      R.prop('BookingId', header),
      callTourplan,
      getPayload,
      hostConnectAgentID,
      itineraryBookingTypeDefs,
      itineraryBookingQuery,
    ),
    { concurrency: 10 },
  );
  return {
    bookings: bookings.filter(b => b),
  };
};

module.exports = {
  searchItineraries,
};
