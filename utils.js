const R = require('ramda');

// Constants exported
const CUSTOM_RATE_ID_NAME = 'Custom';
const CUSTOM_NO_RATE_NAME = 'CustomNoRates';
const passengerTypeMap = {
  Adult: 'Adult',
  Child: 'Child',
  Infant: 'Infant',
};

// Constants not exported
const BAD_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007f-\u0084\u0086-\u009f\uD800-\uDFFF\uFDD0-\uFDFF\uFFFF\uC008\uFEFF\u00DF]/g; // eslint-disable-line no-control-regex

const hostConnectXmlOptions = {
  prettyPrinting: { enabled: false },
  dtd: {
    include: true,
    name: 'hostConnect_4_06_009.dtd',
  },
};

const wildcardMatch = (wildcard, str) => {
  const w = wildcard.replace(/\s/g, '').replace(/[.+^${}()|[\]\\]/g, '\\$&'); // regexp escape
  const re = new RegExp(`${w.replace(/\*/g, '.*').replace(/\?/g, '.')}`, 'i');
  return re.test(str.replace(/\s/g, ''));
};

const escapeInvalidXmlChars = str => {
  if (!str) return '';
  const convertAccentedChars = s => {
    // according to TC-143, we will go through one mapping first
    // for certain accented chars
    const accentedChars = [
      ['Ä', 'Ae'],
      ['Ö', 'Oe'],
      ['Ü', 'Ue'],
      ['Ø', 'Oe'],
      ['Å', 'Aa'],
      ['Æ', 'Ae'],
      ['ä', 'ae'],
      ['ö', 'oe'],
      ['ü', 'ue'],
      ['ø', 'oe'],
      ['å', 'aa'],
      ['æ', 'ae'],
      ['ß', 'ss'],
    ];
    const preprocessed = accentedChars.reduce((acc, [k, v]) => acc.replace(k, v), s);
    return preprocessed.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  };
  // NOTE: There is no need to sanitize the string for 5 characters (&, <, >, " and ')
  // because js2xmlparser does that for us. Plus if we use sanitize before calling js2xmlparser
  // js2xmlparser will escape & to '&amp;' making it invalid XML
  return convertAccentedChars(str)
    .replace(/’/g, "'")
    .replace(/‘/g, "'")
    .replace(/“/g, '"')
    .replace(/”/g, '"')
    .replace(/–/g, '-')
    .replace(BAD_XML_CHARS, '');
};

const getRoomConfigs = (paxConfigs, noPaxList) => {
  // There should be only 1 RoomConfigs for AddServiceRequest
  const RoomConfigs = {};
  // add one RoomConfig for each room required (i.e. one for each PaxConfig)
  RoomConfigs.RoomConfig = [];
  let indexRoomConfig = 0;
  paxConfigs.forEach((
    {
      roomType, adults, children, infants, passengers = [],
    },
  ) => {
    const EachRoomConfig = passengers.length ? passengers.reduce((acc, p) => {
      if (p.passengerType === passengerTypeMap.Adult) {
        acc.Adults += 1;
      }
      if (p.passengerType === passengerTypeMap.Child) {
        acc.Children += 1;
      }
      if (p.passengerType === passengerTypeMap.Infant) {
        acc.Infants += 1;
      }
      return acc;
    }, {
      Adults: 0,
      Children: 0,
      Infants: 0,
    }) : {
      Adults: adults || 0,
      Children: children || 0,
      Infants: infants || 0,
    };
    const RoomType = ({
      Single: 'SG',
      Double: 'DB',
      Twin: 'TW',
      Triple: 'TR',
      Quad: 'QD',
      Other: 'OT',
    })[roomType];
    if (RoomType) EachRoomConfig.RoomType = RoomType;
    if (passengers && passengers.length && !noPaxList) {
      // There should be only 1 PaxList inside each EachRoomConfig
      EachRoomConfig.PaxList = {};
      // Inside PaxList, there should be 1 PaxDetail for each passenger (Pax)
      EachRoomConfig.PaxList.PaxDetails = passengers.map(p => {
        /*
          TP API doesn't allow us to modify existing pax details
          when PersonId is present, other details are ignored by TP anyways
          when it is not present, TP is comparing every key in PaxDetail to identify
          duplicate, so if we send Pax Detail with the same first and last name, but different
          Age, TP will consider them to be different pax, which actually is duplicate, given
          sometimes AI could be extracting inconsistent data
        */
        if (p.personId) {
          return {
            PersonId: p.personId,
          };
        }
        const EachPaxDetails = {
          Forename: escapeInvalidXmlChars(p.firstName),
          Surname: escapeInvalidXmlChars(p.lastName),
          PaxType: {
            Adult: 'A',
            Child: 'C',
            Infant: 'I',
          }[p.passengerType] || 'A',
        };
        if (p.salutation) EachPaxDetails.Title = escapeInvalidXmlChars(p.salutation);
        if (p.dob) EachPaxDetails.DateOfBirth = p.dob;
        // NOTE: TourPlan API doesn't accept age as empty string, i.e. empty XML tag <Age/>
        // and trhows and error like - "1000 SCN System.InvalidOperationException: There is an
        // error in XML document (29, 8). (Input string was not in a correct format.)"
        // The solution is to NOT send the Age tag if it's empty
        if (!R.isNil(p.age) && !Number.isNaN(p.age) && p.age) {
          if (!(p.passengerType === passengerTypeMap.Adult && p.age === 0)) {
            EachPaxDetails.Age = p.age;
          }
        }
        return EachPaxDetails;
      });
    }
    RoomConfigs.RoomConfig[indexRoomConfig] = EachRoomConfig;
    indexRoomConfig += 1;
  });
  return RoomConfigs;
};

module.exports = {
  escapeInvalidXmlChars,
  getRoomConfigs,
  wildcardMatch,
  CUSTOM_RATE_ID_NAME,
  CUSTOM_NO_RATE_NAME,
  hostConnectXmlOptions,
  passengerTypeMap,
};
