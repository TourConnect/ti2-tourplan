// const axios = require('axios');
const R = require('ramda');
const assert = require('assert');
const moment = require('moment');
const js2xmlparser = require('js2xmlparser');
const xml2js = require('xml2js');
const axios = require('axios');

const Normalizer = require('./normalizer');

const xmlParser = new xml2js.Parser();

const xmlOptions = {
  prettyPrinting: {
    enabled: false,
  },
  dtd: {
    include: true,
    name: 'tourConnect_4_00_000.dtd',
  },
};

const getHeaders = ({ length }) => ({
  Accept: 'application/xml',
  'Content-Type': 'application/xml; charset=utf-8',
  'Content-Length': length,
});

class Plugin {
  constructor(params) { // we get the env variables from here
    Object.entries(params).forEach(([attr, value]) => {
      this[attr] = value;
    });
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
      productId,
      supplierId,
    },
  }) {
    assert(endpoint);
    assert(startDate);
    assert(endDate);
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
    const reply = R.path(['data'], await axios({
      metod: 'post',
      url: endpoint,
      data,
      headers: getHeaders({ length: data.length }),
    }));
    const returnObj = await xmlParser.parseStringPromise(reply);
    let allotment = R.path(
      ['Reply', 'GetInventoryReply', 0, 'Allocation'],
      returnObj,
    );
    // remove empty instances
    allotment = allotment.filter(currentAllotment => Array.isArray(currentAllotment.Split));
    allotment = allotment.map(currentAllotment => {
      const appliesTo = R.path(['AllocationAppliesTo', 0, 'AllocationType', 0], currentAllotment);
      const bySplitCode = {};
      currentAllotment.Split.forEach(currentSplit => {
        const currentSplitName = R.path(['Split_Code', 0], currentSplit);
        const byUnitType = {};
        R.path(['UnitTypeInventory'], currentSplit).forEach(currentUnitType => {
          const currentUnitTypeName = R.path(['Unit_Type', 0], currentUnitType);
          const inventoryByDay = {};
          R.path(['PerDayInventory'], currentUnitType).forEach(dayInventory => {
            const dayName = R.path(['Date', 0], dayInventory);
            inventoryByDay[dayName] = {
              release: dayInventory.Release_Period[0],
              max: dayInventory.Max_Qty[0],
              booked: dayInventory.Bkd_Qty[0],
              request: dayInventory.Request_OK[0] === 'Y',
            };
          });
          byUnitType[currentUnitTypeName] = {
            ...(byUnitType[currentUnitTypeName] || {}),
            ...inventoryByDay,
          };
        });
        bySplitCode[currentSplitName] = {
          ...(bySplitCode[currentSplitName] || {}),
          byUnitType,
        };
      });
      return {
        supplierId: R.path(['SupplierCode', 0], currentAllotment),
        name: R.path(['AllocationName', 0], currentAllotment),
        description: R.path(['AllocationDescription', 0], currentAllotment),
        appliesTo: {
          S: 'Supplier',
          P: 'Product',
        }[appliesTo] || appliesTo,
        bySplitCode,
      };
    });
    return { allotment };
  }
}

module.exports = Plugin;
