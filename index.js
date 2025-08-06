/* eslint-disable max-len */
const axiosRaw = require('axios');
const Promise = require('bluebird');
const R = require('ramda');
const assert = require('assert');
const moment = require('moment');
const js2xmlparser = require('js2xmlparser');
const xml2js = require('xml2js');
const { XMLParser } = require('fast-xml-parser');
const { translateTPOption } = require('./resolvers/product');
const { translateItineraryBooking } = require('./resolvers/itinerary');

const Normalizer = require('./normalizer');

const xmlParser = new xml2js.Parser();
const fastParser = new XMLParser();
const BAD_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007f-\u0084\u0086-\u009f\uD800-\uDFFF\uFDD0-\uFDFF\uFFFF\uC008\uFEFF\u00DF]/g;
const passengerTypeMap = {
  Adult: 'Adult',
  Child: 'Child',
  Infant: 'Infant',
};

const defaultXmlOptions = {
  prettyPrinting: { enabled: false },
  dtd: {
    include: true,
    name: 'tourConnect_4_00_000.dtd',
  },
};
const hostConnectXmlOptions = {
  prettyPrinting: { enabled: false },
  dtd: {
    include: true,
    name: 'hostConnect_4_06_009.dtd',
  },
};
const getHeaders = ({ length }) => ({
  Accept: 'application/xml',
  'Content-Type': 'application/xml; charset=utf-8',
  'Content-Length': length,
});
const wildcardMatch = (wildcard, str) => {
  const w = wildcard.replace(/\s/g, '').replace(/[.+^${}()|[\]\\]/g, '\\$&'); // regexp escape
  const re = new RegExp(`${w.replace(/\*/g, '.*').replace(/\?/g, '.')}`, 'i');
  return re.test(str.replace(/\s/g, ''));
};
class BuyerPlugin {
  constructor(params = {}) { // we get the env variables from here
    Object.entries(params).forEach(([attr, value]) => {
      this[attr] = value;
    });
    this.tokenTemplate = () => ({
      endpoint: {
        type: 'text',
        regExp: /^(?!mailto:)(?:(?:http|https|ftp):\/\/)(?:\S+(?::\S*)?@)?(?:(?:(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[0-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u00a1-\uffff0-9]+-?)*[a-z\u00a1-\uffff0-9]+)(?:\.(?:[a-z\u00a1-\uffff0-9]+-?)*[a-z\u00a1-\uffff0-9]+)*(?:\.(?:[a-z\u00a1-\uffff]{2,})))|localhost)(?::\d{2,5})?(?:(\/|\?|#)[^\s]*)?$/i,
        description: 'The uri for the tourplan adapter',
      },
      username: {
        type: 'text',
        regExp: /.+/,
        description: 'The tourplan provided username',
        default: 'en',
      },
      password: {
        type: 'text',
        regExp: /.+/,
        description: 'The tourplan provided password',
        default: 'en',
      },
      hostConnectEndpoint: {
        type: 'text',
        regExp: /.+/,
      },
      hostConnectAgentID: {
        type: 'text',
        regExp: /.+/,
      },
      hostConnectAgentPassword: {
        type: 'text',
        regExp: /.+/,
      },
    });
    this.callTourplan = async ({
      model,
      endpoint,
      axios,
      xmlOptions,
    }) => {
      let data = Normalizer.stripEnclosingQuotes(
        js2xmlparser.parse('Request', model, xmlOptions),
      );
      // NOTE: Forward slash is NOT an invalid XML character and hence js2xmlparser
      // doesn't escape it, however TourPlan needs it to be escaped as '&#47;'
      // so we need to do it manually after js2xmlparser has done its thing
      // we need to carefull here because we don't want to escape the forward slash
      // when it's inside a tag, so we use a negative lookbehind and lookahead to
      // ensure the forward slash is not inside a tag.
      // In future if more such characters are found, we can use a more sophisticated
      // approach to handle them
      data = data.replace(/(?<!<)\/(?![^<]*>)/g, '&#47;');
      data = data.replace(xmlOptions.dtd.name, `Request SYSTEM "${xmlOptions.dtd.name}"`);
      let replyObj;
      let errorStr;
      // can't use proxy because of the static IP thing, darn
      // if (this.xmlProxyUrl) {
      //   // use pyfilematch xmlproxy
      //   try {
      //     replyObj = R.path(['data'], await axios({
      //       method: 'post',
      //       url: `${this.xmlProxyUrl}/xmlproxy`,
      //       data: {
      //         url: endpoint,
      //         data,
      //         headers: getHeaders({ length: `${data.length}` }),
      //       },
      //     }));
      //   } catch (err) {
      //     console.log('error in calling pyfilematch xmlproxy', err);
      //     errorStr = `error in calling pyfilematch xmlproxy: ${err}`;
      //   }
      // }
      if (!replyObj) {
        // in case of error /xmlproxy, fallback to call tourplan directly
        // and then use pyfilematch xml2json to parse the xml
        const axiospayload = {
          method: 'post',
          url: endpoint,
          data,
          headers: getHeaders({ length: data.length }),
        };
        // console.log(axiospayload)
        const reply = R.path(['data'], await axios(axiospayload));
        if (this.xmlProxyUrl) {
          try {
            // using raw axios to avoid logging the large xml request
            ({ data: replyObj } = await axiosRaw({
              method: 'post',
              url: `${this.xmlProxyUrl}/xml2json`,
              data: { xml: reply },
              maxContentLength: Infinity,
              maxBodyLength: Infinity,
            }));
          } catch (err) {
            console.warn('error in calling pyfilematch xml2json', R.pathOr('Nada', ['response', 'data', 'error'], err));
            errorStr = `error in calling pyfilematch xml2json: ${R.pathOr('Nada', ['response', 'data', 'error'], err)}`;
          }
        }
        // in case of error from /xml2json, fallback to fast-xml-parser
        if (!replyObj) {
          replyObj = fastParser.parse(reply);
        }
      }
      const requestType = R.keys(model)[0];
      if (!replyObj) throw new Error(`${requestType} failed: ${errorStr || 'no reply object'}`);
      let error = replyObj.error || R.path(['Reply', 'ErrorReply', 'Error'], replyObj);
      if (error) {
        if (error.includes('DateFrom in the past')) {
          error = '1002 - Date is in the past';
        } else if (error.includes('1052 SCN')) {
          error = '1052 - OptionId not found(Check if it is Internet Enabled)';
        } else if (error.includes('SCN Server overloaded')) {
          error = "2051 - The Tourplan server is unavailable. Please wait a minute and try again. If you keep getting this error, please contact your team's Tourplan administrator or Tourplan support."
        }
        throw new Error(`${requestType} failed: ${error}`);
      }
      return R.path(['Reply'], replyObj);
    };

    this.getRoomConfigs = (paxConfigs, noPaxList) => {
      // There should be only 1 RoomConfigs for AddServiceRequest
      let RoomConfigs = {};
      // add one RoomConfig for each room required (i.e. one for each PaxConfig)
      RoomConfigs.RoomConfig = [];
      let indexRoomConfig = 0;
      paxConfigs.forEach(({ roomType, adults, children, infants, passengers = [] }) => {
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
              Forename: this.escapeInvalidXmlChars(p.firstName),
              Surname: this.escapeInvalidXmlChars(p.lastName),
              PaxType: {
                Adult: 'A',
                Child: 'C',
                Infant: 'I',
              }[p.passengerType] || 'A',
            };
            if (p.salutation) EachPaxDetails.Title = this.escapeInvalidXmlChars(p.salutation);
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
        RoomConfigs.RoomConfig[indexRoomConfig++] = EachRoomConfig;
      });
      return RoomConfigs;
    };
    this.escapeInvalidXmlChars = str => {
      if (!str) return '';
      const convertAccentedChars = s => {
        // according to TC-143, we will go through one mapping first
        // for certain accented chars
        const accentedChars = [
          ['Ä', 'Ae'],
          ['Ö', 'Oe'],
          ['Ü', 'Ue'],
          ['ä', 'ae'],
          ['ö', 'oe'],
          ['ü', 'ue'],
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

    this.extractCancelPolicies = (rate, path, isOptionCancelPolicy) => {
      const rawPolicies = R.pathOr([], path, rate);
      let policies = [];
      if (!Array.isArray(rawPolicies)) {
        policies = [rawPolicies]; // If single item, convert to array
      } else {
        policies = rawPolicies;
      }
      return policies.map(policy => {
        const mappedPolicy = {
          // The description of the penalty (optional)
          penaltyDescription: R.path(['PenaltyDescription'], policy),
          // The number of OffsetTimeUnit in this relative deadline
          cancelNum: R.path(['Deadline', 'OffsetUnitMultiplier'], policy),
          // One of Second, Hour, Day, Week, Month or Year
          cancelTimeUnit: R.path(['Deadline', 'OffsetTimeUnit'], policy),
        };

        if (isOptionCancelPolicy) {
          // The absolute deadline, i.e. the final date and time of the deadline. (optional)
          mappedPolicy.deadlineDateTime = R.path(['Deadline', 'DeadlineDateTime'], policy);
          // Y if this penalty is the one used if a service line is cancelled now (N otherwise)
          mappedPolicy.inEffect = R.path(['InEffect'], policy) && R.path(['InEffect'], policy) === 'Y';
          // Amount of the cancellation penalty
          mappedPolicy.cancelFee = R.path(['LinePrice'], policy);
          // Line price less commission.
          mappedPolicy.agentPrice = R.path(['AgentPrice'], policy);
        }
        return Object.fromEntries(
          Object.entries(mappedPolicy).filter(([_, value]) => value !== undefined),
        );
      });
    };

    this.cacheSettings = {
      bookingsProductSearch: {
        // ttl: 60 * 60 * 24, // 1 day
      },
    };

    /*
      Convert children or infants in the pax configs to adults.
      Reason: Tourplan API doesn't support children or infants in the availability check
      when ChildrenAllowed = N & CountChildrenInPaxBreak = Y or InfantsAllowed = N & CountInfantsInPaxBreak = Y.

      Example:
      const originalPaxConfigs = [
        { roomType: 'DB', adults: 2, children: 1, infants: 1 },
        { roomType: 'TW', adults: 1, children: 2, infants: 2 }
      ];

      OUTPUT:
      const convertedPaxConfigs = convertToAdult(originalPaxConfigs, passengerTypeMap.Child);
      Result: [
        { roomType: 'DB', adults: 3, children: 0, infants: 1 },
        { roomType: 'TW', adults: 2, children: 0, infants: 2 }
      ]
      OR
      const convertedPaxConfigs = convertToAdult(originalPaxConfigs, passengerTypeMap.Infant);
      Result: [
        { roomType: 'DB', adults: 3, children: 1, infants: 0 },
        { roomType: 'TW', adults: 2, children: 2, infants: 0 }
      ]
      NOTE: This method only converts children or infants to adults (based on the type parameter),
      it doesn't convert the other type to adults.
    */
    this.convertToAdult = (paxConfigs, type) => {
      if (!Array.isArray(paxConfigs)) {
        return paxConfigs;
      }

      return paxConfigs.map(paxConfig => {
        const newPaxConfig = { ...paxConfig };

        // Convert children or infants to adults
        const typeKey = type === passengerTypeMap.Child ? 'children' : 'infants';
        const totalAdults = (newPaxConfig.adults || 0) + (newPaxConfig[typeKey] || 0);
        newPaxConfig.adults = totalAdults;
        newPaxConfig[typeKey] = 0;

        // now update the type of the passengers to adults
        if (newPaxConfig.passengers && Array.isArray(newPaxConfig.passengers)) {
          newPaxConfig.passengers = newPaxConfig.passengers.map(passenger => ({
            ...passenger,
            passengerType: passenger.passengerType === type ? passengerTypeMap.Adult : passenger.passengerType,
          }));
        }

        return newPaxConfig;
      });
    };

    /*
      Calculate the end date for an option based on start date, duration, and charge unit quantity.

      @param {string} startDate - The start date in YYYY-MM-DD format
      @param {number|null} duration - The duration in days (optional)
      @param {number|null} chargeUnitQuantity - The number of charge units (optional)
      @returns {string|null} The end date in YYYY-MM-DD format or null if not applicable
    */
    this.calculateEndDate = (startDate, duration, chargeUnitQuantity) => {
      const startMoment = moment(startDate, 'YYYY-MM-DD');
      let endDate = null;

      if (duration) {
        endDate = startMoment.clone().add(duration, 'days');
      } else if (chargeUnitQuantity && chargeUnitQuantity > 1) {
        endDate = startMoment.clone().add(chargeUnitQuantity, 'days');
      }

      return endDate ? endDate.format('YYYY-MM-DD') : null;
    };

    /*
      Get the message for an option based on duration, charge unit quantity, and charge unit.

      @param {number|null} duration - The duration in days (optional)
      @param {number|null} chargeUnitQuantity - The number of charge units (optional)
      @param {string|null} chargeUnit - The charge unit type (optional)
      @returns {string|null} The message or null if not applicable
    */
    this.getOptionMessage = (duration, chargeUnitQuantity, chargeUnit) => {
      const chargeUnitText = chargeUnit || 'Nights/Days';
      let message = null;
      if (duration && chargeUnitQuantity && duration !== chargeUnitQuantity) {
        message = `This option allows exactly ${duration} ${chargeUnitText}. The end date is adjusted accordingly.`;
      }
      return message;
    };

    /*
      Get general option information from Tourplan API.

      @param {string} optionId - The option ID to get information for
      @param {string} hostConnectEndpoint - The HostConnect endpoint
      @param {string} hostConnectAgentID - The agent ID
      @param {string} hostConnectAgentPassword - The agent password
      @param {Object} axios - The axios instance
      @returns {Object} Object containing general option information
    */
    this.getOptionGeneralInfo = async (optionId, hostConnectEndpoint, hostConnectAgentID, hostConnectAgentPassword, axios) => {
      const getGeneralModel = checkType => ({
        OptionInfoRequest: {
          Opt: optionId,
          Info: checkType,
          AgentID: hostConnectAgentID,
          Password: hostConnectAgentPassword,
        },
      });

      // Use G (General) check type to get the option general information
      const [GCheck] = await Promise.map(['G'], async checkType => {
        const replyObj = await this.callTourplan({
          model: getGeneralModel(checkType),
          endpoint: hostConnectEndpoint,
          axios,
          xmlOptions: hostConnectXmlOptions,
        });
        return R.path(['OptionInfoReply', 'Option'], replyObj);
      });

      const OptGeneralResult = R.pathOr({}, ['OptGeneral'], GCheck);
      const countChildrenInPaxBreak = R.pathOr(false, ['CountChildrenInPaxBreak'], OptGeneralResult) === 'Y';
      const countInfantsInPaxBreak = R.pathOr(false, ['CountInfantsInPaxBreak'], OptGeneralResult) === 'Y';
      const duration = R.pathOr(null, ['Periods'], OptGeneralResult);
      // As per HostConnect documentation, MPFCU is only returned if SType is N or A.
      const maxPaxPerCharge = R.pathOr(null, ['MPFCU'], OptGeneralResult);
      const chargeUnit = R.pathOr(null, ['SCU'], OptGeneralResult);

      return {
        countChildrenInPaxBreak,
        countInfantsInPaxBreak,
        duration,
        maxPaxPerCharge,
        chargeUnit,
      };
    };

    /*
      Get the stay results for an option based on start date, charge unit quantity, and room configs.

      @param {string} optionId - The option ID
      @param {string} hostConnectEndpoint - The HostConnect endpoint
      @param {string} hostConnectAgentID - The agent ID
      @param {string} hostConnectAgentPassword - The agent password
      @param {string} startDate - The start date
      @param {number} chargeUnitQuantity - The number of charge units
      @param {Object} roomConfigs - The room configurations
      @returns {Object} The stay results
    */
    this.getStayResults = async (optionId, hostConnectEndpoint, hostConnectAgentID, hostConnectAgentPassword, axios,
      startDate, chargeUnitQuantity, roomConfigs) => {
      const getModel = checkType => ({
        OptionInfoRequest: {
          Opt: optionId,
          Info: checkType,
          DateFrom: startDate,
          SCUqty: (() => {
            const num = parseInt(chargeUnitQuantity, 10);
            if (isNaN(num) || num < 1) return 1;
            return num;
          })(),
          RoomConfigs: roomConfigs,
          AgentID: hostConnectAgentID,
          Password: hostConnectAgentPassword,
        },
      });
      // Always use G (General) & S (Stay & Availability) check types
      const [GSCheck] = await Promise.map(['GS'], async checkType => {
        const replyObj = await this.callTourplan({
          model: getModel(checkType),
          endpoint: hostConnectEndpoint,
          axios,
          xmlOptions: hostConnectXmlOptions,
        });
        return R.path(['OptionInfoReply', 'Option'], replyObj);
      });
      /*
        If not rates, optionInfoReply is null, meaning it's not bookable
        otherwise, example data:
        {
          optionInfoReply: {
            Option: {
              Opt: 'LHRTRDAVIDSHABTVC',
              OptStayResults: {
                AgentPrice: '51175',
                Availability: 'RQ',
                CancelHours: '96',
                CommissionPercent: '0.00',
                Currency: 'GBP',
                PeriodValueAdds: {
                  PeriodValueAdd: {
                    DateFrom: '2024-08-10',
                    DateTo: '2024-08-10',
                    RateName: 'Std-Mon Sun',
                    RateText: 'Std'
                  }
                },
                RateId: '$NZD2016b81f44793096,4,DOUB,C5 A1INF KGB DOUB RONL',
                RateName: 'Std-Mon Sun',
                RateText: 'Std',
                SaleFrom: '2023-12-20',
                TotalPrice: '51175',
                ExternalRateDetails: {
                  ExtSupplierId: 'NZ000021',
                  ExtOptionId: 'DOUB',
                  ExtOptionDescr: 'Superior Room, 1 King Bed',
                  ExtRatePlanCode: 'C5 A1INF KGB DOUB RONL',
                  ExtRatePlanDescr: 'Room Only',
                  ExtGuarantee: 'N',
                },
                RoomList: {
                  RoomType: 'DB',
                }
              },
              OptionNumber: '70461'
            }
          }
        }
      */
      // const ACheckPass = (() => {
      //   /*
      //     FROM TP DOCS:
      //     Each integer in the list gives the availability for one of the days in the range requested,
      //     from the start date through to the end date. The integer values are to be interpreted as
      //     follows:
      //     Greater than 0 means that inventory is available, with the integer specifying the
      //     number of units available. For options with a service type of Y , the inventory is in
      //     units of rooms. For other service types, the inventory is in units of pax.
      //     -1 Not available.
      //     -2 Available on free sell.
      //     -3 Available on request.
      //     Note: A return value of 0 or something less than -3 is impossible.
      //   */
      //   const optAvail = parseInt(R.pathOr('-4', ['OptAvail'], ACheck), 10);
      //   if (optAvail === -1) {
      //     return {
      //       available: false,
      //     };
      //   }
      //   if (optAvail === -2) {
      //     return {
      //       available: true,
      //       type: 'free sell',
      //     };
      //   }
      //   if (optAvail === -3) {
      //     return {
      //       available: true,
      //       type: 'on request',
      //     };
      //   }
      //   if (optAvail > 0) {
      //     return {
      //       available: true,
      //       type: 'inventory',
      //       quantity: optAvail,
      //     };
      //   }
      //   return {
      //     available: false,
      //   };
      // })();
      let OptStayResults = R.pathOr([], ['OptStayResults'], GSCheck);
      if (!Array.isArray(OptStayResults)) OptStayResults = [OptStayResults];
      return OptStayResults;
    };
  }

  async validateToken({
    axios,
    token: {
      endpoint,
      username,
      password,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
    },
  }) {
    try {
      if (hostConnectEndpoint) {
        assert(hostConnectAgentID && hostConnectAgentPassword);
        const model = {
          AgentInfoRequest: {
            AgentID: hostConnectAgentID,
            Password: hostConnectAgentPassword,
          },
        };
        const replyObj = await this.callTourplan({
          model,
          endpoint: hostConnectEndpoint,
          axios,
          xmlOptions: hostConnectXmlOptions,
        });
        assert(R.path(['AgentInfoReply', 'Currency'], replyObj));
        return true;
      }
      const model = {
        AuthenticationRequest: {
          Login: username,
          Password: password,
        },
      };
      const replyObj = await this.callTourplan({
        model, endpoint, axios, xmlOptions: defaultXmlOptions,
      });
      assert(R.path(['AuthenticationReply'], replyObj) === '');
      return true;
    } catch (err) {
      console.error(err.message);
      return false;
    }
  }

  async queryAllotment({
    axios,
    token: {
      endpoint = this.endpoint,
      username = this.username,
      password = this.password,
    },
    payload: {
      dateFormat = 'DD/MM/YYYY',
      startDate,
      endDate,
      keyPath,
      appliesTo: appliesToFilter,
    },
  }) {
    const verbose = R.path(['verbose'], this);
    const cleanLog = inputString =>
      (inputString || '').toString()
        .replaceAll(username, '****').replaceAll(password, '****');
    assert(endpoint);
    assert(startDate);
    assert(endDate);
    assert(keyPath, 'Must provide a supplier/product spec');
    const keyPathArr = keyPath.split('|');
    assert(keyPathArr.length > 1, 'Must provide a supplier id and a product id');
    const supplierId = R.path([-2], keyPathArr);
    const productId = R.path([-1], keyPathArr);
    assert(supplierId);
    assert(productId);
    const model = {
      GetInventoryRequest: {
        SupplierCode: supplierId,
        Date_From: moment(startDate, dateFormat).format('YYYY-MM-DD'),
        Date_To: moment(endDate, dateFormat).format('YYYY-MM-DD'),
        OptionCode: productId,
        // AllocationName: '2021 REBOOT',
        // Unit_Type: 'RM',
        Login: username,
        Password: password,
      },
    };
    let data = Normalizer.stripEnclosingQuotes(
      js2xmlparser.parse('Request', model, defaultXmlOptions),
    );
    data = data.replace(defaultXmlOptions.dtd.name, `Request SYSTEM "${defaultXmlOptions.dtd.name}"`);
    if (verbose) console.log('request', cleanLog(data));
    const reply = R.path(['data'], await axios({
      metod: 'post',
      url: endpoint,
      data,
      headers: getHeaders({ length: data.length }),
    }));
    if (verbose) console.log('reply', cleanLog(reply));
    const returnObj = await xmlParser.parseStringPromise(reply);
    let allotment = R.pathOr(
      [],
      ['Reply', 'GetInventoryReply', 0, 'Allocation'],
      returnObj,
    );
    // remove empty instances
    allotment = allotment.filter(currentAllotment => Array.isArray(currentAllotment.Split));
    const allotmentResponse = [];
    allotment.forEach(currentAllotment => {
      const appliesToCode = R.path(['AllocationAppliesTo', 0, 'AllocationType', 0], currentAllotment);
      const optionCodes = R.pathOr([], ['AllocationAppliesTo', 0, 'OptionCode'], currentAllotment);
      const supplierCode = R.path(['SupplierCode', 0], currentAllotment);
      const appliesTo = {
        S: 'Supplier',
        O: 'Product',
      }[appliesToCode] || appliesToCode;
      const allotmentName = R.path(['AllocationName', 0], currentAllotment);
      const allotmentDescription = R.path(['AllocationDescription', 0], currentAllotment);
      currentAllotment.Split.forEach(currentSplit => {
        const splitCode = R.path(['Split_Code', 0], currentSplit);
        R.path(['UnitTypeInventory'], currentSplit).forEach(currentUnitType => {
          const unitType = R.path(['Unit_Type', 0], currentUnitType);
          R.path(['PerDayInventory'], currentUnitType).forEach(dayInventory => {
            const date = moment(R.path(['Date', 0], dayInventory), 'YYYY-MM-DD')
              .format(dateFormat);
            allotmentResponse.push({
              name: allotmentName,
              description: allotmentDescription,
              appliesTo,
              splitCode,
              unitType,
              date,
              release: R.path(['Release_Period', 0], dayInventory),
              max: R.path(['Max_Qty', 0], dayInventory),
              booked: R.path(['Bkd_Qty', 0], dayInventory),
              request: {
                Y: true,
                N: false,
              }[R.path(['Request_OK', 0], dayInventory)],
              keyPaths: optionCodes.map(currentProduct => `${supplierCode}|${currentProduct}`),
            });
          });
        });
      });
    });
    return {
      allotment: (() => {
        if (appliesToFilter) {
          return allotmentResponse.filter(
            ({ appliesTo }) => appliesTo === appliesToFilter,
          );
        }
        return allotmentResponse;
      })(),
    };
  }

  async searchProductsForItinerary({
    axios,
    typeDefsAndQueries: {
      itineraryProductTypeDefs,
      itineraryProductQuery,
    },
    token: {
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      configuration,
    },
    payload: {
      // single optionId or array of optionIds
      optionId,
      forceRefresh,
      searchInput,
      // lastUpdatedFrom is used to get options that were updated after a certain date in Tourplan
      // example: lastUpdatedFrom: '2024-04-22 05:17:57.427Z'
      lastUpdatedFrom,
    },
  }) {
    /*
      Pseudo
      1. getServiceCodes -> [AC, BD]
      2. for each serviceCode getoptions
      3. convert them to ti2 products structure
      4. merge all products from all serviceCodes
    */
    // getServices
    const getServicesModel = {
      GetServicesRequest: {
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
      },
    };
    const getServicesReply = await this.callTourplan({
      model: getServicesModel,
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    });
    let serviceCodes = R.pathOr([], ['GetServicesReply', 'TPLServices', 'TPLService'], getServicesReply);
    if (!Array.isArray(serviceCodes)) serviceCodes = [serviceCodes];
    serviceCodes = serviceCodes.map(s => s.Code);
    let options = [];
    await Promise.each(serviceCodes, async serviceCode => {
      const getOptionsModel = {
        OptionInfoRequest: {
          Opt: `???${serviceCode}????????????`,
          Info: 'G',
          AgentID: hostConnectAgentID,
          Password: hostConnectAgentPassword,
          ...(lastUpdatedFrom ? {
            LastUpdateFrom: lastUpdatedFrom,
          } : {}),
        },
      };
      const getOptionsReply = await this.callTourplan({
        model: getOptionsModel,
        endpoint: hostConnectEndpoint,
        axios,
        xmlOptions: hostConnectXmlOptions,
      });
      let thisOptions = R.pathOr([], ['OptionInfoReply', 'Option'], getOptionsReply);
      // due to the new parser, single option will be returned as an object
      // instead of an array
      if (!Array.isArray(thisOptions)) thisOptions = [thisOptions];
      console.log(`got ${thisOptions.length} options for serviceCode ${serviceCode}`);
      options = options.concat(thisOptions);
    });
    if (!(options && options.length)) {
      throw new Error('No products found');
    }
    const arrayOfOptionsGroupedBySupplierId = R.call(R.compose(
      R.values,
      R.groupBy(R.path(['OptGeneral', 'SupplierId'])),
    ), options);
    const products = await Promise.map(
      arrayOfOptionsGroupedBySupplierId,
      optionsGroupedBySupplierId => translateTPOption({
        rootValue: {
          optionsGroupedBySupplierId,
        },
        typeDefs: itineraryProductTypeDefs,
        query: itineraryProductQuery,
      }),
      {
        concurrency: 10,
      },
    );
    return {
      products,
      productFields: [],
      ...(searchInput || optionId ? {} : configuration),
    };
  }

  async searchAvailabilityForItinerary({
    axios,
    token: {
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
    },
    payload: {
      optionId,
      startDate,
      /*
      paxConfigs: [{ roomType: 'DB', adults: 2 }, { roomType: 'TW', children: 2 }]
      */
      paxConfigs,
      // passengers,
      /*
        The number of second charge units required (second charge units are discussed
        in the OptionInfo section). Should only be specified for options that have SCUs.
        Defaults to 1.
      */
      chargeUnitQuantity,
    },
  }) {
    const {
      countChildrenInPaxBreak,
      countInfantsInPaxBreak,
      duration,
      maxPaxPerCharge,
      chargeUnit,
    } = await this.getOptionGeneralInfo(optionId, hostConnectEndpoint, hostConnectAgentID, hostConnectAgentPassword, axios);

    /*
      Create modified passenger configurations based on the count flags.
      This function handles the conversion of children and infants to adults
      when the respective count flags are enabled, which is necessary for
      Tourplan API compatibility, see comments for treatChildrenAsAdults
      and treatInfantsAsAdults for more details.
    */
    const getModifiedPaxConfigs = () => {
      let modifiedPaxConfigs = [];
      if (countChildrenInPaxBreak) modifiedPaxConfigs = this.convertToAdult(paxConfigs, passengerTypeMap.Child);
      if (countInfantsInPaxBreak) modifiedPaxConfigs = this.convertToAdult(modifiedPaxConfigs, passengerTypeMap.Infant);
      return modifiedPaxConfigs.length ? modifiedPaxConfigs : paxConfigs;
    };
    const roomConfigs = this.getRoomConfigs(getModifiedPaxConfigs(), true);

    /*
      Verify that each RoomConfig does not exceed maxPaxPerCharge.
      Reason: Tourplan availability check returns success even if the pax configs
      exceed the maxPaxPerCharge. And then when the booking is made, the booking fails
      with the error like "002 SCN adults + children exceeds capacity".
     */
    for (let i = 0; maxPaxPerCharge && (i < roomConfigs.RoomConfig.length); i++) {
      const room = roomConfigs.RoomConfig[i];
      const roomPax = (room.Adults || 0) + (room.Children || 0) + (room.Infants || 0);
      if (roomPax > maxPaxPerCharge) {
        /*
          NOTE: As a long term solution, we need to return the errors per pax config
          so that the UI can display the errors for the particular pax config.
          For now we return on the 1st error and show the error in availability check.
        */
        return {
          bookable: false,
          type: 'inventory',
          rates: [],
          message: `Maximum ${maxPaxPerCharge} pax allowed per Pax Config. Pax Config ${i + 1} has ${roomPax} pax.`,
        };
      }
    }

    const OptStayResults = await this.getStayResults(
      optionId,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      axios,
      startDate,
      chargeUnitQuantity,
      roomConfigs,
    );
    const SCheckPass = Boolean(OptStayResults.length);

    // Get the end date
    const endDate = this.calculateEndDate(startDate, duration, chargeUnitQuantity);

    // Get the message
    const message = this.getOptionMessage(duration, chargeUnitQuantity, chargeUnit);

    return {
      bookable: Boolean(SCheckPass),
      type: 'inventory',
      ...(endDate ? { endDate } : {}),
      ...(message ? { message } : {}),
      rates: OptStayResults.map(rate => {
        const currency = R.pathOr('', ['Currency'], rate);
        // NOTE: Check if the value is in cents or not
        const totalPrice = R.pathOr('', ['TotalPrice'], rate);
        const agentPrice = R.pathOr('', ['AgentPrice'], rate);
        const totalPriceCurrencyPrecision = R.pathOr(2, ['currencyPrecision'], rate);
        // Cancellations within this number of hours of service date incur a cancellation
        // penalty of some sort.
        const cancelHours = R.pathOr('', ['CancelHours'], rate);
        /* Sample data: for cancel policies for the option id (not the external rate)
          <CancelPolicies>
            <CancelPenalty>
                <Deadline>
                    <OffsetUnitMultiplier>168</OffsetUnitMultiplier>
                    <OffsetTimeUnit>Hour</OffsetTimeUnit>
                    <DeadlineDateTime>2025-07-18T22:00:00Z</DeadlineDateTime>
                </Deadline>
                <InEffect>N</InEffect>
                <LinePrice>1021200</LinePrice>
                <AgentPrice>1021200</AgentPrice>
            </CancelPenalty>
            <CancelPenalty>
                <Deadline>
                    <OffsetUnitMultiplier>720</OffsetUnitMultiplier>
                    <OffsetTimeUnit>Hour</OffsetTimeUnit>
                    <DeadlineDateTime>2025-06-25T22:00:00Z</DeadlineDateTime>
                </Deadline>
                <InEffect>Y</InEffect>
                <LinePrice>204240</LinePrice>
                <AgentPrice>204240</AgentPrice>
            </CancelPenalty>
          </CancelPolicies>
        */
        let cancelPolicies = this.extractCancelPolicies(rate, ['CancelPolicies', 'CancelPenalty'], true)
          .filter(policy => policy.inEffect === true);

        let externalRateText = R.pathOr('', ['ExternalRateDetails', 'ExtOptionDescr'], rate);
        const extRatePlanDescr = R.pathOr('', ['ExternalRateDetails', 'ExtRatePlanDescr'], rate);
        if (extRatePlanDescr && !externalRateText.includes(extRatePlanDescr)) {
          externalRateText = `${externalRateText} (${extRatePlanDescr})`;
        }

        /* Sample data: For external start times
          <ExternalRateDetails>
            <ExtStartTimes>
              <ExtStartTime>2026-04-01T06:30:00</ExtStartTime>
              <ExtStartTime>2026-04-01T07:30:00</ExtStartTime>
              ...
            </ExtStartTimes>
          </ExternalRateDetails>
        */
        // Extract external start times
        const extStartTimes = (() => {
          // Note: Tourplan expects the start time in HH:MM format, so convert before sending to UI
          const startTimes = R.pathOr([], ['ExternalRateDetails', 'ExtStartTimes', 'ExtStartTime'], rate);
          if (!Array.isArray(startTimes)) {
            // If single item, convert to array
            return startTimes ? [{ startTime: startTimes.split('T')[1].substring(0, 5) }] : [];
          }
          return startTimes.map(startTime => ({ startTime: startTime.split('T')[1].substring(0, 5) }));
        })();

        /* Sample data: For external pickup and dropoff details
          Address & ExtPointInfo are optional

          <ExternalRateDetails>
            <ExtPickupDetails>
              <ExtPickupDetail>
                  <ExtPointName>Adina/Vibe Waterfront</ExtPointName>
                  <MinutesPrior>30</MinutesPrior>
                  <Address>7 Kitchener Dr, Darwin</Address>
                  <ExtPointInfo>Additional Info.</ExtPointInfo>
              </ExtPickupDetail>
              <ExtPickupDetail>
                  <ExtPointName>Argus Hotel</ExtPointName>
                  <MinutesPrior>30</MinutesPrior>
                  <Address>13 Shepherd St, Darwin (Front of Hotel)</Address>
                  <ExtPointInfo>Additional Info.</ExtPointInfo>
              </ExtPickupDetail>
              ...
            </ExtDropoffDetails>
          </ExternalRateDetails>
        */
        const extPickupDetails = (() => {
          const pickupDetails = R.pathOr([], ['ExternalRateDetails', 'ExtPickupDetails', 'ExtPickupDetail'], rate);
          if (!Array.isArray(pickupDetails)) {
            // If single item, convert to array
            return pickupDetails ? [pickupDetails] : [];
          }
          return pickupDetails.map(detail => ({
            pointName: R.pathOr('', ['ExtPointName'], detail),
            minutesPrior: R.pathOr('', ['MinutesPrior'], detail),
            address: R.pathOr('', ['Address'], detail),
            pointInfo: R.pathOr('', ['ExtPointInfo'], detail),
          }));
        })();

        const extDropoffDetails = (() => {
          const dropoffDetails = R.pathOr([], ['ExternalRateDetails', 'ExtDropoffDetails', 'ExtDropoffDetail'], rate);
          if (!Array.isArray(dropoffDetails)) {
            // If single item, convert to array
            return dropoffDetails ? [dropoffDetails] : [];
          }
          return dropoffDetails.map(detail => ({
            pointName: R.pathOr('', ['ExtPointName'], detail),
            minutesPrior: R.pathOr('', ['MinutesPrior'], detail),
            address: R.pathOr('', ['Address'], detail),
            pointInfo: R.pathOr('', ['ExtPointInfo'], detail),
          }));
        })();

        /* Sample data: for cancel policies for the external rate
          <ExternalRateDetails>
            <CancelPolicies>
                <CancelPenalty>
                    <PenaltyDescription>Cancellation 100% - within 24 hours or no notice</PenaltyDescription>
                </CancelPenalty>
                <CancelPenalty>
                    <Deadline>
                        <OffsetUnitMultiplier>2</OffsetUnitMultiplier>
                        <OffsetTimeUnit>Day</OffsetTimeUnit>
                    </Deadline>
                    <PenaltyDescription>Day Tour Cancellation within 48hrs - 50%</PenaltyDescription>
                </CancelPenalty>
                <CancelPenalty>
                    <PenaltyDescription>Day Tour Cancellation within 24hrs - 100%</PenaltyDescription>
                </CancelPenalty>
            </CancelPolicies>
          </ExternalRateDetails>
        */
        if (cancelPolicies.length === 0) {
          // If no cancel policies for the option, check the external rate
          cancelPolicies = this.extractCancelPolicies(rate, ['ExternalRateDetails', 'CancelPolicies', 'CancelPenalty'], false);
        }
        /* Sample data: For additional details
          <AdditionalDetails>
            <AdditionalDetail>
                <DetailName>Keywords</DetailName>
                <DetailDescription>1|king|bed|classic|non|smoking</DetailDescription>
            </AdditionalDetail>
          </AdditionalDetails>
        */
        const additionalDetails = (() => {
          const addDetails = R.pathOr([], ['ExternalRateDetails', 'AdditionalDetails', 'AdditionalDetail'], rate);
          if (!Array.isArray(addDetails)) {
            // If single item, convert to array
            return addDetails ? [addDetails] : [];
          }
          return addDetails.map(detail => ({
            detailName: R.pathOr('', ['DetailName'], detail),
            detailDescription: R.pathOr('', ['DetailDescription'], detail),
          }));
        })();

        return {
          rateId: R.path(['RateId'], rate),
          currency,
          totalPrice,
          agentPrice,
          totalPriceCurrencyPrecision,
          cancelHours,
          externalRateText,
          cancelPolicies,
          startTimes: extStartTimes,
          puInfoList: extPickupDetails.length ? extPickupDetails : [],
          doInfoList: extDropoffDetails.length ? extDropoffDetails : [],
          additionalDetails,
        };
      }),
    };
  }

  async addServiceToItinerary({
    axios,
    token: {
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
    },
    payload: {
      quoteName,
      rateId,
      quoteId,
      // existingQuoteId,
      // existingLineId,
      optionId,
      startDate,
      reference,
      /*
      paxConfigs: [{ roomType: 'DB', adults: 2 }, { roomType: 'TW', children: 2 }]
      */
      paxConfigs,
      /*
        The number of second charge units required (second charge units are discussed
        in the OptionInfo section). Should only be specified for options that have SCUs.
        Defaults to 1.
      */
      chargeUnitQuantity,
      extras,
      startTime,
      puInfo,
      doInfo,
      notes,
      QB,
      directHeaderPayload,
      directLinePayload,
      customFieldValues = [],
    },
  }) {
    const cfvPerService = customFieldValues.filter(f => f.isPerService && f.value)
      .reduce((acc, f) => {
        if (f.type === 'extended-option') {
          acc[f.id] = f.value.value || f.value;
        } else {
          acc[f.id] = f.value;
        }
        return acc;
      }, {});

    // if external pickup and dropoff details are provided, use that info
    // 1. If start time is provided send it in puTime
    // 2. if extenral details are provided, send them in puRemark in the format:
    //    (ExtPointName, ExtPointInfo, Address, Minutes prior)
    // 3. the following shoud be sent:
    //    puTime: '0930'
    //    puRemark: 'Airport Pickup,Meet at arrivals hall,Airport Terminal 1,45,'
    //    doTime: '1130' (Note: this is not used for external dropoff details)
    //    doRemark: 'Hotel Dropoff,Drop at hotel entrance,456 Downtown Ave, City Center,15,',
    let puTime = null;
    let puRemark = null;
    if (puInfo) {
      if (puInfo.time || puInfo.location || puInfo.flightDetails) {
        if (puInfo.time && puInfo.time.replace(/\D/g, '')) {
          puTime = puInfo.time.replace(/\D/g, '');
        }
        puRemark = this.escapeInvalidXmlChars(`${puInfo.location ? `Location: ${puInfo.location || 'NA'},` : ''}
          ${puInfo.flightDetails ? `Flight: ${puInfo.flightDetails || 'NA'},` : ''}`);
      } else if (puInfo.address || puInfo.pointName || puInfo.pointInfo || puInfo.minutesPrior) {
        if (startTime) {
          puTime = startTime.replace(/\D/g, '');
        }
        puRemark = this.escapeInvalidXmlChars(`${puInfo.pointName ? `${puInfo.pointName},` : ''}${puInfo.pointInfo ? `${puInfo.pointInfo},` : ''}${puInfo.address ? `${puInfo.address},` : ''}${puInfo.minutesPrior ? `${puInfo.minutesPrior},` : ''}`);
      }
    }

    let doTime = null;
    let doRemark = null;
    if (doInfo) {
      if (doInfo.time || doInfo.location || doInfo.flightDetails) {
        if (doInfo.time && doInfo.time.replace(/\D/g, '')) {
          doTime = doInfo.time.replace(/\D/g, '');
        }
        doRemark = this.escapeInvalidXmlChars(`${doInfo.location ? `Location: ${doInfo.location || 'NA'},` : ''}
          ${doInfo.flightDetails ? `Flight: ${doInfo.flightDetails || 'NA'},` : ''}`);
      } else if (doInfo.address || doInfo.pointName || doInfo.pointInfo || doInfo.minutesPrior) {
        // Note: There is no doTime for external dropoff details
        doRemark = this.escapeInvalidXmlChars(`${doInfo.pointName ? `${doInfo.pointName},` : ''}${doInfo.pointInfo ? `${doInfo.pointInfo},` : ''}${doInfo.address ? `${doInfo.address},` : ''}${doInfo.minutesPrior ? `${doInfo.minutesPrior},` : ''}`);
      }
    }

    const model = {
      AddServiceRequest: {
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
        ...(quoteId ? {
          ExistingBookingInfo: { BookingId: quoteId },
        } : {
          NewBookingInfo: {
            Name: this.escapeInvalidXmlChars(quoteName),
            QB: QB || 'Q',
            ...(directHeaderPayload || {}),
          },
        }),
        ...(puTime ? { puTime } : {}),
        ...(puRemark ? { puRemark } : {}),
        ...(doTime ? { doTime } : {}),
        ...(doRemark ? { doRemark } : {}),
        ...(extras && extras.filter(e => e.selectedExtra && e.selectedExtra.id).length ? {
          ExtraQuantities: {
            ExtraQuantityItem: extras.filter(e => e.selectedExtra && e.selectedExtra.id).map(e => ({
              SequenceNumber: e.selectedExtra.id,
              ExtraQuantity: e.quantity,
            })),
          },
        } : {}),
        Remarks: this.escapeInvalidXmlChars(notes).slice(0, 220),
        Opt: optionId,
        DateFrom: startDate,
        RateId: rateId || 'Default',
        SCUqty: (() => {
          const num = parseInt(chargeUnitQuantity, 10);
          if (isNaN(num) || num < 1) return 1;
          return num;
        })(),
        AgentRef: reference,
        RoomConfigs: this.getRoomConfigs(paxConfigs),
        ...(directLinePayload || {}),
        ...(cfvPerService || {}),
      },
    };
    const replyObj = await this.callTourplan({
      model,
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    });
    return {
      message: R.path(['AddServiceReply', 'Status'], replyObj)
        === 'NO' ? 'Service cannot be added to quote for the requested date/stay. (e.g. no rates, block out period, on request, minimum stay etc.)' : '',
      booking: {
        id: R.path(['AddServiceReply', 'BookingId'], replyObj) || quoteId,
        reference: R.path(['AddServiceReply', 'Ref'], replyObj),
        linePrice: R.path(['AddServiceReply', 'Services', 'Service', 'LinePrice'], replyObj),
        lineId: R.path(['AddServiceReply', 'ServiceLineId'], replyObj),
      },
    };
  }

  // eslint-disable-next-line class-methods-use-this
  async getCreateItineraryFields({
    token: {
      hostConnectAgentID,
      hostConnectAgentPassword,
      hostConnectEndpoint,
    },
    axios,
  }) {
    const model = {
      GetLocationsRequest: {
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
      },
    };
    const GetLocationsReply = await this.cache.getOrExec({
      fnParams: [model],
      fn: () => this.callTourplan({
        model,
        endpoint: hostConnectEndpoint,
        axios,
        xmlOptions: hostConnectXmlOptions,
      }),
      ttl: 60 * 60 * 12, // 2 hours
    });
    let locationCodes = R.pathOr([], ['GetLocationsReply', 'Locations', 'Location'], GetLocationsReply);
    if (!Array.isArray(locationCodes)) locationCodes = [locationCodes];
    const customFields = [{
      id: 'LocationCode',
      label: 'Location Code',
      type: 'extended-option',
      isPerService: true,
      options: locationCodes.map(o => ({ value: o.Code, label: `${o.Name} (${o.Code})` })),
    }];
    return {
      fields: [],
      customFields,
    };
  }

  async searchItineraries({
    token: {
      hostConnectAgentID,
      hostConnectAgentPassword,
      hostConnectEndpoint,
    },
    axios,
    typeDefsAndQueries: {
      itineraryBookingTypeDefs,
      itineraryBookingQuery,
    },
    payload: {
      purchaseDateStart,
      purchaseDateEnd,
      bookingId,
      name,
    },
  }) {
    const getPayload = (RequestType, RequestInput) => ({
      model: {
        [RequestType]: {
          AgentID: hostConnectAgentID,
          Password: hostConnectAgentPassword,
          ...RequestInput,
        },
      },
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    });
    const listBookingPayload = getPayload('ListBookingsRequest', {
      EnteredDateFrom: purchaseDateStart || moment().subtract(6, 'month').format('YYYY-MM-DD'),
      EnteredDateTo: purchaseDateEnd || moment().format('YYYY-MM-DD'),
    });
    let searchCriterias = [];
    if (bookingId) {
      searchCriterias = ['BookingId', 'Ref', 'AgentRef'].map(key => ({ [key]: this.escapeInvalidXmlChars(bookingId) }));
    }
    if (name) {
      searchCriterias.push({ NameContains: this.escapeInvalidXmlChars(name) });
    }
    const allSearches = searchCriterias.length
      ? searchCriterias.map(async keyObj => {
        let reply;
        try {
          reply = await this.callTourplan(getPayload('ListBookingsRequest', keyObj));
        } catch (err) {
          if (err.includes && err.includes('Request failed with status code')) {
            throw Error(err);
          }
          // if it's not server error, we just considered as no booking is found
          // console.log('error in searchBooking', err);
          reply = { ListBookingsReply: { BookingHeaders: { BookingHeader: [] } } };
        }

        // {"ListBookingsReply":
        //  {"BookingHeaders":
        //    {"BookingHeader":[
        //        {"AgentRef":"2399181","BookingId":"314164","BookingStatus":"Quotation","BookingType":"F",
        //          "Consult":null,"Currency":"GBP","EnteredDate":"2024-05-23","IsInternetBooking":"Y",
        //          "Name":"Mr. Robert Slavonia x2 2399181","QB":"Q","Ref":"ALFI393309","TotalPrice":"583143",
        //          "TravelDate":"2024-07-09"},{"AgentRef":"666666/1","BookingId":"315357",
        //          "BookingStatus":"Quotation","BookingType":"F","Consult":null,"Currency":"GBP",
        //          "EnteredDate":"2024-06-04","IsInternetBooking":"Y","Name":"Robert Guerrerio x3 2413898",
        //          "QB":"Q","Ref":"ALFI393503","TotalPrice":"2309452","TravelDate":"2024-08-31"
        //        }
        //     ]}
        // }}
        return reply;
      })
      : [this.callTourplan(listBookingPayload)];
    const replyObjs = await Promise.all(allSearches);
    const bookingHeaders = R.flatten(replyObjs.map(o => R.pathOr([], ['ListBookingsReply', 'BookingHeaders', 'BookingHeader'], o)));
    const bookings = await Promise.map(bookingHeaders, async bookingHeader => {
      try {
        const getBookingPayload = getPayload('GetBookingRequest', {
          BookingId: R.prop('BookingId', bookingHeader),
          ReturnAccountInfo: 'Y',
          ReturnRoomConfigs: 'Y',
        });
        const bookingReply = await this.callTourplan(getBookingPayload);
        const booking = R.path(['GetBookingReply'], bookingReply);
        const newBooking = await translateItineraryBooking({
          rootValue: booking,
          typeDefs: itineraryBookingTypeDefs,
          query: itineraryBookingQuery,
        });
        return newBooking;
      } catch (err) {
        console.error('error in searchBooking', err.message);
        return null;
      }
    }, { concurrency: 10 });
    return {
      bookings: bookings.filter(b => b),
    };
  }
}

module.exports = BuyerPlugin;
