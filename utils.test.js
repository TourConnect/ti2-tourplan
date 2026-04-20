const { escapeInvalidXmlChars } = require('./utils');

describe('escapeInvalidXmlChars', () => {
  it('returns empty string for falsy input', () => {
    expect(escapeInvalidXmlChars('')).toBe('');
    expect(escapeInvalidXmlChars(null)).toBe('');
    expect(escapeInvalidXmlChars(undefined)).toBe('');
  });

  it('maps accented letters before NFD stripping', () => {
    expect(escapeInvalidXmlChars('Müller')).toBe('Mueller');
    expect(escapeInvalidXmlChars('Straße')).toBe('Strasse');
    expect(escapeInvalidXmlChars('Søren')).toBe('Soeren');
  });

  it('maps repeated accented letters for every occurrence', () => {
    expect(escapeInvalidXmlChars('öffnen und rösten')).toBe('oeffnen und roesten');
    expect(escapeInvalidXmlChars('für süße Grüße')).toBe('fuer suesse Gruesse');
  });

  it('replaces smart quotes and en dash', () => {
    expect(escapeInvalidXmlChars('Say ‘hi’ and “bye” – ok')).toBe('Say \'hi\' and "bye" - ok');
  });

  it('strips disallowed control characters', () => {
    expect(escapeInvalidXmlChars('A\u0000B\u0008C')).toBe('ABC');
  });

  it('strips lone UTF-16 surrogate code units', () => {
    expect(escapeInvalidXmlChars('X\uD800Y')).toBe('XY');
  });
});
