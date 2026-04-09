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
        let actualRoomConfigs = s.RoomConfigs.RoomConfig;
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

/** SDL + operation document come from ti2
 *
 * @param {Object} typeDefs - The type definitions for the schema
 * @param {Object} query - The query to execute
 * @param {Object} rootValue - The root value for the query
 * @returns {Promise<Object>} The result of the query
 */
const translateItineraryBooking = async ({ typeDefs, query, rootValue }) => {
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers,
  });
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
