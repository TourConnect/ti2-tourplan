const R = require('ramda');
const { productConnectXmlOptions } = require('../../utils');

// Constants for parsing limits
const MAX_PXB_FIELDS = 24; // Maximum number of Pxb fields supported by Product Connect API
const MAX_VTEXT_FIELDS = 20; // Maximum number of Vtext fields supported by Product Connect API

// Cross-season calculation constants
// Specifies how a rate is calculated where a rate season boundary is crossed.
const CROSS_SEASON_CAL_USING_RATE_OF_FIRST_RATE_PERIOD = 'F'; // Use rate of first rate period
const CROSS_SEASON_NOT_ALLOWED = 'N'; // Not allowed
// const CROSS_SEASON_CAL_AVERAGE = 'A'; // Average rate across seasons
const CROSS_SEASON_CAL_SPLIT_RATE = 'S'; // Split the service line on rate season boundaries and cost each independently

// Parse the general data
const parseGeneralData = optionDataObj => {
  const optionGeneralData = R.pathOr({}, ['OptionGeneralData'], optionDataObj);
  const generalData = {
    optionCode: R.pathOr('', ['OptionCode'], optionGeneralData),
    optId: R.pathOr('', ['Opt_ID'], optionGeneralData),
    ac: R.pathOr('', ['Ac'], optionGeneralData) === 'Y',
    deleted: R.pathOr('', ['Deleted'], optionGeneralData) === 'Y',
    description: R.pathOr('', ['Description'], optionGeneralData),
    description2: R.pathOr('', ['Description2'], optionGeneralData),
    comment: R.pathOr('', ['Comment'], optionGeneralData),
    comment2: R.pathOr('', ['Comment2'], optionGeneralData),
    locality: R.pathOr('', ['Locality'], optionGeneralData),
    class: R.pathOr('', ['Class'], optionGeneralData),
    duration: parseFloat(R.pathOr('0', ['Duration'], optionGeneralData)),
    analysis1: R.pathOr('', ['Analysis1'], optionGeneralData),
    analysis2: R.pathOr('', ['Analysis2'], optionGeneralData),
    analysis3: R.pathOr('', ['Analysis3'], optionGeneralData),
    analysis4: R.pathOr('', ['Analysis4'], optionGeneralData),
    analysis5: R.pathOr('', ['Analysis5'], optionGeneralData),
    analysis6: R.pathOr('', ['Analysis6'], optionGeneralData),
    messageCode: R.pathOr('', ['Message_Code'], optionGeneralData),
    invoiceText1: R.pathOr('', ['Invoice_Text1'], optionGeneralData),
    invoiceText2: R.pathOr('', ['Invoice_Text2'], optionGeneralData),
    invoiceText3: R.pathOr('', ['Invoice_Text3'], optionGeneralData),
    invoiceText4: R.pathOr('', ['Invoice_Text4'], optionGeneralData),
    createdBy: R.pathOr('', ['Created_By'], optionGeneralData),
    editedBy: R.pathOr('', ['Edited_By'], optionGeneralData),
    created: R.pathOr('', ['Created'], optionGeneralData),
    lastUpdate: R.pathOr('', ['LastUpdate'], optionGeneralData),
  };
  return generalData;
};

