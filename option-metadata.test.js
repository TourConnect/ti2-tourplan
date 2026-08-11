const {
  addStructuredOptionMetadata,
  getExtraCategory,
  getOptionInclusions,
} = require('./option-metadata');

describe('structured option metadata', () => {
  test.each([
    ['Witherview Super King, Including Breakfast', ['breakfast']],
    ['Bed and Breakfast', ['breakfast']],
    ['Bed & Breakfast', ['breakfast']],
    ['Breakfast not included', []],
    ['No breakfast included', []],
    ['Does not include breakfast', []],
    ['Not including breakfast', []],
    ['No bed and breakfast', []],
    ['Room only', []],
  ])('normalizes option inclusion text %s', (optionName, expected) => {
    expect(getOptionInclusions(optionName)).toEqual(expected);
  });

  it('classifies selectable breakfast extras without changing unrelated extras', () => {
    expect(addStructuredOptionMetadata({
      optionName: 'Superior Room',
      extras: [
        { id: '1', name: 'Breakfast' },
        { id: '2', name: 'Airport transfer' },
      ],
    })).toEqual({
      optionName: 'Superior Room',
      inclusions: [],
      extras: [
        { id: '1', name: 'Breakfast', category: 'breakfast' },
        { id: '2', name: 'Airport transfer' },
      ],
    });
  });

  it('does not classify negated breakfast text as a selectable category', () => {
    expect(getExtraCategory('No breakfast')).toBeNull();
  });
});
