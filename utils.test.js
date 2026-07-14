const { escapeInvalidXmlChars, getRoomConfigs } = require('./utils');

describe('getRoomConfigs', () => {
  const getPaxDetails = passenger => getRoomConfigs([{
    roomType: 'Double',
    passengers: [passenger],
  }]).RoomConfig[0].PaxList.PaxDetails[0];

  it('uses a valid DOB instead of age', () => {
    const withDobAndAge = getPaxDetails({
      firstName: 'Ada',
      lastName: 'Lovelace',
      passengerType: 'Adult',
      dob: '1990-02-28',
      age: 36,
    });
    const withDobOnly = getPaxDetails({
      passengerType: 'Child',
      dob: '2000-02-29',
    });
    const withPre100Dob = getPaxDetails({
      passengerType: 'Adult',
      dob: '0099-12-31',
      age: 99,
    });

    expect(withDobAndAge.DateOfBirth).toBe('1990-02-28');
    expect(withDobAndAge).not.toHaveProperty('Age');
    expect(withDobOnly.DateOfBirth).toBe('2000-02-29');
    expect(withDobOnly).not.toHaveProperty('Age');
    expect(withPre100Dob.DateOfBirth).toBe('0099-12-31');
    expect(withPre100Dob).not.toHaveProperty('Age');
  });

  it('uses age when DOB is absent', () => {
    const paxDetails = getPaxDetails({
      passengerType: 'Adult',
      age: 36,
    });

    expect(paxDetails.Age).toBe(36);
    expect(paxDetails).not.toHaveProperty('DateOfBirth');
  });

  it.each([
    ['blank', ''],
    ['malformed', '1990/02/28'],
    ['unpadded', '1990-2-28'],
    ['date-time', '1990-02-28T00:00:00Z'],
    ['boxed string', Object('1990-02-28')],
    ['Date object', new Date('1990-02-28T00:00:00Z')],
    ['number', 19900228],
  ])('falls back to age for a %s DOB', (description, dob) => {
    const paxDetails = getPaxDetails({
      passengerType: 'Adult',
      dob,
      age: 36,
    });

    expect(paxDetails.Age).toBe(36);
    expect(paxDetails).not.toHaveProperty('DateOfBirth');
  });

  it.each([
    ['year zero', '0000-01-01'],
    ['month zero', '1990-00-01'],
    ['day zero', '1990-01-00'],
    ['day rollover', '1990-04-31'],
    ['non-leap day', '2025-02-29'],
    ['non-leap century day', '1900-02-29'],
  ])('falls back to age for an impossible %s DOB', (description, dob) => {
    const paxDetails = getPaxDetails({
      passengerType: 'Adult',
      dob,
      age: 36,
    });

    expect(paxDetails.Age).toBe(36);
    expect(paxDetails).not.toHaveProperty('DateOfBirth');
  });

  it('preserves the PersonId early return', () => {
    expect(getPaxDetails({
      personId: 'person-123',
      passengerType: 'Adult',
      dob: '1990-02-28',
      age: 36,
    })).toEqual({ PersonId: 'person-123' });
  });

  it('preserves zero, blank, and NaN age behavior without a valid DOB', () => {
    const adultZero = getPaxDetails({ passengerType: 'Adult', age: 0 });
    const childZero = getPaxDetails({ passengerType: 'Child', age: 0 });
    const blank = getPaxDetails({ passengerType: 'Adult', age: '' });
    const nan = getPaxDetails({ passengerType: 'Adult', age: NaN });

    [adultZero, childZero, blank, nan].forEach(paxDetails => {
      expect(paxDetails).not.toHaveProperty('Age');
      expect(paxDetails).not.toHaveProperty('DateOfBirth');
    });
  });
});

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

  it('replaces non-breaking spaces with regular spaces', () => {
    expect(escapeInvalidXmlChars('Borwieck\u00A0Mrs R')).toBe('Borwieck Mrs R');
  });

  it('strips disallowed control characters', () => {
    expect(escapeInvalidXmlChars('A\u0000B\u0008C')).toBe('ABC');
  });

  it('strips lone UTF-16 surrogate code units', () => {
    expect(escapeInvalidXmlChars('X\uD800Y')).toBe('XY');
  });
});
