/* globals describe, it, expect, jest, beforeAll, afterAll */

jest.mock('./resolvers/itinerary', () => ({
  translateItineraryBooking: jest.fn(async ({ rootValue }) => rootValue),
}));

const {
  searchItineraries,
  resolveTravelDateWindow,
  resolvePurchaseDateWindow,
} = require('./itinerary-search');

const realSetImmediate = setImmediate;

/**
 * Freeze time so "today-based" default windows are deterministic.
 * TRAVEL_WINDOW_SPAN_YEARS = 2, so the full span is 24 months.
 *
 * Anchored to 2025-06-15:
 *   today - 24 months = 2023-06-15
 *   today + 24 months = 2027-06-15
 */
const FROZEN_NOW = new Date('2025-06-15T00:00:00.000Z');

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  jest.useRealTimers();
});

describe('searchItineraries agentReferenceIds', () => {
  const token = {
    hostConnectAgentID: 'agent-id',
    hostConnectAgentPassword: 'agent-password',
    hostConnectEndpoint: 'https://example.test/hostconnect',
  };

  const runSearch = (payload, callTourplan) => searchItineraries({
    token,
    axios: jest.fn(),
    typeDefsAndQueries: {
      itineraryBookingTypeDefs: {},
      itineraryBookingQuery: '',
    },
    payload,
    callTourplan,
  });

  const listRequestsFrom = callTourplan => callTourplan.mock.calls
    .map(([request]) => request.model.ListBookingsRequest)
    .filter(Boolean);

  it('treats a numeric agentReferenceIds value as an exact AgentRef with explicit precedence', async () => {
    const callTourplan = jest.fn(async ({ model }) => {
      if (model.ListBookingsRequest) {
        return {
          ListBookingsReply: {
            BookingHeaders: { BookingHeader: [{ BookingId: '777' }] },
          },
        };
      }
      return { GetBookingReply: { BookingId: '777' } };
    });

    const result = await runSearch({
      agentReferenceIds: 501,
      bookingReferenceIds: ['IGNORE-REF'],
      bookingId: '501',
      name: 'Ignore name',
      travelDateStart: '2026-01-01',
      travelDateEnd: '2026-12-31',
      purchaseDateStart: '2026-02-01',
      purchaseDateEnd: '2026-03-01',
    }, callTourplan);

    const listRequests = listRequestsFrom(callTourplan);
    expect(listRequests).toEqual([{
      AgentID: 'agent-id',
      Password: 'agent-password',
      AgentRef: '501',
    }]);
    expect(listRequests).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ BookingId: '501' }),
    ]));
    expect(listRequests).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ Ref: '501' }),
    ]));
    expect(result.bookings).toEqual([{
      BookingId: '777',
      agentId: 'agent-id',
    }]);
  });

  it('normalizes a scalar string agentReferenceIds value', async () => {
    const callTourplan = jest.fn(async () => ({
      ListBookingsReply: { BookingHeaders: { BookingHeader: [] } },
    }));

    const result = await runSearch({ agentReferenceIds: ' REF-SCALAR ' }, callTourplan);

    expect(listRequestsFrom(callTourplan)).toEqual([{
      AgentID: 'agent-id',
      Password: 'agent-password',
      AgentRef: 'REF-SCALAR',
    }]);
    expect(result).toEqual({ bookings: [] });
  });

  it('normalizes array values and deduplicates AgentRef searches and booking results', async () => {
    const callTourplan = jest.fn(async ({ model }) => {
      const listRequest = model.ListBookingsRequest;
      if (listRequest && listRequest.AgentRef === 'REF-A') {
        return {
          ListBookingsReply: {
            BookingHeaders: {
              BookingHeader: [{ BookingId: '601' }, { BookingId: '602' }],
            },
          },
        };
      }
      if (listRequest && listRequest.AgentRef === '700') {
        return {
          ListBookingsReply: {
            BookingHeaders: { BookingHeader: [{ BookingId: '602' }] },
          },
        };
      }
      if (model.GetBookingRequest) {
        return {
          GetBookingReply: { BookingId: model.GetBookingRequest.BookingId },
        };
      }
      throw new Error(`Unexpected request: ${JSON.stringify(model)}`);
    });

    const result = await runSearch({
      agentReferenceIds: [' REF-A ', 700, 'REF-A', null, {}, true, Infinity],
    }, callTourplan);

    expect(listRequestsFrom(callTourplan)).toEqual([
      {
        AgentID: 'agent-id',
        Password: 'agent-password',
        AgentRef: 'REF-A',
      },
      {
        AgentID: 'agent-id',
        Password: 'agent-password',
        AgentRef: '700',
      },
    ]);
    expect(result.bookings.map(booking => booking.BookingId)).toEqual(['601', '602']);
    const getBookingIds = callTourplan.mock.calls
      .map(([request]) => request.model.GetBookingRequest)
      .filter(Boolean)
      .map(request => request.BookingId);
    expect(getBookingIds).toEqual(['601', '602']);
  });

  it('keeps successful AgentRef results when another fan-out request fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const callTourplan = jest.fn(async ({ model }) => {
      const listRequest = model.ListBookingsRequest;
      if (listRequest && listRequest.AgentRef === 'FAIL') {
        throw new Error('Request failed with status code 500: failed AgentRef');
      }
      if (listRequest && listRequest.AgentRef === 'GOOD') {
        return {
          ListBookingsReply: {
            BookingHeaders: { BookingHeader: [{ BookingId: '801' }] },
          },
        };
      }
      return { GetBookingReply: { BookingId: model.GetBookingRequest.BookingId } };
    });

    try {
      const result = await runSearch({ agentReferenceIds: ['FAIL', 'GOOD'] }, callTourplan);

      expect(result.bookings.map(booking => booking.BookingId)).toEqual(['801']);
      expect(warnSpy).toHaveBeenCalledWith(
        '[tourplan] ListBookingsRequest failed',
        { AgentRef: 'FAIL' },
        'Request failed with status code 500: failed AgentRef',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('limits concurrent AgentRef ListBookings requests while attempting every reference', async () => {
    const agentReferenceIds = Array.from({ length: 20 }, (_, idx) => `REF-${idx}`);
    const pendingListRequests = [];
    let activeListRequests = 0;
    let maxActiveListRequests = 0;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const callTourplan = jest.fn(({ model }) => {
      if (model.GetBookingRequest) {
        return global.Promise.resolve({
          GetBookingReply: { BookingId: model.GetBookingRequest.BookingId },
        });
      }

      const { AgentRef } = model.ListBookingsRequest;
      activeListRequests += 1;
      maxActiveListRequests = Math.max(maxActiveListRequests, activeListRequests);
      return new global.Promise((resolve, reject) => {
        pendingListRequests.push({
          AgentRef,
          settle: () => {
            activeListRequests -= 1;
            if (AgentRef === 'REF-7') {
              reject(new Error('Request failed with status code 500: failed AgentRef'));
              return;
            }
            resolve({
              ListBookingsReply: {
                BookingHeaders: {
                  BookingHeader: AgentRef === 'REF-19' ? [{ BookingId: '901' }] : [],
                },
              },
            });
          },
        });
      });
    });

    try {
      const searchPromise = runSearch({ agentReferenceIds }, callTourplan);
      const flushAsyncWork = remainingTicks => (
        new global.Promise(resolve => realSetImmediate(resolve))
          .then(() => (remainingTicks > 1 ? flushAsyncWork(remainingTicks - 1) : undefined))
      );
      const settleStartedListRequests = async () => {
        if (listRequestsFrom(callTourplan).length >= agentReferenceIds.length) return;
        expect(activeListRequests).toBeLessThanOrEqual(10);
        expect(pendingListRequests.length).toBeGreaterThan(0);
        pendingListRequests.splice(0).forEach(({ settle }) => settle());
        await flushAsyncWork(4);
        await settleStartedListRequests();
      };
      await flushAsyncWork(4);
      await settleStartedListRequests();
      pendingListRequests.splice(0).forEach(({ settle }) => settle());
      await flushAsyncWork(4);

      const result = await searchPromise;

      expect(maxActiveListRequests).toBeLessThanOrEqual(10);
      expect(listRequestsFrom(callTourplan).map(request => request.AgentRef).sort())
        .toEqual([...agentReferenceIds].sort());
      expect(result.bookings.map(booking => booking.BookingId)).toEqual(['901']);
      expect(warnSpy).toHaveBeenCalledWith(
        '[tourplan] ListBookingsRequest failed',
        { AgentRef: 'REF-7' },
        'Request failed with status code 500: failed AgentRef',
      );
    } finally {
      pendingListRequests.splice(0).forEach(({ settle }) => settle());
      warnSpy.mockRestore();
    }
  });

  it('fails closed when more than 20 AgentRef values are provided', async () => {
    const callTourplan = jest.fn();
    const agentReferenceIds = Array.from({ length: 21 }, (_, idx) => `REF-${idx}`);

    const result = await runSearch({
      agentReferenceIds,
      bookingId: 'SHOULD-NOT-FALL-BACK',
    }, callTourplan);

    expect(result).toEqual({ bookings: [] });
    expect(callTourplan).not.toHaveBeenCalled();
  });

  it('counts duplicate AgentRef values toward the hard input limit', async () => {
    const callTourplan = jest.fn();

    const result = await runSearch({
      agentReferenceIds: Array(21).fill('REF-DUPLICATE'),
    }, callTourplan);

    expect(result).toEqual({ bookings: [] });
    expect(callTourplan).not.toHaveBeenCalled();
  });

  it('counts malformed entries toward the raw AgentRef input limit', async () => {
    const callTourplan = jest.fn();

    const result = await runSearch({
      agentReferenceIds: [
        ...Array.from({ length: 20 }, (_, idx) => `REF-${idx}`),
        null,
      ],
    }, callTourplan);

    expect(result).toEqual({ bookings: [] });
    expect(callTourplan).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty list', []],
    ['blank and absent entries', [' ', null, undefined]],
    ['malformed entries', [{}, true, false, NaN, Infinity]],
    ['an explicit undefined scalar', undefined],
  ])('returns empty without a HostConnect request for %s', async (description, agentReferenceIds) => {
    const callTourplan = jest.fn();

    const result = await runSearch({
      agentReferenceIds,
      bookingId: 'SHOULD-NOT-FALL-BACK',
      bookingReferenceIds: ['SHOULD-NOT-FALL-BACK'],
      name: 'Should not fall back',
    }, callTourplan);

    expect(result).toEqual({ bookings: [] });
    expect(callTourplan).not.toHaveBeenCalled();
  });

  it.each([
    ['bookingReferenceIds', { bookingReferenceIds: ['LEGACY-REF'] }, 1],
    ['bookingId', { bookingId: '12345' }, 3],
    ['name', { name: 'Legacy Booking' }, 1],
    [
      'travel dates',
      { travelDateStart: '2026-01-01', travelDateEnd: '2026-01-31' },
      1,
    ],
  ])('keeps legacy %s application failures as empty results', async (
    description,
    payload,
    expectedRequests,
  ) => {
    const callTourplan = jest.fn(async () => {
      throw new Error('ListBookingsRequest failed: No matching bookings');
    });

    const result = await runSearch(payload, callTourplan);

    expect(result).toEqual({ bookings: [] });
    expect(callTourplan).toHaveBeenCalledTimes(expectedRequests);
  });
});

