const BREAKFAST = 'breakfast';

const normalizeText = value => String(value || '').toLowerCase();

const hasNegatedBreakfast = value => {
  const text = normalizeText(value);
  return /\b(?:no|without|excluding|exclude|excludes)\s+breakfast\b/.test(text)
    || /\b(?:no|without)\s+bed\s+(?:and|&)\s+breakfast\b/.test(text)
    || /\b(?:do|does)\s+not\s+(?:include|includes)\s+breakfast\b/.test(text)
    || /\bnot\s+including\s+breakfast\b/.test(text)
    || /\bbreakfast\b\s+(?:is\s+)?(?:not\s+included|not\s+inclusive|excluded)\b/.test(text);
};

const includesBreakfast = value => {
  if (hasNegatedBreakfast(value)) return false;
  const text = normalizeText(value);
  return /\bbreakfast\b\s+(?:is\s+)?(?:included|inclusive)\b/.test(text)
    || /\b(?:including|includes|include|with)\s+breakfast\b/.test(text)
    || /\bbed\s+(?:and|&)\s+breakfast\b/.test(text);
};

const getOptionInclusions = optionName => (
  includesBreakfast(optionName) ? [BREAKFAST] : []
);

const getExtraCategory = extraName => {
  if (hasNegatedBreakfast(extraName)) return null;
  return /\bbreakfast\b/.test(normalizeText(extraName)) ? BREAKFAST : null;
};

const addStructuredOptionMetadata = option => ({
  ...option,
  inclusions: getOptionInclusions(option && option.optionName),
  extras: (option && option.extras || []).map(extra => {
    const category = getExtraCategory(extra && extra.name);
    return category ? { ...extra, category } : extra;
  }),
});

module.exports = {
  addStructuredOptionMetadata,
  getExtraCategory,
  getOptionInclusions,
};