// Parse the cost data
const parseCostData = optionDataObj => {
  const optionCostData = R.pathOr({}, ['OptionCostData'], optionDataObj);
  const paxBreaks = {};
  const costData = {
    fcu: R.pathOr('', ['FCU'], optionCostData),
    fcuLocal: R.pathOr('', ['FCU_Local'], optionCostData),
    scu: R.pathOr('', ['SCU'], optionCostData),
    scuLocal: R.pathOr('', ['SCU_Local'], optionCostData),
    mpfcu: parseInt(R.pathOr('0', ['MPFCU'], optionCostData), 10),
    periods: parseInt(R.pathOr('0', ['Periods'], optionCostData), 10),
    periodsBase: R.pathOr('', ['Periods_Base'], optionCostData),
  };

  // Set paxBreaks properties
  paxBreaks.childInPxb = R.pathOr('', ['Child_In_Pxb'], optionCostData) === 'Y';
  paxBreaks.infantInPxb = R.pathOr('', ['Infant_In_Pxb'], optionCostData) === 'Y';

  // Parse Pxb fields - only non-zero values
  const pxbFields = {};
  for (let i = 1; i <= MAX_PXB_FIELDS; i += 1) {
    const value = parseInt(R.pathOr('0', [`Pxb${i}`], optionCostData), 10);
    if (value !== 0) {
      pxbFields[`pxb${i}`] = value;
    }
  }
  paxBreaks.pxbFields = pxbFields;

  // Parse Extra fields (1-5)
  const extraFields = {};
  for (let i = 1; i <= 5; i += 1) {
    extraFields[`ex${i}`] = R.pathOr('', [`Ex${i}`], optionCostData);
    extraFields[`ex${i}Local`] = R.pathOr('', [`Ex${i}_Local`], optionCostData);
    extraFields[`chgEx${i}`] = R.pathOr('', [`ChgEx${i}`], optionCostData);
    extraFields[`ex${i}Description`] = R.pathOr('', [`Ex${i}Description`], optionCostData);
    extraFields[`ex${i}DescriptionLocal`] = R.pathOr('', [`Ex${i}Description_Local`], optionCostData);
    extraFields[`intHideEx${i}`] = R.pathOr('', [`Int_Hide_Ex${i}`], optionCostData) === 'Y';
  }

  return {
    ...costData,
    paxBreaks,
    ...pxbFields,
    ...extraFields,
  };
};

// Parse the voucher data
const parseVoucherData = optionDataObj => {
  // Parse OptionVoucherData
  const optionVoucherData = R.pathOr({}, ['OptionVoucherData'], optionDataObj);
  const voucherData = {
    vProd: R.pathOr('', ['V_Prod'], optionVoucherData),
    vchProdCode: R.pathOr('', ['Vch_ProdCode'], optionVoucherData),
    vname: R.pathOr('', ['Vname'], optionVoucherData),
    vadd1: R.pathOr('', ['Vadd1'], optionVoucherData),
    vadd2: R.pathOr('', ['Vadd2'], optionVoucherData),
    vadd3: R.pathOr('', ['Vadd3'], optionVoucherData),
    vadd4: R.pathOr('', ['Vadd4'], optionVoucherData),
    vadd5: R.pathOr('', ['Vadd5'], optionVoucherData),
    pcode: R.pathOr('', ['PCode'], optionVoucherData),
    vnameLocal: R.pathOr('', ['Vname_Local'], optionVoucherData),
    vadd1Local: R.pathOr('', ['Vadd1_Local'], optionVoucherData),
    vadd2Local: R.pathOr('', ['Vadd2_Local'], optionVoucherData),
    vadd3Local: R.pathOr('', ['Vadd3_Local'], optionVoucherData),
    vadd4Local: R.pathOr('', ['Vadd4_Local'], optionVoucherData),
    vadd5Local: R.pathOr('', ['Vadd5_Local'], optionVoucherData),
    pcodeLocal: R.pathOr('', ['PCode_Local'], optionVoucherData),
  };

  // Parse Vtext fields (1-20) from voucher data
  const vtextFields = {};
  const editVtextFields = {};
  for (let i = 1; i <= MAX_VTEXT_FIELDS; i += 1) {
    vtextFields[`vtext${i}`] = R.pathOr('', [`Vtext${i}`], optionVoucherData);
    editVtextFields[`editVtext${i}`] = R.pathOr('', [`EditVtext${i}`], optionVoucherData) === 'Y';
  }

  return {
    ...voucherData,
    ...vtextFields,
    editVtextFields,
  };
};