// ---------------------------------------------------------------------------
// resolveTravelDateWindow
// ---------------------------------------------------------------------------

describe('resolveTravelDateWindow', () => {
  describe('both dates provided', () => {
    it('returns the range unchanged when it fits within 24 months', () => {
      expect(resolveTravelDateWindow('2025-01-01', '2025-06-30'))
        .toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('caps `to` at start + 24 months when the range exceeds 2 years', () => {
      expect(resolveTravelDateWindow('2024-01-01', '2030-12-31'))
        .toEqual({ from: '2024-01-01', to: '2026-01-01' });
    });

    it('normalises reversed dates (end before start)', () => {
      expect(resolveTravelDateWindow('2025-06-30', '2025-01-01'))
        .toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('strips time components from both dates', () => {
      expect(resolveTravelDateWindow(
        '2025-01-01T10:00:00.000Z',
        '2025-06-30T23:59:59.997Z',
      )).toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('handles equal start and end dates', () => {
      expect(resolveTravelDateWindow('2025-03-10', '2025-03-10'))
        .toEqual({ from: '2025-03-10', to: '2025-03-10' });
    });
  });

  describe('only start date provided', () => {
    it('sets `to` to start + 24 months', () => {
      expect(resolveTravelDateWindow('2025-01-01', null))
        .toEqual({ from: '2025-01-01', to: '2027-01-01' });
    });

    it('treats undefined end the same as null', () => {
      expect(resolveTravelDateWindow('2025-01-01', undefined))
        .toEqual({ from: '2025-01-01', to: '2027-01-01' });
    });

    it('strips time component from start', () => {
      expect(resolveTravelDateWindow('2025-01-01T08:30:00.000Z', null))
        .toEqual({ from: '2025-01-01', to: '2027-01-01' });
    });
  });

  describe('only end date provided', () => {
    it('sets `from` to end - 24 months', () => {
      expect(resolveTravelDateWindow(null, '2025-06-15'))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });

    it('treats undefined start the same as null', () => {
      expect(resolveTravelDateWindow(undefined, '2025-06-15'))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });
  });

  describe('no dates provided', () => {
    it('defaults to today - 24 months → today + 24 months', () => {
      expect(resolveTravelDateWindow(null, null))
        .toEqual({ from: '2023-06-15', to: '2027-06-15' });
    });

    it('treats undefined the same as null', () => {
      expect(resolveTravelDateWindow(undefined, undefined))
        .toEqual({ from: '2023-06-15', to: '2027-06-15' });
    });
  });
});

// ---------------------------------------------------------------------------
// resolvePurchaseDateWindow
// ---------------------------------------------------------------------------

describe('resolvePurchaseDateWindow', () => {
  describe('both dates provided', () => {
    it('returns the range unchanged when it fits within 24 months', () => {
      expect(resolvePurchaseDateWindow('2025-01-01', '2025-06-30'))
        .toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('caps `to` at start + 24 months when the range exceeds 2 years', () => {
      expect(resolvePurchaseDateWindow('2023-01-01', '2030-12-31'))
        .toEqual({ from: '2023-01-01', to: '2025-01-01' });
    });

    it('normalises reversed dates (end before start)', () => {
      expect(resolvePurchaseDateWindow('2025-06-30', '2025-01-01'))
        .toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('strips time components from both dates', () => {
      expect(resolvePurchaseDateWindow(
        '2025-01-01T10:00:00.000Z',
        '2025-06-30T23:59:59.997Z',
      )).toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('handles equal start and end dates', () => {
      expect(resolvePurchaseDateWindow('2025-03-10', '2025-03-10'))
        .toEqual({ from: '2025-03-10', to: '2025-03-10' });
    });
  });

  describe('only start date provided', () => {
    it('sets `to` to start + 24 months', () => {
      expect(resolvePurchaseDateWindow('2025-01-01', null))
        .toEqual({ from: '2025-01-01', to: '2027-01-01' });
    });

    it('treats undefined end the same as null', () => {
      expect(resolvePurchaseDateWindow('2025-01-01', undefined))
        .toEqual({ from: '2025-01-01', to: '2027-01-01' });
    });
  });

  describe('only end date provided', () => {
    it('sets `from` to end - 24 months', () => {
      expect(resolvePurchaseDateWindow(null, '2025-06-15'))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });

    it('treats undefined start the same as null', () => {
      expect(resolvePurchaseDateWindow(undefined, '2025-06-15'))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });
  });

  describe('no dates provided', () => {
    it('defaults to today - 24 months → today (purchases are in the past)', () => {
      expect(resolvePurchaseDateWindow(null, null))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });

    it('treats undefined the same as null', () => {
      expect(resolvePurchaseDateWindow(undefined, undefined))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });
  });
});
