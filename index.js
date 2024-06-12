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
        const reply = R.path(['data'], await axios({
          method: 'post',
          url: endpoint,
          data,
          headers: getHeaders({ length: data.length }),
        }));
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
      const error = replyObj.error || R.path(['Reply', 'ErrorReply', 'Error'], replyObj);
      if (error) {
        if (error.indexOf('2050 SCN Request denied for TEST connecting from') > -1
          && requestType === 'OptionInfoRequest'
          && endpoint.indexOf('actour') > -1
        ) {
          return 'useFixture';
        }
        throw new Error(`${requestType} failed: ${error}`);
      }
      return R.path(['Reply'], replyObj);
    };

    this.getPaxConfigs = (paxConfigs, noPaxList) =>
      paxConfigs.map(({ roomType, passengers = [] }) => {
        const RoomConfig = passengers.reduce((acc, p) => {
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
          Quad: 'QU',
        })[roomType];
        if (RoomType) RoomConfig.RoomType = RoomType;
        if (passengers && passengers.length && !noPaxList) {
          RoomConfig.PaxList = passengers.map(p => {
            const PaxDetails = {
              Forename: p.firstName,
              Surname: p.lastName,
              PaxType: {
                Adult: 'A',
                Child: 'C',
                Infant: 'I',
              }[p.passengerType] || 'A',
              Title: p.salutation,
            };
            if (p.dob) PaxDetails.DateOfBirth = p.dob;
            if (!isNaN(p.age)) {
              if (!(p.passengerType === 'Adult' && p.age === 0)) {
                PaxDetails.Age = p.age;
              }
            }
            return {
              PaxDetails,
            };
          });
        }
        return { RoomConfig };
      });
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
    payload: { optionId, forceRefresh },
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
    const replyObj = optionId
      ? await this.callTourplan(payload)
      : await this.cache.getOrExec({
        fnParams: [model],
        fn: () => this.callTourplan(payload),
        ttl: 60 * 60 * 24, // 24 hours
        forceRefresh: Boolean(forceRefresh),
      });
    let products = [];
    if (replyObj === 'useFixture') {
      products = require('./__fixtures__/fullacoptionlist.json');
    } else {
      products = R.call(R.compose(
        R.map(optionsGroupedBySupplierId => {
          const OptGeneral = R.pathOr({}, [0, 'OptGeneral'], optionsGroupedBySupplierId);
          const supplierData = {
            supplierId: R.path(['SupplierId'], OptGeneral),
            supplierName: R.path(['SupplierName'], OptGeneral),
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
          const options = R.pathOr([], ['OptionInfoReply', 'Option'], root);
          // due to the new parser, single option will be returned as an object
          // instead of an array
          if (Array.isArray(options)) return options;
          return [options];
        },
      ), replyObj);
    }
    return {
      products,
      productFields: [],
      ...configuration,
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
        Info: 'A',
        DateFrom: startDate,
        DateTo: startDate,
        RoomConfigs: this.getPaxConfigs(paxConfigs, true),
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
    const optAvail = R.path(['OptionInfoReply', 'Option', 'OptAvail'], replyObj);
    /*
    FROM TP DOCS:
    Each integer in the list gives the availability for one of the days in the range requested,
    from the start date through to the end date. The integer values are to be interpreted as
    follows:
    Greater than 0 means that inventory is available, with the integer specifying the
    number of units available. For options with a service type of Y , the inventory is in
    units of rooms. For other service types, the inventory is in units of pax.
    -1 Not available.
    -2 Available on free sell.
    -3 Available on request.
    Note: A return value of 0 or something less than -3 is impossible.
    */
    if (optAvail === -1) {
      return {
        available: false,
      };
    }
    if (optAvail === -2) {
      return {
        available: true,
        type: 'free sell',
      };
    }
    if (optAvail === -3) {
      return {
        available: true,
        type: 'on request',
      };
    }
    if (optAvail > 0) {
      return {
        available: true,
        type: 'inventory',
        quantity: optAvail,
      };
    }
    return {
      available: false,
    };
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
    },
  }) {
    const model = {
      AddServiceRequest: {
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
        ...(quoteId ? {
          ExistingBookingInfo: { BookingId: quoteId },
        } : {
          NewBookingInfo: { Name: quoteName, QB: 'Q' },
        }),
        ...(rateId ? {
          RateId: rateId,
        } : {}),
        ...(puInfo ? {
          ...(puInfo.time && puInfo.time.replace(/\D/g, '') ? {
            puTime: puInfo.time.replace(/\D/g, ''),
          } : {}),
          puRemark: `Time: ${puInfo.time || 'NA'},
          Location: ${puInfo.location || 'NA'},
          Flight: ${puInfo.flightDetails || 'NA'},
          `,
        } : {}),
        ...(doInfo ? {
          // only get numbers from doInfo.time
          ...(doInfo.time && doInfo.time.replace(/\D/g, '') ? {
            doTime: doInfo.time.replace(/\D/g, ''),
          } : {}),
          doRemark: `Time: ${doInfo.time || 'NA'},
          Location: ${doInfo.location || 'NA'},
          Flight: ${doInfo.flightDetails || 'NA'},
          `,
        } : {}),
        ...(extras && extras.length ? {
          Remarks: extras.map((e, i) => `Extra ${i + 1}: ${e.name} x ${e.quantity}`).join(`\n`),
        } : {}),
        Opt: optionId,
        DateFrom: startDate,
        RateId: 'Default',
        SCUqty: chargeUnitQuanity || 1,
        AgentRef: reference,
        RoomConfigs: this.getRoomConfigs(paxConfigs),
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
        === 'NO' ? 'Service cannot be added to quote' : '',
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
    const allSearches = bookingId
      ? ['BookingId', 'Ref', 'AgentRef'].map(async key => {
        let reply;
        try {
          reply = await this.callTourplan(getPayload('ListBookingsRequest', { [key]: bookingId }));
        } catch (err) {
          if (err.message.indexOf('not found') > -1) {
            reply = { ListBookingsReply: { BookingHeaders: { BookingHeader: [] } } };
          } else {
            throw err;
          }
        }
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