// Parse the internet data
const parseInternetData = optionDataObj => {
  const optionInternetData = R.pathOr({}, ['OptionInternetData'], optionDataObj);
  const internetData = {
    intOption: R.pathOr('', ['Int_Option'], optionInternetData) === 'Y',
    intMoreinfourl: R.pathOr('', ['Int_Moreinfourl'], optionInternetData),
    intDefAvail: R.pathOr('', ['Int_Def_Avail'], optionInternetData),
    intSupplierAccess: R.pathOr('', ['Int_Supplier_Access'], optionInternetData) === 'Y',
    intSaleFm: R.pathOr('', ['Int_Sale_Fm'], optionInternetData),
    intSaleTo: R.pathOr('', ['Int_Sale_To'], optionInternetData),
  };

  return internetData;
};

// Parse the enquiry notes
const parseEnquiryNotes = optionDataObj => {
  const optionEnquiryNotes = R.pathOr({}, ['OptionEnquiryNotes'], optionDataObj);
  const enquiryNotesArray = R.pathOr([], ['OptionEnquiryNote'], optionEnquiryNotes);
  const enquiryNotesData = Array.isArray(enquiryNotesArray)
    ? enquiryNotesArray : [enquiryNotesArray];
  const enquiryNotes = enquiryNotesData.map(note => ({
    category: R.pathOr('', ['Category'], note),
    messageText: R.pathOr('', ['Message_Text'], note),
  }));
  return enquiryNotes;
};

