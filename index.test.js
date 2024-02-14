/* globals describe, it, expect, jest, afterEach */
const { readFile } = require('fs').promises;
const axios = require('axios');
const path = require('path');
const xml2js = require('xml2js');
const R = require('ramda');

const xmlParser = new xml2js.Parser();
const hash = require('object-hash');

const Plugin = require('./index');

jest.mock('axios');
const actualAxios = jest.requireActual('axios');

const getFixture = async requestObject => {
  console.log(requestObject);
  const requestHash = hash(requestObject);
  const file = path.resolve(__dirname, `./__fixtures__/${requestHash}.txt`);
  try {
    const fixture = (
      await readFile(file)
    ).toString();
    return { data: fixture };
  } catch (err) {
    console.warn(`could not find ${file}`);
    return actualAxios(requestObject);
  }
};

const app = new Plugin();

describe('search tests', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });
  const token = {
    endpoint: process.env.ti2_tourplan_endpoint,
    username: process.env.ti2_tourplan_username,
    password: process.env.ti2_tourplan_password,
  };
  const dateFormat = 'DD/MM/YYYY';
  describe('tooling', () => {
    describe('validateToken', () => {
      it('valid token', async () => {
        axios.mockImplementation(getFixture);
        const retVal = await app.validateToken({
          axios,
          token,
        });
        expect(retVal).toBeTruthy();
      });
      it('invalid token', async () => {
        axios.mockImplementation(getFixture);
        const retVal = await app.validateToken({
          axios,
          token: { ...token, username: 'somerandom' },
        });
        expect(retVal).toBeFalsy();
      });
    });
    describe('template tests', () => {
      let template;
      it('get the template', async () => {
        template = await app.tokenTemplate();
        const rules = Object.keys(template);
        expect(rules).toContain('endpoint');
        expect(rules).toContain('password');
        expect(rules).toContain('username');
      });
      it('username', () => {
        const username = template.username.regExp;
        expect(username.test('')).toBeFalsy();
        expect(username.test('someuser')).toBeTruthy();
      });
      it('endpoint', () => {
        const endpoint = template.endpoint.regExp;
        expect(endpoint.test('something')).toBeFalsy();
        expect(endpoint.test('https://www.google.com')).toBeTruthy();
      });
      it('password', () => {
        const password = template.password.regExp;
        expect(password.test('')).toBeFalsy();
        expect(password.test('somepassword')).toBeTruthy();
      });
    });
  });
  it('read allotment empty', async () => {
    const request = axios.mockImplementation(getFixture);
    const retVal = await app.queryAllotment({
      axios,
      token,
      payload: {
        dateFormat,
        startDate: '01/08/2022',
        endDate: '15/08/2022',
        keyPath: 'MAGLUX|SYDACMAGLUXDELXRO',
      },
    });
    expect(Array.isArray(retVal.allotment)).toBeTruthy();
    expect(retVal.allotment.length).toBe(0);
    let sentPayload = await xmlParser.parseStringPromise(
      request.mock.calls[0][0].data,
    );
    sentPayload = R.path(['Request', 'GetInventoryRequest'], sentPayload);
    expect(sentPayload.SupplierCode[0]).toBe('MAGLUX');
    expect(sentPayload.OptionCode[0]).toBe('SYDACMAGLUXDELXRO');
    expect(sentPayload.Date_From[0]).toBe('2022-08-01');
    expect(sentPayload.Date_To[0]).toBe('2022-08-15');
  });
  it('read allotment not empty', async () => {
    const request = axios.mockImplementation(getFixture);
    const retVal = await app.queryAllotment({
      axios,
      token,
      payload: {
        dateFormat,
        startDate: '02/09/2021',
        endDate: '02/10/2021',
        keyPath: 'MAGLUX|QLDACMAGLUXDELSUI',
      },
    });
    expect(Array.isArray(retVal.allotment)).toBeTruthy();
    expect(retVal.allotment).toContainEqual({
      name: 'FREESALE',
      description: '',
      appliesTo: 'Product',
      splitCode: 'GENERAL',
      unitType: 'RM',
      date: '08/09/2021',
      release: '14',
      max: '3',
      booked: '0',
      request: true,
      keyPaths: ['MAGLUX|QLDACMAGLUXDELSUI'],
    });
    expect(retVal).toMatchSnapshot();
    let sentPayload = await xmlParser.parseStringPromise(
      request.mock.calls[0][0].data,
    );
    sentPayload = R.path(['Request', 'GetInventoryRequest'], sentPayload);
    expect(sentPayload.SupplierCode[0]).toBe('MAGLUX');
    expect(sentPayload.OptionCode[0]).toBe('QLDACMAGLUXDELSUI');
    expect(sentPayload.Date_From[0]).toBe('2021-09-02');
    expect(sentPayload.Date_To[0]).toBe('2021-10-02');
  });
  it('read allotment that applies to more products', async () => {
    const request = axios.mockImplementation(getFixture);
    const retVal = await app.queryAllotment({
      axios,
      token,
      payload: {
        dateFormat,
        startDate: '16/05/2022',
        endDate: '15/06/2022',
        keyPath: 'XXYYIN|SINACXXYYIN2SDXBF',
      },
    });
    expect(Array.isArray(retVal.allotment)).toBeTruthy();
    // there is no booked when multiple keyPaths are returned
    expect(retVal.allotment).toContainEqual({
      name: 'DLX_XXXXX',
      description: 'Deluxe Room',
      appliesTo: 'Product',
      splitCode: 'ALLAGENT',
      unitType: 'RO',
      date: '15/06/2022',
      release: '7',
      max: '0',
      request: false,
      keyPaths: ['XXYYIN|SINACXXYYINDLXFBF', 'XXYYIN|SINACXXYYIN2SDXBF'],
    });
    expect(retVal).toMatchSnapshot();
    let sentPayload = await xmlParser.parseStringPromise(
      request.mock.calls[0][0].data,
    );
    sentPayload = R.path(['Request', 'GetInventoryRequest'], sentPayload);
    expect(sentPayload.SupplierCode[0]).toBe('XXYYIN');
    expect(sentPayload.OptionCode[0]).toBe('SINACXXYYIN2SDXBF');
    expect(sentPayload.Date_From[0]).toBe('2022-05-16');
    expect(sentPayload.Date_To[0]).toBe('2022-06-15');
  });
});
