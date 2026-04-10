const R = require('ramda');
const Promise = require('bluebird');
const { escapeInvalidXmlChars, hostConnectXmlOptions } = require('./utils');
const { translateItineraryBooking } = require('./resolvers/itinerary');

/** Years to extend the travel window when start or end is missing. */
const TRAVEL_WINDOW_SPAN_YEARS = 2;

/**
 * Extract the date prefix from a string in the format YYYY-MM-DD.
 * @param {string} value - The string to extract the date prefix from.
 * @returns {string} The date prefix.
 */
const isoDatePrefix = value => {
  if (value == null) return null;
  const m = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

/**
 * Convert a date to an ISO date string (YYYY-MM-DD).
 * @param {Date} date - The date to convert.
 * @returns {string} The ISO date string.
 */
const toIsoDate = date => date.toISOString().slice(0, 10);

/**
 * Shift an ISO calendar date (YYYY-MM-DD) by a number of months in UTC.
 * Prefer over setUTCFullYear(+/-N) for calendar-aware ranges and consistent behavior
 * across leap years and odd TRAVEL_WINDOW_SPAN_YEARS values (e.g. 3 years => 36 months).
 */
const shiftIsoDateByMonths = (isoDate, months) => {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  return toIsoDate(parsed);
};

/**
 * Normalize order (from <= to) and cap `to` so the range is at most maxSpanMonths from `from`.
 */
const clampIsoDateRangeToMaxSpanMonths = (isoFrom, isoTo, maxSpanMonths) => {
  const from = isoFrom <= isoTo ? isoFrom : isoTo;
  let to = isoFrom <= isoTo ? isoTo : isoFrom;
  const cappedTo = shiftIsoDateByMonths(from, maxSpanMonths);
  if (cappedTo && to > cappedTo) {
    to = cappedTo;
  }
  return { from, to };
};

/**
 * Resolving a bounded ISO date window from optional start/end values.
 *
 * The one-sided and both-present cases are identical for all date windows: only the
 * "no dates supplied" fallback differs between travel and purchase windows, expressed
 * via `defaultFromOffset` and `defaultToOffset` (month offsets from today).
 *
 * TourPlan NX FindBookings API fields expect date-only values (YYYY-MM-DD) and
 * rejects values with a time component (e.g. ...T23:59:59.997), so all inputs are
 * normalized to date-prefix strings before use.
 *
 * @param {string|null} start - Caller-supplied start date (may contain a time component).
 * @param {string|null} end   - Caller-supplied end date (may contain a time component).
 * @param {number} defaultFromOffset - Month offset from today used as `from` when no dates are supplied.
 * @param {number} defaultToOffset  - Month offset from today used as `to` when no dates are supplied.
 * @returns {{ from: string, to: string }}
 */
const buildDateWindow = (start, end, defaultFromOffset, defaultToOffset) => {
  const normalizedStart = isoDatePrefix(start);
  const normalizedEnd = isoDatePrefix(end);
  const windowSpanMonths = TRAVEL_WINDOW_SPAN_YEARS * 12;

  if (normalizedStart && normalizedEnd) {
    return clampIsoDateRangeToMaxSpanMonths(normalizedStart, normalizedEnd, windowSpanMonths);
  }
  if (normalizedStart) {
    return {
      from: normalizedStart,
      to: shiftIsoDateByMonths(normalizedStart, windowSpanMonths) || normalizedStart,
    };
  }
  if (normalizedEnd) {
    return {
      from: shiftIsoDateByMonths(normalizedEnd, -windowSpanMonths) || normalizedEnd,
      to: normalizedEnd,
    };
  }
  const today = toIsoDate(new Date());
  return {
    from: shiftIsoDateByMonths(today, defaultFromOffset) || today,
    to: shiftIsoDateByMonths(today, defaultToOffset) || today,
  };
};

/**
 * Resolve the travel date window, restricted to TRAVEL_WINDOW_SPAN_YEARS.
 * Default (no dates): today − TRAVEL_WINDOW_SPAN_YEARS to today + TRAVEL_WINDOW_SPAN_YEARS.
 * @param {string} travelDateStart
 * @param {string} travelDateEnd
 * @returns {{ from: string, to: string }}
 */
const resolveTravelDateWindow = (travelDateStart, travelDateEnd) => {
  const windowSpanMonths = TRAVEL_WINDOW_SPAN_YEARS * 12;
  return buildDateWindow(travelDateStart, travelDateEnd, -windowSpanMonths, windowSpanMonths);
};

/**
 * Resolve the purchase date window, restricted to TRAVEL_WINDOW_SPAN_YEARS.
 * Default (no dates): today − 1 year to today (purchases are always in the past).
 * @param {string} purchaseDateStart
 * @param {string} purchaseDateEnd
 * @returns {{ from: string, to: string }}
 */
const resolvePurchaseDateWindow = (purchaseDateStart, purchaseDateEnd) => {
  const maxSpanMonths = TRAVEL_WINDOW_SPAN_YEARS * 12;
  return buildDateWindow(purchaseDateStart, purchaseDateEnd, -maxSpanMonths, 0);
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
    // Log the failing identifier so the booking can be investigated without
    // crashing the whole search — the caller filters out nulls.
    console.error(`[tourplan] fetchFullBookingByBookingId failed for ${fieldName}=${fieldValue}`, detail);
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
  let baseSearchFilters = null;

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
  // R.uniqWith(R.equals) uses deep structural equality, which is safer than
  // R.uniqBy(JSON.stringify) whose output depends on property insertion order.
  searchCriterias = R.uniqWith(R.equals, searchCriterias);

  // Step3: Build base search filters.
  if (applyBaseSearchFilters) {
    // Build base search filters.
    // If booking reference(s) or bookingid are provided these those are used.
    // But if no booking reference(s) or bookingid are provided then we use the travel
    // dates window as a base search filters. To keep the search bounded (and not crash Tourplan)
    // If purchase dates are provided then its part of base search filters.
    const travelDateWindow = resolveTravelDateWindow(travelDateStart, travelDateEnd);
    baseSearchFilters = {
      TravelDateFrom: travelDateWindow.from,
      TravelDateTo: travelDateWindow.to,
    };
    if (purchaseDateStart || purchaseDateEnd) {
      const purchaseDateWindow = resolvePurchaseDateWindow(purchaseDateStart, purchaseDateEnd);
      baseSearchFilters.BookingEnteredDateFrom = purchaseDateWindow.from;
      baseSearchFilters.BookingEnteredDateTo = purchaseDateWindow.to;
    }
  }

  // Step4: Fetch for bookings based on the search criterias.
  const allSearches = searchCriterias.length
    ? searchCriterias.map(async keyObj => {
      let reply;
      try {
        reply = await callTourplan(getPayload('ListBookingsRequest', {
          ...(baseSearchFilters ? { ...baseSearchFilters } : {}),
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
    : [
      // Date-range-only search (no explicit criteria). Wrap in the same try/catch
      // pattern as the map branch so a non-HTTP error is treated as zero results
      // rather than crashing the entire search.
      (async () => {
        try {
          return await callTourplan(getPayload('ListBookingsRequest', baseSearchFilters));
        } catch (err) {
          const errMsg = typeof err === 'string' ? err : (err && err.message) || String(err);
          if (errMsg.includes('Request failed with status code')) throw Error(errMsg);
          return { ListBookingsReply: { BookingHeaders: { BookingHeader: [] } } };
        }
      })(),
    ];

  // Step5: Get full booking details for each booking.
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

  // Step6: Return the bookings.
  console.debug('[tourplan] Bookings Found: ', bookings ? bookings.length : 0);
  return {
    bookings: bookings ? bookings.filter(b => b) : [],
  };
};

module.exports = {
  searchItineraries,
  // Exported for unit testing and potential reuse elsewhere.
  resolveTravelDateWindow,
  resolvePurchaseDateWindow,
};
