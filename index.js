const axiosRaw = require('axios');
// const Promise = require('bluebird');
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
  'Content-Length': `${length}`,
});
const wildcardMatch = (wildcard, str) => {
  const w = wildcard.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // regexp escape
  const re = new RegExp(`^${w.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(str); // remove last 'i' above to have case sensitive
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
      if (this.xmlProxyUrl) {
        // use pyfilematch xmlproxy
        try {
          replyObj = R.path(['data'], await axios({
            method: 'post',
            url: `${this.xmlProxyUrl}/xmlproxy`,
            data: {
              url: endpoint,
              data,
              headers: getHeaders({ length: `${data.length}` }),
            },
          }));
        } catch (err) {
          console.log('error in calling pyfilematch xmlproxy', err);
          errorStr = `error in calling pyfilematch xmlproxy: ${err}`;
        }
      }
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
      const optionCodes = R.path(['AllocationAppliesTo', 0, 'OptionCode'], currentAllotment);
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
    },
    payload: { optionId, productName },
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
        forceRefresh: false,
      });
    let products = [];
    if (replyObj === 'useFixture') {
      products = require('./__fixtures__/fullacoptionlist.json');
    } else {
      products = R.call(R.compose(
        R.map(optionsGroupedBySupplierId => {
          const supplierData = {
            supplierId: R.path([0, 'OptGeneral', 'SupplierId'], optionsGroupedBySupplierId),
            supplierName: R.path([0, 'OptGeneral', 'SupplierName'], optionsGroupedBySupplierId),
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
        productName ? R.filter(o => {
          const str = `${
            R.path(['OptGeneral', 'Description'], o)
          } ${
            R.path(['Opt'], o)
          } ${
            R.path(['OptGeneral', 'SupplierId'], o)
          } ${
            R.path(['OptGeneral', 'SupplierName'], o)
          }`;
          return wildcardMatch(productName, str);
        }) : R.identity,
        root => {
          const options = R.pathOr([], ['OptionInfoReply', 'Option'], root);
          // due to the new parser, single option will be returned as an object
          // instead of an array
          if (Array.isArray(options)) return options;
          return [options];
        },
      ), replyObj);
    }
    const productFields = [{
      id: 'productId',
      title: 'Supplier',
      type: 'extended-option',
      requiredForAvailability: true,
      requiredForBooking: true,
      options: products.map(p => ({
        value: p.productId,
        label: p.productName,
      })),
    }, {
      id: 'optionId',
      title: 'Service',
      type: 'extended-option',
      requiredForAvailability: true,
      requiredForBooking: true,
      filterableBy: 'productId',
      options: R.chain(p => p.options.map(o => ({
        label: o.optionName,
        value: o.optionId,
        productId: p.productId,
        productName: p.productName,
      })), products),
    }, {
      id: 'startDate',
      title: 'Date',
      type: 'date',
      requiredForAvailability: true,
      requiredForBooking: true,
    }, {
      id: 'paxConfigs',
      title: 'Pax',
      type: 'list_of_fields',
      requiredForAvailability: true,
      requiredForBooking: true,
      fields: [{
        id: 'adults',
        title: 'Adults',
        type: 'count',
      }, {
        id: 'children',
        title: 'Children',
        type: 'count',
      }, {
        id: 'infants',
        title: 'Infants',
        type: 'count',
      }, {
        id: 'roomType',
        title: 'Room Type',
        type: 'extended-option',
        options: [{ value: 'SG', label: 'Single' }, { value: 'DB', label: 'Double' }, { value: 'TW', label: 'Twin' }, { value: 'QD', label: 'Quad' }],
      }],
      requiredForCalendar: true,
    }, {
      id: 'chargeUnitQuanity', // secondary charge unit (SCU) quantity
      description: 'number of nights or days or hours depending on charge unit',
      title: 'Nights/Days',
      type: 'count',
    }];
    return {
      products,
      productFields,
    };
  }

  async getProductPackages() {
    return [
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8fea-0242ac120002',
        packageName: "Afternoon at St Paul's Cathedral and Kensington Palace (half day)",
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8feb-0242ac120002',
        packageName: 'Beefeater Day Out',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8fec-0242ac120002',
        packageName: 'Brighton and Hove tour',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8fed-0242ac120002',
        packageName: 'Buckingham Palace & Kensington Palace (full day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8fee-0242ac120002',
        packageName: 'Buckingham Palace and Hampton Court Palace (full day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8fef-0242ac120002',
        packageName: 'Buckingham Palace and Windsor Castle (full day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ff0-0242ac120002',
        packageName: 'Canterbury & Dover day trip',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ff1-0242ac120002',
        packageName: 'Canterbury day trip',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ff2-0242ac120002',
        packageName: 'Churchill War Rooms and the Imperial War Museum',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ff3-0242ac120002',
        packageName: 'Churchill War Rooms, the Changing of the Guards & the Tower of London',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ff4-0242ac120002',
        packageName: "City walking tour, St Paul's Cathedral and theatre performance at the Globe",
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ff5-0242ac120002',
        packageName: 'Downton Abbey day trip',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ff6-0242ac120002',
        packageName: "Guided tour of St Paul's Cathedral",
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ff7-0242ac120002',
        packageName: 'Hampton Court Palace (half day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ff8-0242ac120002',
        packageName: 'Hampton Court Palace and Windsor Castle (full day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ff9-0242ac120002',
        packageName: 'Kensington Palace and the Tower of London (full day)',
        items: [
          {
            itemId: 'LONGUACLUXELONFDG',
            itemType: 'option',
          },
          {
            itemId: 'LONEFKENPALFIKENI',
            itemType: 'option',
          },
          {
            itemId: 'LONEFTOWLONFITOWL',
            itemType: 'option',
          },
        ],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ffa-0242ac120002',
        packageName: 'Kensington Palace and Westminster Abbey (half day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ffb-0242ac120002',
        packageName: "Late afternoon visit to St Paul's Cathedral",
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ffc-0242ac120002',
        packageName: "St Paul's Cathedral & Kensington Palace (half day)",
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ffd-0242ac120002',
        packageName: "St Paul's Cathedral and the Churchill War Rooms (half day)",
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8ffe-0242ac120002',
        packageName: "St Paul's Cathedral and Westminster Abbey (half day)",
        items: [
          {
            itemId: 'LONGUACLUXELONHDG',
            itemType: 'option',
          },
          {
            itemId: 'LONEFSTPCATFITSPC',
            itemType: 'option',
          },
          {
            itemId: 'LONSSGOLTOUGTWAP',
            itemType: 'option',
          },
        ],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-8fff-0242ac120002',
        packageName: "St Paul's Cathedral, Changing of the Guard and Tower of London (full day)",
        items: [
          {
            itemId: 'LONGUACLUXELONFDG',
            itemType: 'option',
          },
          {
            itemId: 'LONEFTOWLONFITOWL',
            itemType: 'option',
          },
          {
            itemId: 'LONEFGOLTOUGT105N',
            itemType: 'option',
          },
        ],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-9000-0242ac120002',
        packageName: "St Paul's Cathedral, Kensington Palace and Westminster Abbey (full day)",
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-9001-0242ac120002',
        packageName: 'St Pauls and Tower of London',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-9002-0242ac120002',
        packageName: 'Stonehenge (Full Day from London)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-9003-0242ac120002',
        packageName: 'Stonehenge, Lacock and Avebury (full day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-9004-0242ac120002',
        packageName: 'The White Cliffs of Dover, Dover Castle, & military tunnels (full day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-9005-0242ac120002',
        packageName: 'Tower of London by boat',
        items: [
          {
            itemId: 'LONGUACLUXELONHDG',
            itemType: 'option',
          },
          {
            itemId: 'LONSSTHACLISINLON',
            itemType: 'option',
          },
          {
            itemId: 'LONEFTOWLONFITOWL',
            itemType: 'option',
          },
        ],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-9006-0242ac120002',
        packageName: 'Warner Bros.- The Making of Harry Potter (non refundable)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-9007-0242ac120002',
        packageName: 'Westminster Abbey and Buckingham Palace (half day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-9008-0242ac120002',
        packageName: 'Westminster Abbey and Changing of the Guard',
        items: [
          {
            itemId: 'LONGUACLUXELONHDG',
            itemType: 'option',
          },
          {
            itemId: 'LONEFWESABBWESABB',
            itemType: 'option',
          },
        ],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-9009-0242ac120002',
        packageName: 'Westminster Abbey and the Tower by boat (full day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-900a-0242ac120002',
        packageName: 'Westminster Abbey, Changing of the Guard & Kensington Palace (full day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-900b-0242ac120002',
        packageName: 'Westminster Abbey, Changing of the Guard and Buckingham Palace',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-900c-0242ac120002',
        packageName: 'Westminster and the Tower of London (half day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-900d-0242ac120002',
        packageName: 'Westminster, Changing of the Guard and the Tower of London (full day)',
        items: [],
      },
      {
        packageId: 'a1b2c3d4-e8e8-11ec-900e-0242ac120002',
        packageName: 'Windsor Castle (half day)',
        items: [],
      },
    ];
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
      AddServiceRequest: {
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
        ...(quoteId ? {
          ExistingBookingInfo: { BookingId: quoteId },
        } : {
          NewBookingInfo: { Name: quoteName, QB: 'Q' },
        }),
        Opt: optionId,
        DateFrom: startDate,
        RateId: 'Default',
        SCUqty: chargeUnitQuanity || 1,
        AgentRef: reference,
        RoomConfigs: paxConfigs.map(obj => {
          const RoomConfig = {
            Adults: obj.adults || 0,
            Children: obj.children || 0,
            Infants: obj.infants || 0,
          };
          const RoomType = ({
            Single: 'SG',
            Double: 'DB',
            Twin: 'TW',
            Triple: 'TR',
            Quad: 'QU',
          })[obj.roomType];
          if (RoomType) RoomConfig.RoomType = RoomType;
          return { RoomConfig };
        }),
      },
    };
    const replyObj = await this.callTourplan({
      model,
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    });
    console.log('replyObj', replyObj);
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
}

module.exports = Plugin;
