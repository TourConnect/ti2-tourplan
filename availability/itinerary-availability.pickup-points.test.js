/* globals describe, it, expect, jest */

const {
  getAvailabilityOnly,
  getStayResults,
} = require('./itinerary-availability-helper');
const { searchAvailabilityForItinerary } = require('./itinerary-availability');

describe('availability pickup points', () => {
  const baseParams = {
    optionId: 'LONSMPICKUP00001',
    hostConnectEndpoint: 'https://test-host-connect.com',
    hostConnectAgentID: 'test-agent-id',
    hostConnectAgentPassword: 'test-agent-password',
    axios: jest.fn(),
    startDate: '2025-04-01',
    requestedEndDate: '2025-04-05',
  };

  const singlePickupPoint = {
    Point_ID: '504',
    PointDescription: 'Keio Plaza Hotel Tokyo',
    CanPickup: 'Y',
    CanDropoff: 'Y',
    puTime: '0815',
    doTime: '1800',
  };

  const optionInfoReply = ({ pickupPoints, optAvail = '-2 -2 -2' } = {}) => ({
    OptionInfoReply: {
      Option: {
        OptAvail: optAvail,
        OptRates: { Currency: 'USD' },
        OptGeneral: {
          ...(pickupPoints !== undefined ? { PickupPoints: pickupPoints } : {}),
        },
      },
    },
  });

  it('keeps GAR OptionInfo by default', async () => {
    const callTourplan = jest.fn(async () => optionInfoReply());

    await getAvailabilityOnly({
      ...baseParams,
      callTourplan,
    });

    expect(callTourplan).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({
        OptionInfoRequest: expect.objectContaining({
          Info: 'GAR',
        }),
      }),
    }));
  });

  it.each([false, 'false', 0, null, undefined])(
    'keeps GAR OptionInfo when pickupPointsRequired is %p',
    async pickupPointsRequired => {
      const callTourplan = jest.fn(async () => optionInfoReply());

      await getAvailabilityOnly({
        ...baseParams,
        pickupPointsRequired,
        callTourplan,
      });

      expect(callTourplan).toHaveBeenCalledWith(expect.objectContaining({
        model: expect.objectContaining({
          OptionInfoRequest: expect.objectContaining({
            Info: 'GAR',
          }),
        }),
      }));
    },
  );

  it.each([true, 1, 'true', 'yes', 'YES'])(
    'adds P to OptionInfo when pickupPointsRequired is %p',
    async pickupPointsRequired => {
      const callTourplan = jest.fn(async () => optionInfoReply({
        pickupPoints: { PickupPoint: singlePickupPoint },
      }));

      const result = await getAvailabilityOnly({
        ...baseParams,
        pickupPointsRequired,
        callTourplan,
      });

      expect(callTourplan).toHaveBeenCalledWith(expect.objectContaining({
        model: expect.objectContaining({
          OptionInfoRequest: expect.objectContaining({
            Info: 'GARP',
          }),
        }),
      }));
      expect(result.pickupPoints).toEqual({
        PickupPoint: [singlePickupPoint],
      });
    },
  );

  it('omits pickupPoints when Tourplan returns none', async () => {
    const callTourplan = jest.fn(async () => optionInfoReply({
      pickupPoints: { PickupPoint: [] },
    }));

    const result = await getAvailabilityOnly({
      ...baseParams,
      pickupPointsRequired: true,
      callTourplan,
    });

    expect(result).not.toHaveProperty('pickupPoints');
  });

  it('omits pickupPoints when pickupPointsRequired is disabled', async () => {
    const callTourplan = jest.fn(async () => optionInfoReply({
      pickupPoints: { PickupPoint: singlePickupPoint },
    }));

    const result = await getAvailabilityOnly({
      ...baseParams,
      pickupPointsRequired: false,
      callTourplan,
    });

    expect(result).not.toHaveProperty('pickupPoints');
  });

  it('falls back to top-level pickup points when OptGeneral pickup points are empty', async () => {
    const callTourplan = jest.fn(async () => ({
      OptionInfoReply: {
        Option: {
          OptAvail: '-2 -2 -2',
          OptRates: { Currency: 'USD' },
          OptGeneral: {
            PickupPoints: { PickupPoint: [] },
          },
          PickupPoints: { PickupPoint: singlePickupPoint },
        },
      },
    }));

    const result = await getAvailabilityOnly({
      ...baseParams,
      pickupPointsRequired: true,
      callTourplan,
    });

    expect(result.pickupPoints).toEqual({
      PickupPoint: [singlePickupPoint],
    });
  });

  it('keeps GS OptionInfo for stay results (pickup points come from GD/GAR)', async () => {
    const callTourplan = jest.fn(async () => ({
      OptionInfoReply: {
        Option: {
          OptStayResults: [],
        },
      },
    }));

    await getStayResults(
      baseParams.optionId,
      baseParams.hostConnectEndpoint,
      baseParams.hostConnectAgentID,
      baseParams.hostConnectAgentPassword,
      baseParams.axios,
      baseParams.startDate,
      1,
      [{ Adults: 2 }],
      undefined,
      callTourplan,
    );

    expect(callTourplan).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({
        OptionInfoRequest: expect.objectContaining({
          Info: 'GS',
        }),
      }),
    }));
  });

  it('returns pickupPoints on the availabilityOnly search response', async () => {
    const callTourplan = jest.fn(async () => optionInfoReply({
      pickupPoints: { PickupPoint: singlePickupPoint },
      optAvail: '-2 -2 -2',
    }));

    const result = await searchAvailabilityForItinerary({
      axios: jest.fn(),
      token: {
        hostConnectEndpoint: baseParams.hostConnectEndpoint,
        hostConnectAgentID: baseParams.hostConnectAgentID,
        hostConnectAgentPassword: baseParams.hostConnectAgentPassword,
      },
      payload: {
        optionId: baseParams.optionId,
        startDate: baseParams.startDate,
        endDate: baseParams.requestedEndDate,
        availabilityOnly: true,
        pickupPointsRequired: 'true',
        paxConfigs: [{ adults: 2 }],
      },
      callTourplan,
      cache: { getOrExec: async ({ fn, fnParams }) => fn(...fnParams) },
    });

    expect(result.bookable).toBe(true);
    expect(result.pickupPoints).toEqual({
      PickupPoint: [singlePickupPoint],
    });
  });
});
