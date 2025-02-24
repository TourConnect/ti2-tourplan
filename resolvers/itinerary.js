/* eslint-disable arrow-body-style */
const { makeExecutableSchema } = require('@graphql-tools/schema');
const R = require('ramda');
const { graphql } = require('graphql');


const resolvers = {
  Query: {
    name: R.path(['Name']),
    bookingId: R.path(['BookingId']),
    bookingStatus: R.path(['BookingStatus']),
    ref: R.path(['Ref']),
    agentRef: R.path(['AgentRef']),
    totalPrice: R.path(['TotalPrice']),
    currency: R.path(['Currency']),
    travelDate: R.path(['TravelDate']),
    enteredDate: R.path(['EnteredDate']),
    canEdit: root => root.ReadOnly === 'N' && root.CanAddServices === 'Y',
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
  if (retVal.errors) throw new Error(retVal.errors);
  return retVal.data;
};

module.exports = {
  translateItineraryBooking,
};
