/* globals describe, it, expect, jest */

const http = require('http');
const realAxios = require('axios');
const { XMLValidator } = require('fast-xml-parser');
const Plugin = require('./index');
const { escapeInvalidXmlChars, hostConnectXmlOptions } = require('./utils');

const okReply = '<?xml version="1.0"?><Reply><AddServiceReply><BookingId>1</BookingId></AddServiceReply></Reply>';

const makeAxios = (reply = okReply) => {
  const calls = [];
  const axios = jest.fn(async config => {
    calls.push(config);
    return { data: reply };
  });
  return { axios, calls };
};

const expectUtf8ContentLength = config => {
  expect(config.headers['Content-Length']).toBe(Buffer.byteLength(config.data, 'utf8'));
};

describe('Tourplan request Content-Length', () => {
  const endpoint = 'https://test.example.com';
  const xmlOptions = { prettyPrinting: { enabled: false }, dtd: { include: true, name: 'tourConnect_4_00_000.dtd' } };

  it.each([
    ['ASCII', 'Pickup 07:30 - meet driver in the lobby'],
    ['em dash', 'Pickup 07:30 — meet driver in the lobby'],
    ['accented letters', 'Café Zürich, señor'],
    ['euro sign', 'Deposit €50 paid'],
    ['arrow', 'Sydney → Cairns'],
    ['CJK', '日本のお客様'],
  ])('callTourplan declares the UTF-8 byte length for %s remarks', async (_label, notes) => {
    const app = new Plugin();
    const { axios, calls } = makeAxios();
    await app.callTourplan({
      endpoint,
      axios,
      xmlOptions,
      model: { AddServiceRequest: { Opt: 'SYDACSYDHOTSTD', Remarks: notes } },
    });
    const addService = calls.find(c => c.data.includes('AddServiceRequest'));
    const dtdDetection = calls.find(c => c.data.includes('AuthenticationRequest'));
    expectUtf8ContentLength(addService);
    // The DTD probe body is ASCII; this only checks it uses the same header helper.
    expectUtf8ContentLength(dtdDetection);
  });

  it('queryAllotment declares the UTF-8 byte length', async () => {
    const app = new Plugin();
    const { axios, calls } = makeAxios('<Reply><GetInventoryReply></GetInventoryReply></Reply>');
    await app.queryAllotment({
      axios,
      token: { endpoint, username: 'agent—ops', password: 'pw' },
      payload: { startDate: '01/08/2022', endDate: '15/08/2022', keyPath: 'MAGLUX|SYDACMAGLUXDELXRO' },
    });
    const inventory = calls.find(c => c.data.includes('GetInventoryRequest'));
    expect(Buffer.byteLength(inventory.data, 'utf8')).toBeGreaterThan(inventory.data.length);
    expectUtf8ContentLength(inventory);
  });

  // Node's HTTP parser, like Tourplan, reads exactly Content-Length bytes of the body.
  it('sends a complete HostConnect AddServiceRequest with an em dash over HTTP', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        res.setHeader('Content-Type', 'application/xml');
        res.end(okReply);
      });
    });
    await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
    try {
      await new Plugin().callTourplan({
        endpoint: `http://127.0.0.1:${server.address().port}/`,
        axios: realAxios,
        xmlOptions: hostConnectXmlOptions,
        model: { AddServiceRequest: { Opt: 'SYDACSYDHOTSTD', Remarks: escapeInvalidXmlChars('Pickup 07:30 \u2014 meet driver') } },
      });
    } finally {
      server.close();
    }
    expect(received).toHaveLength(1);
    expect(received[0].endsWith('</Request>')).toBe(true);
    expect(XMLValidator.validate(received[0])).toBe(true);
  });
});
