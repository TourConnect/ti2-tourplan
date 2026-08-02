const R = require('ramda');
const { asArray } = require('./values');
const { isEnabled } = require('../utils');

// Keep Tourplan PascalCase under camelCase pickupPoints (same pattern as optRates).
// Bokun channel-manager reads container.PickupPoint / point.Point_ID etc.
const normalizePickupPoints = rawPickupPoints => {
  if (!rawPickupPoints || typeof rawPickupPoints !== 'object') return undefined;
  const points = asArray(R.path(['PickupPoint'], rawPickupPoints))
    .filter(point => point && typeof point === 'object' && !Array.isArray(point));
  if (!points.length) return undefined;
  return {
    ...rawPickupPoints,
    PickupPoint: points,
  };
};

module.exports = {
  isEnabled,
  normalizePickupPoints,
};
