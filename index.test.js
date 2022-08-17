/* globals describe, it, expect */
const Plugin = require('./index');

const app = new Plugin();

describe('search tests', () => {
  const token = {
    endpoint: process.env.ti2_tourplan_endpoint,
    username: process.env.ti2_tourplan_username,
    password: process.env.ti2_tourplan_password,
  };
  const dateFormat = 'DD/MM/YYYY';
  describe('allotments', () => {
    it('read allotment empty', async () => {
      const retVal = await app.queryAllotment({
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
    });
  });
  it('read allotment not empty', async () => {
    const retVal = await app.queryAllotment({
      token,
      payload: {
        dateFormat,
        startDate: '02/09/2020',
        endDate: '02/10/2020',
        keyPath: 'MAGLUX|QLDACMAGLUXDELSUI',
      },
    });
    expect(Array.isArray(retVal.allotment)).toBeTruthy();
    expect(retVal).toMatchSnapshot();
  });
});
