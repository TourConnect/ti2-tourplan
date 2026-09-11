/* globals describe, it, expect */
const { typeDefs: itineraryBookingTypeDefs, query: itineraryBookingQuery } = require('../node_modules/ti2/controllers/graphql-schemas/itinerary-booking');
const { translateItineraryBooking } = require('./itinerary');

const typeDefsWithAgentPrice = itineraryBookingTypeDefs.replace(
  /(type\s+ServiceLine\s*{)/,
  '$1\n    agentPrice: String',
);

const queryWithAgentPrice = itineraryBookingQuery.replace(
  /\blinePrice\b/,
  'linePrice\n    agentPrice',
);

const bookingRoot = {
  BookingId: '316559',
  Name: 'Test booking',
  Ref: 'ALFI393706',
  TotalPrice: '187795',
  Currency: 'GBP',
  TravelDate: '2025-08-13',
  EnteredDate: '2024-09-12',
  ReadOnly: 'N',
  CanAddServices: 'Y',
  Services: {
    Service: {
      ServiceLineId: '745684',
      Opt: 'LONHOSANLONBFBDLX',
      Description: 'Bed and Full Buffet Breakfast',
      LinePrice: '187795',
      AgentPrice: '159000',
      Date: '2025-08-13',
      Status: 'OK',
    },
  },
};

describe('translateItineraryBooking agentPrice', () => {
  it('maps Tourplan AgentPrice on service lines when the caller schema omits the field', async () => {
    const retVal = await translateItineraryBooking({
      typeDefs: itineraryBookingTypeDefs,
      query: itineraryBookingQuery,
      rootValue: bookingRoot,
    });

    expect(retVal.serviceLines[0]).toMatchObject({
      serviceLineId: '745684',
      linePrice: '187795',
      agentPrice: '159000',
    });
  });

  it('maps Tourplan AgentPrice when the caller schema already declares the field', async () => {
    const retVal = await translateItineraryBooking({
      typeDefs: typeDefsWithAgentPrice,
      query: queryWithAgentPrice,
      rootValue: bookingRoot,
    });

    expect(retVal.serviceLines[0]).toMatchObject({
      serviceLineId: '745684',
      linePrice: '187795',
      agentPrice: '159000',
    });
  });

  it('returns null agentPrice when Tourplan omits AgentPrice', async () => {
    const { Services, ...rest } = bookingRoot;
    const retVal = await translateItineraryBooking({
      typeDefs: typeDefsWithAgentPrice,
      query: queryWithAgentPrice,
      rootValue: {
        ...rest,
        Services: {
          Service: {
            ...Services.Service,
            AgentPrice: undefined,
          },
        },
      },
    });

    expect(retVal.serviceLines[0].agentPrice).toBeNull();
  });
});
