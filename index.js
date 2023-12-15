// const axios = require('axios');
const Promise = require('bluebird');
const R = require('ramda');
const assert = require('assert');
const moment = require('moment');
const js2xmlparser = require('js2xmlparser');
const xml2js = require('xml2js');
const { translateTPOption } = require('./resolvers/product');

const Normalizer = require('./normalizer');

const xmlParser = new xml2js.Parser();

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
      const reply = R.path(['data'], await axios({
        method: 'post',
        url: endpoint,
        data,
        headers: getHeaders({ length: data.length }),
      }));
      const replyObj = await xmlParser.parseStringPromise(reply);
      return R.path(['Reply'], replyObj);
    };
  }

  async validateToken({
    token: {
      endpoint,
      username,
      password,
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
    },
    axios,
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
        assert(R.path(['AgentInfoReply', 0, 'Currency'], replyObj));
        return true;
      }
      const model = {
        AuthenticationRequest: {
          Login: username,
          Password: password,
        },
      };
      const replyObj = await this.callTourplan({ model, endpoint, axios, xmlOptions: defaultXmlOptions });
      assert(R.path(['AuthenticationReply', 0], replyObj) === '');
      return true;
    } catch (err) {
      return false;
    }
  }

  async queryAllotment({
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
      js2xmlparser.parse('Request', model, xmlOptions),
    );
    data = data.replace(xmlOptions.dtd.name, `Request SYSTEM "${xmlOptions.dtd.name}"`);
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
    payload: { optionId },
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
        ttl: 60 * 60 * 12, // 12 hours
        forceRefresh: false,
      });
    const productFields = [{
      id: 'productId',
      title: 'Supplier',
      type: 'extended-option',
    }, {
      id: 'optionId',
      title: 'Service',
      type: 'extended-option',
    }, {
      id: 'startDate',
      title: 'Date',
      type: 'date',
    }, {
      id: 'paxConfigs',
      title: 'Pax',
      type: 'list_of_fields',
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
      requiredForAvailability: true,
      requiredForCalendar: true,
      requiredForBooking: true,
    }, {
      id: 'chargeUnitQuanity', // secondary charge unit (SCU) quantity
      description: 'number of nights or days or hours depending on charge unit',
      title: 'Charge Unit Quantity',
      type: 'count',
    }];
    const products = R.call(R.compose(
      R.map(optionsGroupedBySupplierId => {
        const supplierData = {
          supplierId: R.path([0, 'OptGeneral', 0, 'SupplierId', 0], optionsGroupedBySupplierId),
          supplierName: R.path([0, 'OptGeneral', 0, 'SupplierName', 0], optionsGroupedBySupplierId),
        };
        return translateTPOption({
          supplierData,
          optionsGroupedBySupplierId,
          typeDefs: productTypeDefs,
          query: productQuery,
        });
      }),
      R.values,
      R.groupBy(R.path(['OptGeneral', 0, 'SupplierId', 0])),
      R.pathOr([], ['OptionInfoReply', 0, 'Option']),
    ), replyObj);
    return {
      products,
      productFields,
    };
  }

  async getProductPackages() {
    return [{
      packageId: '123',
      packageName: 'Canterbury & Dover day trip',
      items: [{
        itemId: 'jfjkdjf',
        itemType: 'option',
      }, {
        itemId: 'eeeee',
        itemType: 'product',
      }],
    }];
  }
  
  async createQuote({
    axios,
    token: {
      hostConnectEndpoint,
      hostConnectAgentID,
      hostConnectAgentPassword,
    },
    payload: {
      holder,
      rebookingId,
      optionIds,
      startDate,
      dateFormat,
      reference,
      /*
      paxConfigs: [{ RoomType: 'DB', Adults: 2 }, { roomType: 'TW', Children: 2 }]
      */
      paxConfigs,
      /*
        The number of second charge units required (second charge units are discussed
        in the OptionInfo section). Should only be specified for options that have SCUs.
        Defaults to 1.
      */
      SCUqty,
    },
  }) {
    const DateFrom = moment(startDate, dateFormat).format('YYYY-MM-DD');
    const model = {
      AddService: {
        AgentID: hostConnectAgentID,
        Password: hostConnectAgentPassword,
        ...(rebookingId ? {
          ExistingBookingInfo: { BookingId: rebookingId },
        } : {
          NewBookingInfo: { Name: holder.name, QB: 'Q' },
        }),
        Opt: optionIds[0],
        DateFrom,
        SCUqty,
        AgentRef: reference,
        RoomConfigs: paxConfigs.map(obj => ({
          RoomConfig: {
            Adults: obj.adults,
            Children: obj.children,
            Infants: obj.infants,
            RoomType: obj.roomType,
          },
        })),
      },
    };
    const replyObj = await this.callTourplan({
      model,
      endpoint: hostConnectEndpoint,
      axios,
      xmlOptions: hostConnectXmlOptions,
    });
    return {
      bookingId: R.path(['AddServiceReply', 0, 'BookingId', 0], replyObj),
      reference: R.path(['AddServiceReply', 0, 'Ref', 0], replyObj),
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
