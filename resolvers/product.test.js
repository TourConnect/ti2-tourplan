/* globals describe, it, expect */
const { translateTPOption } = require('./product');

const productTypeDefs = `
  type Query {
    productId: String
    productName: String
    address: String
    description: String
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
    optionClass: String
    chargeUnit: String
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
    maxPaxWithInfants: Int
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
    Other: RoomRestrictions
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
    maxPaxWithInfants: Int
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
    const legacyQuery = '{ productId productName options { optionId optionName serviceType } }';

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

  it('omits country when GetSystemSettings has no usable CountryName', async () => {
    const retVal = await translateTPOption({
      typeDefs: productTypeDefs,
      query: productQuery,
      rootValue: {
        optionsGroupedBySupplierId: [{
          Opt: 'EXYACHOTELSBCLSC',
          __destination: {
            locationCode: 'EXY',
            city: 'Example City',
            name: 'Example City',
          },
          OptGeneral: {
            SupplierId: 'HOTELS',
            SupplierName: 'Example Hotel',
            Description: 'Standard Room',
            ButtonName: 'Accommodation',
            LocalityDescription: 'Example City',
          },
        }],
      },
    });

    expect(retVal.options[0].city).toBe('Example City');
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
          Opt: 'LONSSEXAMPLEGTBPRM',
          OptGeneral: {
            SupplierId: 'EXAMPLE',
            SupplierName: 'Example Tours',
            Description: 'Example Sightseeing Ticket',
            ButtonName: 'Sightseeing',
            Address3: 'London',
          },
        }],
      },
    });

    expect(retVal.options[0]).toMatchObject({
      optionId: 'LONSSEXAMPLEGTBPRM',
      currency: 'GBP',
    });
    expect(retVal.options[0].rateContext).toBeUndefined();
  });

  it('exposes the supplier note, Other room, and infant cap', async () => {
    const retVal = await translateTPOption({
      typeDefs: productTypeDefs,
      query: `{
        productId
        description
        options {
          optionId
          units { unitId restrictions { allowed maxPax maxAdults maxPaxWithInfants } }
          restrictions {
            Other { allowed maxPax maxAdults maxPaxWithInfants }
            Single { allowed maxPax maxAdults maxPaxWithInfants }
            Twin { maxPax }
          }
        }
      }`,
      rootValue: {
        supplierRecord: {
          SupplierId: '7318',
          Name: 'Example Hotel',
          SupplierNotes: {
            SupplierNote: { NoteText: '  Family owned hotel  ' },
          },
        },
        optionsGroupedBySupplierId: [{
          Opt: 'LONHOHOTELSSTD',
          OptGeneral: {
            SupplierId: '7318',
            SupplierName: 'Example Hotel',
            Description: 'Standard Room',
            SType: 'Y',
            Single_Avail: 'Y',
            Single_Max: '0',
            Single_Ad_Max: '2',
            Single_Max_With_Infants: '2',
            Other_Avail: 'Y',
            Other_Max: '4',
            Other_Ad_Max: '3',
            Other_Max_With_Infants: '5',
            Twin_Ad_Max: '2',
          },
          RatePolicy: {
            Single_Max: '9',
            Other_Max: '9',
          },
        }],
      },
    });

    expect(retVal.description).toBe('Family owned hotel');
    expect(retVal.options[0].restrictions.Single).toEqual({
      allowed: true,
      maxPax: 0,
      maxAdults: 2,
      maxPaxWithInfants: 2,
    });
    expect(retVal.options[0].restrictions.Other).toEqual({
      allowed: true,
      maxPax: 4,
      maxAdults: 3,
      maxPaxWithInfants: 5,
    });
    expect(retVal.options[0].restrictions.Twin.maxPax).toBe(2);
    const unitIds = retVal.options[0].units.map(unit => unit.unitId);
    expect(unitIds).toEqual(['Single', 'Twin', 'Double', 'Triple', 'Quad', 'Other']);
    const singleUnit = retVal.options[0].units.find(unit => unit.unitId === 'Single');
    expect(singleUnit.restrictions.maxPax).toBe(0);
    expect(singleUnit.restrictions.maxPaxWithInfants).toBe(2);
    const otherUnit = retVal.options[0].units.find(unit => unit.unitId === 'Other');
    expect(otherUnit.restrictions).toEqual({
      allowed: true,
      maxPax: 4,
      maxAdults: 3,
      maxPaxWithInfants: 5,
    });
  });

  it('omits Other when OptionInfo has no Other room fields', async () => {
    const retVal = await translateTPOption({
      typeDefs: productTypeDefs,
      query: `{
        options {
          units { unitId restrictions { allowed maxPax } }
          restrictions { Other { allowed maxPax } Single { allowed } }
        }
      }`,
      rootValue: {
        optionsGroupedBySupplierId: [{
          Opt: 'LONTRDAVIDSHDWBVD',
          OptGeneral: {
            SupplierId: '6489',
            SupplierName: 'Davids of London Ltd',
            Description: 'Half-Day Warner Bros Studios (6-Hours)',
            SType: 'N',
            SCU: 'day',
          },
        }, {
          Opt: 'LONHOHOTELSSTD',
          OptGeneral: {
            SupplierId: '6489',
            SupplierName: 'Davids of London Ltd',
            Description: 'Standard Room',
            SType: 'Y',
            Single_Avail: 'Y',
            Other_Max: '4',
          },
        }],
      },
    });

    expect(retVal.options[0].restrictions.Other).toBeNull();
    expect(retVal.options[0].units.map(unit => unit.unitId)).not.toContain('Other');
    expect(retVal.options[1].restrictions.Other).toEqual({
      allowed: null,
      maxPax: 4,
    });
    expect(retVal.options[1].units.map(unit => unit.unitId)).toContain('Other');
    const otherUnit = retVal.options[1].units.find(unit => unit.unitId === 'Other');
    expect(otherUnit.restrictions.allowed).toBeNull();
  });

  it('ignores a supplier note that only repeats the supplier name', async () => {
    const retVal = await translateTPOption({
      typeDefs: productTypeDefs,
      query: '{ description }',
      rootValue: {
        supplierRecord: {
          Name: 'Example Hotel',
          Description: 'Example Hotel',
          SupplierNotes: { SupplierNote: { NoteText: 'Example Hotel' } },
        },
        optionsGroupedBySupplierId: [{
          Opt: 'LONHOHOTELSSTD',
          OptGeneral: {
            SupplierId: '7318',
            SupplierName: 'Example Hotel',
            Description: 'Standard Room',
            SType: 'Y',
          },
        }],
      },
    });

    expect(retVal.description).toBeNull();
  });

  it('prefers the class description and stores a lowercased SCU', async () => {
    const retVal = await translateTPOption({
      typeDefs: productTypeDefs,
      query: `{
        options {
          optionId
          optionClass
          chargeUnit
        }
      }`,
      rootValue: {
        optionsGroupedBySupplierId: [{
          Opt: 'TESTVALIDATEMAXPAXPERCHARGE',
          OptGeneral: {
            SupplierId: '7318',
            SupplierName: 'Instyle Chauffeured Limousines Australia',
            Description: 'City Hotel to International Airport Transfer',
            Class: 'PRI',
            ClassDescription: 'Private',
            SCU: 'Day',
          },
        }, {
          Opt: 'LONTRDAVIDSHDWBVD',
          OptGeneral: {
            SupplierId: '6489',
            SupplierName: 'Davids of London Ltd',
            Description: 'Half-Day Warner Bros Studios (6-Hours)',
            Class: 'PRI',
            SCU: '',
          },
        }],
      },
    });

    expect(retVal.options[0]).toMatchObject({
      optionId: 'TESTVALIDATEMAXPAXPERCHARGE',
      optionClass: 'Private',
      chargeUnit: 'day',
    });
    expect(retVal.options[1]).toMatchObject({
      optionId: 'LONTRDAVIDSHDWBVD',
      optionClass: 'PRI',
      chargeUnit: null,
    });
  });
});
