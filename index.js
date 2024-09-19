const axiosRaw = require('axios');
const Promise = require('bluebird');
const R = require('ramda');
const assert = require('assert');
const moment = require('moment');
const js2xmlparser = require('js2xmlparser');
const xml2js = require('xml2js');
const { XMLParser } = require('fast-xml-parser');
const { translateTPOption } = require('./resolvers/product');

const Normalizer = require('./normalizer');

const xmlParser = new xml2js.Parser();
const fastParser = new XMLParser();
const BAD_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007f-\u0084\u0086-\u009f\uD800-\uDFFF\uFDD0-\uFDFF\uFFFF\uC008\uFEFF]/g;

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

const convertProductFilters = (productFilters = []) => {
  /*
  productFilters: [
    {
      place: 'London',
      filters: ['ACLUXE'],
    },
    {
      place: 'Cambridge',
      filters: ['LONEFBLEPARFITENT', 'ACLUXE'],
    },
  ]
  result: {
    filters: ['ACLUXE', 'LONEFBLEPARFITENT'],
    filterPlaceMap: {
      ACLUXE: ['London','Cambridge'],
      LONEFBLEPARFITENT: ['Cambridge'],
    },
  }
  */
  const groupedByfilter = R.call(R.compose(
    R.groupBy(R.prop('filter')),
    R.flatten,
    R.map(obj => obj.filters.map(str => ({ filter: str, place: obj.place }))),
  ), productFilters);
  return {
    filters: R.keys(groupedByfilter),
    filterPlaceMap: R.map(arr => arr.map(o => o.place), groupedByfilter),
  };
};
class Plugin {
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
    this.cacheSettings = {
      bookingsProductSearch: {
        skipTTL: true,
      },
    };
    this.callTourplan = async ({
      model,
      endpoint,
      axios,
      xmlOptions,
    }) => {
      let data = Normalizer.stripEnclosingQuotes(
        js2xmlparser.parse('Request', model, xmlOptions),
      );
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
            console.log('error in calling pyfilematch xml2json', R.pathOr('Nada', ['response', 'data', 'error'], err));
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
      paxConfigs.map(({ roomType, passengers = [] }) => {
        const EachRoomConfig = passengers.reduce((acc, p) => {
          console.log(JSON.stringify(p));
          if (p.passengerType === 'Adult') {
            acc.Adults += 1;
          }
          if (p.passengerType === 'Child') {
            acc.Children += 1;
          }
          if (p.passengerType === 'Infant') {
            acc.Infants += 1;
          }
          return acc;
        }, {
          Adults: 0,
          Children: 0,
          Infants: 0,
        });
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
          // Inside PaxList, there should be 1 PaxDetails for each passenger (Pax)
          EachRoomConfig.PaxList.PaxDetails = [];
          passengers.forEach((p, indexEachPax) => {
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
            if (!R.isNil(p.age) && !isNaN(p.age)) {
              if (!(p.passengerType === 'Adult' && p.age === 0)) {
                EachPaxDetails.Age = p.age;
              }
            }
            EachRoomConfig.PaxList.PaxDetails[indexEachPax] = EachPaxDetails;
          });
        }
        RoomConfigs.RoomConfig[indexRoomConfig++] = EachRoomConfig
      });
      return RoomConfigs;
    };
    this.escapeInvalidXmlChars = str => {
      if (!str) return '';
      const convertAccentedChars = s => {
        return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      }
      return convertAccentedChars(str)
        .replace(/’/g, "'")
        .replace(/‘/g, "'")
        .replace(/“/g, '"')
        .replace(/”/g, '"')
        .replace(/–/g, '-')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(BAD_XML_CHARS, '')
    };

    // this.errorPathsAxiosErrors = () => ([ // axios triggered errors
    //   ['response', 'data', 'error'],
    // ]);
    // this.errorPathsAxiosAny = () => ([]); // 200's that should be errors
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
      console.log(replyObj)
      assert(R.path(['AuthenticationReply'], replyObj) === '');
      return true;
    } catch (err) {
      console.log(err)
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

  async searchProducts({
    axios,
    typeDefsAndQueries: {
      productTypeDefs,
      productQuery,
    },
    token: {
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
      configuration,
    },
    payload: { optionId, forceRefresh, searchInput },
  }) {
    const model = {
      OptionInfoRequest: {
        Opt: optionId || '?????????????????',
        Info: 'G',
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
      },
    };
    const payload = {
      model,
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    };
    // use cache if we are getting the full list
    // for example: for searchInput (backend search), we shouldn't get the full list from 
    // tourplan each time user search
    const replyObj = optionId
      ? await this.callTourplan(payload)
      : await this.cache.getOrExec({
        fnParams: [model],
        fn: () => this.callTourplan(payload),
        ttl: 60 * 60 * 2, // 2 hours
        forceRefresh: Boolean(forceRefresh),
      });
    const products = R.call(R.compose(
      R.map(optionsGroupedBySupplierId => {
        const OptGeneral = R.pathOr({}, [0, 'OptGeneral'], optionsGroupedBySupplierId);
        let supplierName = R.path(['SupplierName'], OptGeneral);
        if (R.path(['SupplierName'], OptGeneral).toLocaleLowerCase() === 'transfers') {
          supplierName = `${R.path(['VoucherName'], OptGeneral)} (${R.path(['SupplierName'], OptGeneral)})`;
        }
        const supplierData = {
          supplierId: R.path(['SupplierId'], OptGeneral),
          supplierName: supplierName,
          supplierAddress: `${R.pathOr('', ['Address1'], OptGeneral)}, ${R.pathOr('', ['Address2'], OptGeneral)},  ${R.pathOr('', ['Address3'], OptGeneral)}, ${R.pathOr('', ['Address4'], OptGeneral)}, ${R.pathOr('', ['Address5'], OptGeneral)}`,
          serviceTypes: R.uniq(optionsGroupedBySupplierId.map(R.path(['OptGeneral', 'ButtonName']))),
        };
        return translateTPOption({
          supplierData,
          optionsGroupedBySupplierId,
          typeDefs: productTypeDefs,
          query: productQuery,
        });
      }),
      R.values,
      R.groupBy(R.path(['OptGeneral', 'SupplierId'])),
      root => {
        if (!searchInput) return root;
        const getFullSearchStr = o => {
          const fullPptionName = `${R.path(['OptGeneral', 'Description'], o) || ''}-${R.path(['OptGeneral', 'Comment'], o) || ''}`;
          return `${R.path(['OptGeneral', 'SupplierName'], o) || ''} ${fullPptionName} ${R.path(['Opt'], o)} ${R.path(['OptGeneral', 'SupplierId'], o) || ''}`;
        };
        const inputValueLower = searchInput.trim().toLowerCase();
        const parts = inputValueLower.split(' ').filter(Boolean); // Filter out any empty strings just in case
        return root.filter(option => {
          const fullSearchStr = getFullSearchStr(option).toLowerCase();
          return parts.every(part => fullSearchStr.includes(part));
        });
      },
      root => {
        const options = R.pathOr([], ['OptionInfoReply', 'Option'], root);
        // due to the new parser, single option will be returned as an object
        // instead of an array
        if (Array.isArray(options)) return options;
        return [options];
      },
    ), replyObj);
    if (!(products && products.length)) {
      throw new Error('No products found');
    }
    return {
      products,
      productFields: [],
      ...(searchInput || optionId ? {} : configuration),
    };
  }


  async searchAvailability({
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
      chargeUnitQuanity,
    },
  }) {
    const model = {
      OptionInfoRequest: {
        Opt: optionId,
        Info: 'S',
        DateFrom: startDate,
        SCUqty: (() => {
          const num = parseInt(chargeUnitQuanity, 10);
          if (isNaN(num) || num < 1) return 1;
          return num;
        })(),
        RoomConfigs: this.getRoomConfigs(paxConfigs, true),
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
    const optionInfoReply = R.path(['OptionInfoReply'], replyObj);
    let OptStayResults = R.pathOr([], ['Option', 'OptStayResults'], optionInfoReply);
    if (!Array.isArray(OptStayResults)) OptStayResults = [OptStayResults];
    return {
      bookable: Boolean(optionInfoReply),
      rates: OptStayResults.map(rate => {
        let externalRateText = R.pathOr('', ['ExternalRateDetails', 'ExtOptionDescr'], rate);
        const extRatePlanDescr = R.pathOr('', ['ExternalRateDetails', 'ExtRatePlanDescr'], rate);
        if (extRatePlanDescr && !externalRateText.includes(extRatePlanDescr)) {
          externalRateText = `${externalRateText} (${extRatePlanDescr})`;
        }
        return {
          rateId: R.path(['RateId'], rate),
          externalRateText,
        };
      }),
    };
    // THE BELOW CODE is for A check, might still need it on user's future request
    // const optAvail = parseInt(R.pathOr('-4', ['OptionInfoReply', 'Option', 'OptAvail'], replyObj), 10);
    // /*
    // FROM TP DOCS:
    // Each integer in the list gives the availability for one of the days in the range requested,
    // from the start date through to the end date. The integer values are to be interpreted as
    // follows:
    // Greater than 0 means that inventory is available, with the integer specifying the
    // number of units available. For options with a service type of Y , the inventory is in
    // units of rooms. For other service types, the inventory is in units of pax.
    // -1 Not available.
    // -2 Available on free sell.
    // -3 Available on request.
    // Note: A return value of 0 or something less than -3 is impossible.
    // */
    // if (optAvail === -1) {
    //   return {
    //     available: false,
    //   };
    // }
    // if (optAvail === -2) {
    //   return {
    //     available: true,
    //     type: 'free sell',
    //   };
    // }
    // if (optAvail === -3) {
    //   return {
    //     available: true,
    //     type: 'on request',
    //   };
    // }
    // if (optAvail > 0) {
    //   return {
    //     available: true,
    //     type: 'inventory',
    //     quantity: optAvail,
    //   };
    // }
    // return {
    //   available: false,
    // };
  }

  async searchQuote({
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
      chargeUnitQuanity,
      extras,
      puInfo,
      doInfo,
      notes,
      directHeaderPayload,
      directLinePayload,
    },
  }) {
    const model = {
      AddServiceRequest: {
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
        ...(quoteId ? {
          ExistingBookingInfo: { BookingId: quoteId },
        } : {
          NewBookingInfo: {
            Name: this.escapeInvalidXmlChars(quoteName),
            QB: 'Q',
            ...(directHeaderPayload || {}),
          },
        }),
        ...(puInfo && (puInfo.time || puInfo.location || puInfo.flightDetails) ? {
          ...(puInfo.time && puInfo.time.replace(/\D/g, '') ? {
            puTime: puInfo.time.replace(/\D/g, ''),
          } : {}),
          puRemark: this.escapeInvalidXmlChars(`${puInfo.location ? `Location: ${puInfo.location || 'NA'},` : ''}
          ${puInfo.flightDetails ? `Flight: ${puInfo.flightDetails || 'NA'},` : ''}
          `),
        } : {}),
        ...(doInfo && (doInfo.time || doInfo.location || doInfo.flightDetails) ? {
          // only get numbers from doInfo.time
          ...(doInfo.time && doInfo.time.replace(/\D/g, '') ? {
            doTime: doInfo.time.replace(/\D/g, ''),
          } : {}),
          doRemark: this.escapeInvalidXmlChars(`${doInfo.location ? `Location: ${doInfo.location || 'NA'},` : ''}
          ${doInfo.flightDetails ? `Flight: ${doInfo.flightDetails || 'NA'},` : ''}
          `),
        } : {}),
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
          const num = parseInt(chargeUnitQuanity, 10);
          if (isNaN(num) || num < 1) return 1;
          return num;
        })(),
        AgentRef: reference,
        RoomConfigs: this.getRoomConfigs(paxConfigs),
        ...(directLinePayload || {}),
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
      quote: {
        id: R.path(['AddServiceReply', 'BookingId'], replyObj),
        reference: R.path(['AddServiceReply', 'Ref'], replyObj),
        linePrice: R.path(['AddServiceReply', 'Services', 'Service', 'LinePrice'], replyObj),
        lineId: R.path(['AddServiceReply', 'ServiceLineId'], replyObj),
      },
    };
  }

  // eslint-disable-next-line class-methods-use-this
  async getCreateBookingFields({
    // token: {
    //   hostConnectAgentID,
    //   hostConnectAgentPassword,
    //   hostConnectEndpoint,
    // },
    // axios,
  }) {
    const customFields = [];
    return {
      fields: [],
      customFields,
    };
  }

  async searchBooking({
    token: {
      hostConnectAgentID,
      hostConnectAgentPassword,
      hostConnectEndpoint,
    },
    axios,
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
          console.log('error in searchBooking', err);
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
      const getBookingPayload = getPayload('GetBookingRequest', {
        BookingId: R.prop('BookingId', bookingHeader),
        ReturnAccountInfo: 'Y',
      });
      const bookingReply = await this.callTourplan(getBookingPayload);
      const booking = R.path(['GetBookingReply'], bookingReply);
      const Services = R.pathOr([], ['Services', 'Service'], booking);
      return {
        ...booking,
        Services: Array.isArray(Services) ? Services : [Services],
      };
    }, { concurrency: 10 });
    return {
      bookings,
    };
  }
}

module.exports = Plugin;
