/* eslint-disable arrow-body-style */
const { makeExecutableSchema } = require('@graphql-tools/schema');
const R = require('ramda');
const { graphql } = require('graphql');

const xmlTextOrNull = v => {
  if (v == null || v === '') return null;
  return String(v);
};

/** Builds PuDoInfo for GraphQL (fields date / time / remarks). */
const puDoInfoOrNull = ({ date: dateRaw, time: timeRaw, remarks: remarksRaw }) => {
  const date = xmlTextOrNull(dateRaw);
  const time = xmlTextOrNull(timeRaw);
  const remarks = xmlTextOrNull(remarksRaw);
  if (date == null && time == null && remarks == null) return null;
  return { date, time, remarks };
};

const resolvers = {
  Query: {
    name: R.path(['Name']),
    bookingId: R.path(['BookingId']),
    bookingStatus: R.path(['BookingStatus']),
    bookingStatusId: R.path(['TourplanBookingStatus']),
    ref: R.path(['Ref']),
    agentRef: R.path(['AgentRef']),
    agentId: R.path(['agentId']),
    totalPrice: R.path(['TotalPrice']),
    currency: R.path(['Currency']),
    travelDate: R.path(['TravelDate']),
    enteredDate: R.path(['EnteredDate']),
    canEdit: root => root != null && root.ReadOnly === 'N' && root.CanAddServices === 'Y',
    isBooking: root => root != null && root.QB === 'B',
    bookingAgent: root => xmlTextOrNull(R.path(['Consult'], root)),
    serviceLines: booking => {
      let Services = R.pathOr([], ['Services', 'Service'], booking);
      if (!Array.isArray(Services)) Services = [Services];
      return Services.map(s => {
        // Use R.pathOr so non-accommodation service lines (transfers, activities, etc.)
        // that carry no RoomConfigs node don't throw a TypeError.
        let actualRoomConfigs = R.pathOr([], ['RoomConfigs', 'RoomConfig'], s);
        // xml2js returns a single object (not an array) when there is only one element.
        if (!Array.isArray(actualRoomConfigs)) actualRoomConfigs = [actualRoomConfigs];
        const paxList = actualRoomConfigs.reduce((acc, roomConfig) => {
          const paxDetails = R.pathOr([], ['PaxList', 'PaxDetails'], roomConfig);
          if (!Array.isArray(paxDetails)) return [...acc, paxDetails];
          return [...acc, ...paxDetails];
        }, []);
        return {
          ...s,
          paxList,
          paxConfigs: actualRoomConfigs,
        };
      });
    },
  },
  ServiceLine: {
    serviceLineId: R.path(['ServiceLineId']),
    serviceLineUpdateCount: R.path(['ServiceLineUpdateCount']),
    supplierId: sl => {
      const opt = R.path(['Opt'], sl);
      if (!opt) return null;
      return opt.slice(5, 11);
    },
    supplierName: R.path(['SupplierName']),
    optionId: R.path(['Opt']),
    optionName: R.path(['Description']),
    startDate: R.path(['Date']),
    paxList: R.path(['paxList']),
    paxConfigs: R.path(['paxConfigs']),
    linePrice: R.path(['LinePrice']),
    quantity: R.path(['SCUqty']),
    status: R.path(['Status']),
    puInfo: sl => puDoInfoOrNull({
      date: R.path(['Pickup_Date'], sl),
      time: R.path(['puTime'], sl),
      remarks: R.path(['puRemark'], sl),
    }),
    doInfo: sl => puDoInfoOrNull({
      date: R.path(['Dropoff_Date'], sl),
      time: R.path(['doTime'], sl),
      remarks: R.path(['doRemark'], sl),
    }),
  },
  PaxConfig: {
    roomType: px => {
      const roomType = R.path(['RoomType'], px);
      if (!roomType) return null;
      return ({
        SG: 'Single',
        DB: 'Double',
        TW: 'Twin',
        TR: 'Triple',
        QD: 'Quad',
        OT: 'Other',
      })[roomType];
    },
    adults: R.path(['Adults']),
    children: R.path(['Children']),
    infants: R.path(['Infants']),
    passengers: px => {
      const paxList = R.pathOr([], ['PaxList', 'PaxDetails'], px);
      if (!Array.isArray(paxList)) return [paxList];
      return paxList;
    },
  },
  Passenger: {
    personId: R.path(['PersonId']),
    firstName: R.path(['Forename']),
    lastName: R.path(['Surname']),
    passengerType: p => {
      const paxType = R.path(['PaxType'], p);
      if (paxType === 'A') return 'Adult';
      if (paxType === 'C') return 'Child';
      if (paxType === 'I') return 'Infant';
      return 'Adult';
    },
  },
};

/**
 * Schema cache keyed by the typeDefs value supplied by ti2.
 *
 * typeDefs arrives from ti2 as a plain SDL string (a primitive), so a WeakMap
 * cannot be used (WeakMap only accepts object keys). A plain Map is used instead.
 * Because typeDefs is a module-level constant that never changes at runtime, the
 * Map will hold at most one entry per process lifetime — no memory-leak risk.
 *
 * Without this cache, makeExecutableSchema (SDL parsing + resolver wiring) ran
 * once per booking fetched — e.g. 50 bookings × concurrency-10 = 50 compilations
 * per search. With the cache it runs at most once per process lifetime.
 */
const schemaCache = new Map();

/**
 * Return a compiled GraphQL schema for the given typeDefs, building and caching
 * it on the first call and returning the cached instance on every subsequent call.
 *
 * @param {string|DocumentNode} typeDefs - SDL string or parsed document from ti2.
 * @returns {GraphQLSchema}
 */
const getSchema = typeDefs => {
  if (schemaCache.has(typeDefs)) return schemaCache.get(typeDefs);
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  schemaCache.set(typeDefs, schema);
  return schema;
};

/**
 * Translate a raw TourPlan booking object into the ti2 itinerary-booking shape
 * by executing the ti2-supplied GraphQL query against the booking as root value.
 *
 * SDL + operation document come from ti2.
 *
 * @param {string|DocumentNode} typeDefs - The type definitions for the schema.
 * @param {string} query - The GraphQL operation to execute.
 * @param {Object} rootValue - The raw TourPlan booking object.
 * @returns {Promise<Object>} The translated booking data.
 */
const translateItineraryBooking = async ({ typeDefs, query, rootValue }) => {
  const schema = getSchema(typeDefs);
  const retVal = await graphql({
    schema,
    rootValue,
    source: query,
  });
  if (retVal.errors) {
    throw new Error(retVal.errors.map(e => e.message).join('; '));
  }
  return retVal.data;
};

module.exports = {
  translateItineraryBooking,
};