// Parse the rate policy
const parseRatePolicy = optionDataObj => {
  const ratePolicyLevel = R.pathOr('', ['RatePolicyLevel'], optionDataObj);

  const ratePolicy = R.pathOr({}, ['RatePolicy'], optionDataObj);
  const ratePolicyData = {
    level: ratePolicyLevel,
    singleAvail: R.pathOr('', ['Single_Avail'], ratePolicy) === 'Y',
    singleMax: parseInt(R.pathOr('0', ['Single_Max'], ratePolicy), 10),
    singleAdMax: parseInt(R.pathOr('0', ['Single_Ad_Max'], ratePolicy), 10),
    singleMaxWithInfants: parseInt(R.pathOr('0', ['Single_Max_With_Infants'], ratePolicy), 10),
    twinAvail: R.pathOr('', ['Twin_Avail'], ratePolicy) === 'Y',
    twinMax: parseInt(R.pathOr('0', ['Twin_Max'], ratePolicy), 10),
    twinAdMax: parseInt(R.pathOr('0', ['Twin_Ad_Max'], ratePolicy), 10),
    twinMaxWithInfants: parseInt(R.pathOr('0', ['Twin_Max_With_Infants'], ratePolicy), 10),
    doubleAvail: R.pathOr('', ['Double_Avail'], ratePolicy) === 'Y',
    doubleMax: parseInt(R.pathOr('0', ['Double_Max'], ratePolicy), 10),
    doubleAdMax: parseInt(R.pathOr('0', ['Double_Ad_Max'], ratePolicy), 10),
    doubleMaxWithInfants: parseInt(R.pathOr('0', ['Double_Max_With_Infants'], ratePolicy), 10),
    tripleAvail: R.pathOr('', ['Triple_Avail'], ratePolicy) === 'Y',
    tripleMax: parseInt(R.pathOr('0', ['Triple_Max'], ratePolicy), 10),
    tripleAdMax: parseInt(R.pathOr('0', ['Triple_Ad_Max'], ratePolicy), 10),
    tripleMaxWithInfants: parseInt(R.pathOr('0', ['Triple_Max_With_Infants'], ratePolicy), 10),
    quadAvail: R.pathOr('', ['Quad_Avail'], ratePolicy) === 'Y',
    quadMax: parseInt(R.pathOr('0', ['Quad_Max'], ratePolicy), 10),
    quadAdMax: parseInt(R.pathOr('0', ['Quad_Ad_Max'], ratePolicy), 10),
    quadMaxWithInfants: parseInt(R.pathOr('0', ['Quad_Max_With_Infants'], ratePolicy), 10),
    otherAvail: R.pathOr('', ['Other_Avail'], ratePolicy) === 'Y',
    otherMax: parseInt(R.pathOr('0', ['Other_Max'], ratePolicy), 10),
    otherAdMax: parseInt(R.pathOr('0', ['Other_Ad_Max'], ratePolicy), 10),
    otherMaxWithInfants: parseInt(R.pathOr('0', ['Other_Max_With_Infants'], ratePolicy), 10),
    paxAdMin: parseInt(R.pathOr('0', ['Pax_Ad_Min'], ratePolicy), 10),
    paxMin: parseInt(R.pathOr('0', ['Pax_Min'], ratePolicy), 10),
    paxMinWithInfants: parseInt(R.pathOr('0', ['Pax_Min_With_Infants'], ratePolicy), 10),
    paxAdMax: parseInt(R.pathOr('0', ['Pax_Ad_Max'], ratePolicy), 10),
    paxMax: parseInt(R.pathOr('0', ['Pax_Max'], ratePolicy), 10),
    paxMaxWithInfants: parseInt(R.pathOr('0', ['Pax_Max_With_Infants'], ratePolicy), 10),
    infantFrom: parseInt(R.pathOr('0', ['Infant_From'], ratePolicy), 10),
    infantTo: parseInt(R.pathOr('0', ['Infant_To'], ratePolicy), 10),
    childFrom: parseInt(R.pathOr('0', ['Child_From'], ratePolicy), 10),
    childTo: parseInt(R.pathOr('0', ['Child_To'], ratePolicy), 10),
    adultFrom: parseInt(R.pathOr('0', ['Adult_From'], ratePolicy), 10),
    adultTo: parseInt(R.pathOr('0', ['Adult_To'], ratePolicy), 10),
    // Specifies which days of the week a service line can start on. Optional.
    startMon: R.pathOr('', ['Start_Mon'], ratePolicy) === 'Y',
    startTue: R.pathOr('', ['Start_Tue'], ratePolicy) === 'Y',
    startWed: R.pathOr('', ['Start_Wed'], ratePolicy) === 'Y',
    startThu: R.pathOr('', ['Start_Thu'], ratePolicy) === 'Y',
    startFri: R.pathOr('', ['Start_Fri'], ratePolicy) === 'Y',
    startSat: R.pathOr('', ['Start_Sat'], ratePolicy) === 'Y',
    startSun: R.pathOr('', ['Start_Sun'], ratePolicy) === 'Y',
    // Specifies which days of the week a service line must include. Optional.
    includeMon: R.pathOr('', ['Include_Mon'], ratePolicy) === 'Y',
    includeTue: R.pathOr('', ['Include_Tue'], ratePolicy) === 'Y',
    includeWed: R.pathOr('', ['Include_Wed'], ratePolicy) === 'Y',
    includeThu: R.pathOr('', ['Include_Thu'], ratePolicy) === 'Y',
    includeFri: R.pathOr('', ['Include_Fri'], ratePolicy) === 'Y',
    includeSat: R.pathOr('', ['Include_Sat'], ratePolicy) === 'Y',
    includeSun: R.pathOr('', ['Include_Sun'], ratePolicy) === 'Y',
    crossSeason: R.pathOr('', ['Cross_Season'], ratePolicy),
    pickup: R.pathOr('', ['Pickup'], ratePolicy) === 'Y',
  };
  return ratePolicyData;
};

// Parse the selling channels
const parseSellingChannels = optionDataObj => {
  const sellingChannels = R.pathOr({}, ['SellingChannels'], optionDataObj);
  const sellingChannelLevel = R.pathOr('', ['SellingChannelLevel'], optionDataObj);
  const sellingChannelsData = {
    level: sellingChannelLevel,
    allowTourplanUI: R.pathOr('', ['AllowTourplanUI'], sellingChannels) === 'Y',
    allowHostConnect: R.pathOr('', ['AllowHostConnect'], sellingChannels) === 'Y',
    allowWebConnect: R.pathOr('', ['AllowWebConnect'], sellingChannels) === 'Y',
  };
  return sellingChannelsData;
};

