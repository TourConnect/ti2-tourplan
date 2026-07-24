const { translateTPOption } = require('./product');

const productTypeDefs = `
  type Query {
    productId: String
    productName: String
    address: String
    serviceTypes: [String]
    options: [ProductOption]
  }

  type ProductOption {
    optionId: String
    optionName: String
    comment: String
    lastUpdateTimestamp: Float
    serviceType: String
    city: String
    country: String
    currency: String
    units: [Unit]
    restrictions: Restrictions
    extras: [Extra]
  }

  type Unit {
    unitId: String
    unitName: String
    restrictions: UnitRestrictions
  }

  type UnitRestrictions {
    minAge: Int
    maxAge: Int
    allowed: Boolean
    maxPax: Int
    maxAdults: Int
  }

  type Restrictions {
    roomTypeRequired: Boolean
    Adult: PaxRestrictions
    Child: PaxRestrictions
    Infant: PaxRestrictions
    Single: RoomRestrictions
    Twin: RoomRestrictions
    Triple: RoomRestrictions
    Double: RoomRestrictions
    Quad: RoomRestrictions
  }

  type PaxRestrictions {
    allowed: Boolean
    minAge: Int
    maxAge: Int
  }

  type RoomRestrictions {
    allowed: Boolean
    maxPax: Int
    maxAdults: Int
  }

  type Extra {
    id: String
    name: String
    chargeBasis: String
    isCompulsory: Boolean
    isPricePerPerson: Boolean
  }
`;

const productQuery = `{
  productId
  productName
  options {
    optionId
    optionName
    serviceType
    city
    country
    currency
  }
}`;

describe('product resolver enriched context', () => {
  it('remains compatible with caller schemas that do not define enriched fields', async () => {
    const legacyTypeDefs = `
      type Query { productId: String productName: String options: [ProductOption] }
      type ProductOption { optionId: String optionName: String serviceType: String }
    `;
    const legacyQuery = `{ productId productName options { optionId optionName serviceType } }`;

    const retVal = await translateTPOption({
      typeDefs: legacyTypeDefs,
      query: legacyQuery,
      rootValue: {
        optionsGroupedBySupplierId: [{
          Opt: 'DAVLONWATER',
          OptGeneral: {
            SupplierId: 'DAVIDS',
            SupplierName: 'Davids of London Ltd',
            Description: 'Private transfer',
            ButtonName: 'Transfers',
          },
        }],
      },
    });

    expect(retVal.options[0]).toMatchObject({
      optionId: 'DAVLONWATER',
      optionName: 'Private transfer',
      serviceType: 'Transfers',
    });
  });

  it('exposes location and currency for product matching', async () => {
    const retVal = await translateTPOption({
      typeDefs: productTypeDefs,
      query: productQuery,
      agentCurrencyCode: 'GBP',
      rootValue: {
        optionsGroupedBySupplierId: [{
          Opt: 'LONTRDAVIDSWATER',
          __destination: {
            locationCode: 'LON',
            city: 'London',
            name: 'London',
            country: 'United Kingdom',
          },
          OptGeneral: {
            SupplierId: 'DAVIDS',
            SupplierName: 'Davids of London Ltd',
            Description: 'Private transfer',
            ButtonName: 'Transfers',
            Locality: 'LON',
            LocalityDescription: 'London',
            Address3: 'Supplier Office City',
          },
          OptRates: {
            Currency: 'GBP',
            SaleFrom: '2026-01-01',
            SaleTo: '2026-12-31',
            OptRate: {
              PersonRates: {
                AdultRate: '10000',
                ChildRate: '5000',
              },
            },
          },
        }],
      },
    });

    expect(retVal.options[0]).toMatchObject({
      city: 'London',
      country: 'United Kingdom',
      currency: 'GBP',
    });
    expect(retVal.options[0].rateContext).toBeUndefined();
  });

  it('uses GetLocations city and GetSystemSettings country from enrichment', async () => {
    const retVal = await translateTPOption({
      typeDefs: productTypeDefs,
      query: productQuery,
      rootValue: {
        optionsGroupedBySupplierId: [{
          Opt: 'CPTHOHOTELSBCLSC',
          __destination: {
            locationCode: 'CPT',
            city: 'Cape Town',
            name: 'Cape Town',
            country: 'South Africa',
          },
          OptGeneral: {
            SupplierId: 'HOTELS',
            SupplierName: 'Hotel Supplier HQ',
            Description: 'Superior Room',
            ButtonName: 'Accommodation',
            Locality: 'CPT',
            LocalityDescription: 'Cape Town',
            Address3: 'Johannesburg',
            Address4: 'Gauteng',
          },
        }],
      },
    });

    expect(retVal.options[0]).toMatchObject({
      city: 'Cape Town',
      country: 'South Africa',
    });
  });

  it('omits country when GetSystemSettings has no usable CountryName (e.g. PDNZ Undefined)', async () => {
    const retVal = await translateTPOption({
      typeDefs: productTypeDefs,
      query: productQuery,
      rootValue: {
        optionsGroupedBySupplierId: [{
          Opt: 'AKLACHOTELSBCLSC',
          __destination: {
            locationCode: 'AKL',
            city: 'Auckland',
            name: 'Auckland',
          },
          OptGeneral: {
            SupplierId: 'HOTELS',
            SupplierName: 'NZ Hotel',
            Description: 'Standard Room',
            ButtonName: 'Accommodation',
            LocalityDescription: 'Auckland',
          },
        }],
      },
    });

    expect(retVal.options[0].city).toBe('Auckland');
    expect(retVal.options[0].country).toBeNull();
  });

  it('falls back to Address3 for city', async () => {
    const retVal = await translateTPOption({
      typeDefs: productTypeDefs,
      query: productQuery,
      rootValue: {
        optionsGroupedBySupplierId: [{
          Opt: 'DAVLONWATER',
          OptGeneral: {
            SupplierId: 'DAVIDS',
            SupplierName: 'Davids of London Ltd',
            Description: 'Private transfer',
            ButtonName: 'Transfers',
            Address3: 'London',
            Address4: 'Greater London',
            Address5: 'Ignored',
          },
          OptRates: {
            Currency: 'GBP',
            SequenceNumber: 1,
            RateCount: 99,
            OptRate: {
              PersonRates: {
                AdultRate: '10000',
              },
            },
          },
        }],
      },
    });

    expect(retVal.options[0].city).toBe('London');
    expect(retVal.options[0].currency).toBe('GBP');
  });

  it('uses the TourPlan agent currency when catalog options do not include rate currency', async () => {
    const retVal = await translateTPOption({
      typeDefs: productTypeDefs,
      query: productQuery,
      agentCurrencyCode: 'GBP',
      rootValue: {
        optionsGroupedBySupplierId: [{
          Opt: 'LONSSGOLTOUGTBPRM',
          OptGeneral: {
            SupplierId: '4235',
            SupplierName: 'Golden Tours',
            Description: 'Royal Mews & Buckingham Palace Tickets',
            ButtonName: 'Sightseeing',
            Address3: 'London',
          },
        }],
      },
    });

    expect(retVal.options[0]).toMatchObject({
      optionId: 'LONSSGOLTOUGTBPRM',
      currency: 'GBP',
    });
    expect(retVal.options[0].rateContext).toBeUndefined();
  });
});
