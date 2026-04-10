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

  let searchCriterias = [];
  let applyBaseSearchFilters = false;

  // Build base search filters.
  // If booking reference(s) or bookingid are provided these those are used.
  // But if no booking reference(s) or bookingid are provided then we use the travel
  // dates window as a base search filters. To keep the search bounded (and not crash Tourplan)
  // If purchase dates are provided then its part of base search filters.
  const travelDateWindow = getDefaultTravelDateWindow(travelDateStart, travelDateEnd);
  const baseSearchFilters = {
    TravelDateFrom: travelDateWindow.travelDateFrom,
    TravelDateTo: travelDateWindow.travelDateTo,
    ...(purchaseDateStart && { EnteredDateFrom: purchaseDateStart }),
    ...(purchaseDateEnd && { EnteredDateTo: purchaseDateEnd }),
  };

  // Step1: Build search criterias based on the provided search criteria.
  const normalizedBookingReferenceIds = (
    Array.isArray(bookingReferenceIds) ? bookingReferenceIds : [bookingReferenceIds]
  ).filter(v => v != null).map(v => escapeInvalidXmlChars(String(v).trim())).filter(Boolean);

  if (normalizedBookingReferenceIds.length) {
    // if bookingReferenceIds are provided other search criteria are ignored
    searchCriterias = R.uniq(normalizedBookingReferenceIds).map(ref => ({ Ref: ref }));
  } else if (bookingId) {
    // if bookingId is provided other search criteria are ignored
    // and we search for bookings by bookingId, ref & agentRef
    searchCriterias = ['BookingId', 'Ref', 'AgentRef'].map(key => ({ [key]: escapeInvalidXmlChars(bookingId) }));
  } else {
    applyBaseSearchFilters = true;
    if (name) {
      searchCriterias.push({ NameContains: escapeInvalidXmlChars(name) });
    }
  }
  // Step2: Remove duplicate criteria so repeated refs don't trigger duplicate upstream calls.
  searchCriterias = R.uniqBy(JSON.stringify, searchCriterias);

  // Step3: Search for bookings based on the search criterias.
  const allSearches = searchCriterias.length
    ? searchCriterias.map(async keyObj => {
      let reply;
      try {
        reply = await callTourplan(getPayload('ListBookingsRequest', {
          ...(applyBaseSearchFilters && { ...baseSearchFilters }),
          ...keyObj,
        }));
        /*
          <Reply>
            <ListBookingsReply>
              <BookingHeaders>
                <BookingHeader>
                  <BookingId>320984</BookingId>
                  <Ref>ALFI399113</Ref>
                  <Name>Barbara Solomon x2 2554776</Name>
                  <NameAlias/>
                  <QB>B</QB>
                  <Consult>TEST AGENT OWNER</Consult>
                  <AgentRef>2554776</AgentRef>
                  <TravelDate>2025-04-06</TravelDate>
                  <EnteredDate>2025-01-30</EnteredDate>
                  <BookingStatus>Quotation iCom CNX</BookingStatus>
                  <BookingType>F</BookingType>
                  <IsInternetBooking>Y</IsInternetBooking>
                  <Currency>GBP</Currency>
                  <TotalPrice>1016738</TotalPrice>
                </BookingHeader>
              </BookingHeaders>
            </ListBookingsReply>
          </Reply>
        */
      } catch (err) {
        const errMsg = typeof err === 'string' ? err : (err && err.message) || String(err);
        if (errMsg.includes('Request failed with status code')) {
          throw Error(errMsg);
        }
        // if it's not server error, we just considered as no booking is found
        reply = { ListBookingsReply: { BookingHeaders: { BookingHeader: [] } } };
      }
      return reply;
    })
    : [callTourplan(getPayload('ListBookingsRequest', baseSearchFilters))];
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
  console.debug('BOOKINGS FOUND: ', bookings.length);
  return {
    bookings: bookings.filter(b => b),
  };
};

module.exports = {
  searchItineraries,
};