// Main function to parse the option data
const parseGetOptionData = optionDataObj => {
  // Parse OptionGeneralData
  const generalData = parseGeneralData(optionDataObj);

  // Parse OptionCostData
  const costData = parseCostData(optionDataObj);

  // Parse OptionVoucherData
  const voucherData = parseVoucherData(optionDataObj);

  // Parse OptionInternetData
  const internetData = parseInternetData(optionDataObj);

  // Parse OptionEnquiryNotes
  const enquiryNotes = parseEnquiryNotes(optionDataObj);

  // Parse RatePolicy
  const ratePolicy = parseRatePolicy(optionDataObj);

  // Parse SellingChannels
  const sellingChannels = parseSellingChannels(optionDataObj);

  return {
    generalData,
    costData,
    voucherData,
    internetData,
    enquiryNotes,
    ratePolicy,
    sellingChannels,
  };
};

/*
  Get rates info from Tourplan using Product Connect API

  @param {Object} params - Configuration parameters
  @param {string} optionId - The option ID
  @param {string} productConnectEndpoint - The product connect endpoint
  @param {string} productConnectUser - The product connect user
  @param {string} productConnectUserPassword - The product connect user password
  @param {string} startDate - The start date
  @param {number} chargeUnitQuantity - The charge unit quantity
  @param {Object} axios - The axios instance
  @param {Object} callTourplan - The callTourplan function
  @returns {Object} Parsed configuration object
*/
const getOption = async ({
  optionId,
  productConnectEndpoint,
  productConnectUser,
  productConnectUserPassword,
  axios,
  callTourplan,
}) => {
  // Input validation
  if (!optionId || typeof optionId !== 'string') {
    return null;
  }
  if (!productConnectEndpoint || typeof productConnectEndpoint !== 'string') {
    return null;
  }
  if (!productConnectUser || typeof productConnectUser !== 'string') {
    return null;
  }
  if (!productConnectUserPassword || typeof productConnectUserPassword !== 'string') {
    return null;
  }
  const getOptionModel = ({
    GetOptionRequest: {
      User: productConnectUser,
      Password: productConnectUserPassword,
      OptionCode: optionId,
    },
  });

  // Call product connect to get rates info
  const replyObj = await callTourplan({
    model: getOptionModel,
    endpoint: productConnectEndpoint,
    axios,
    xmlOptions: productConnectXmlOptions,
  });

  const optionDataObj = R.pathOr([], ['GetOptionReply', 'OptionData'], replyObj);

  // Parse the option data
  const optionData = optionDataObj ? parseGetOptionData(optionDataObj) : null;

  return optionData;
};

/*
  Get option info from Product Connect API

  @param {Object} params - Configuration parameters
  @param {string} optionId - The option ID
  @param {string} productConnectEndpoint - The product connect endpoint
  @param {string} productConnectUser - The product connect user
  @param {string} productConnectUserPassword - The product connect user password
  @param {Object} axios - The axios instance
  @param {Object} callTourplan - The callTourplan function
  @returns {Object} Parsed option info
*/
const getOptionFromProductConnect = async (
  optionId,
  productConnectEndpoint,
  productConnectUser,
  productConnectUserPassword,
  axios,
  callTourplan,
) => {
  const optionInfo = await getOption({
    optionId,
    productConnectEndpoint,
    productConnectUser,
    productConnectUserPassword,
    axios,
    callTourplan,
  });

  if (!optionInfo) {
    return null;
  }

  // Read the parametes required
  // eslint-disable-next-line max-len
  const crossSeason = optionInfo.ratePolicy ? optionInfo.ratePolicy.crossSeason : CROSS_SEASON_CAL_SPLIT_RATE;
  const paxBreaks = optionInfo.costData ? optionInfo.costData.paxBreaks : {};

  return {
    crossSeason: crossSeason.toUpperCase(),
    paxBreaks,
  };
};

module.exports = {
  getOptionFromProductConnect,
  // Cross-season calculation constants
  CROSS_SEASON_NOT_ALLOWED,
  CROSS_SEASON_CAL_USING_RATE_OF_FIRST_RATE_PERIOD,
  CROSS_SEASON_CAL_SPLIT_RATE,
};
