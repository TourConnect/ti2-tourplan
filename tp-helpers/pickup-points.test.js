/* globals describe, it, expect */

const {
  isEnabled,
  normalizePickupPoints,
} = require('./pickup-points');

describe('pickup-points helpers', () => {
  describe('isEnabled', () => {
    it.each([true, 1, 'true', 'TRUE', '1', 'yes', ' Yes '])(
      'treats %p as enabled',
      value => {
        expect(isEnabled(value)).toBe(true);
      },
    );

    it.each([false, 0, 'false', 'no', '', null, undefined, 'maybe'])(
      'treats %p as disabled',
      value => {
        expect(isEnabled(value)).toBe(false);
      },
    );
  });

  describe('normalizePickupPoints', () => {
    const singlePickupPoint = {
      Point_ID: '504',
      PointDescription: 'Keio Plaza Hotel Tokyo',
      CanPickup: 'Y',
      CanDropoff: 'Y',
    };

    it('normalizes a single PickupPoint object to an array', () => {
      expect(normalizePickupPoints({ PickupPoint: singlePickupPoint })).toEqual({
        PickupPoint: [singlePickupPoint],
      });
    });

    it('keeps already-array PickupPoint values', () => {
      const pickupPoints = { PickupPoint: [singlePickupPoint] };
      expect(normalizePickupPoints(pickupPoints)).toEqual(pickupPoints);
    });

    it('omits empty shells and non-objects', () => {
      expect(normalizePickupPoints(undefined)).toBeUndefined();
      expect(normalizePickupPoints({})).toBeUndefined();
      expect(normalizePickupPoints({ PickupPoint: [] })).toBeUndefined();
      expect(normalizePickupPoints('nope')).toBeUndefined();
    });
  });
});
