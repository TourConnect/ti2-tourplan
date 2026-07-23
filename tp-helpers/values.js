const asArray = value => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const trimString = value => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const firstPresent = (...values) => values.find(
  value => value !== undefined && value !== null && value !== '',
);

module.exports = {
  asArray,
  firstPresent,
  trimString,
};
