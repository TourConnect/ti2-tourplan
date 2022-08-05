const _ = require('underscore');

const mapDaysToNumbers = day => {
  switch (day) {
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    case 'Sun':
      return 7;
    default:
      return undefined;
  }
};

const mapNumbersToDays = num => {
  switch (num) {
    case 1:
      return 'Mon';
    case 2:
      return 'Tue';
    case 3:
      return 'Wed';
    case 4:
      return 'Thu';
    case 5:
      return 'Fri';
    case 6:
      return 'Sat';
    case 7:
      return 'Sun';
    default:
      return undefined;
  }
};

const normalizeCurrency = valueParam => {
  const value = parseFloat(valueParam);
  if (Number.isNaN(value)) {
    return 'n/a';
  }
  return (value % 1 === 0 ? value.toFixed(4) : value.toFixed(4));
};

const normalizeDate = date => {
  if (!date) return '';
  const d = new Date(date);
  let month = (d.getUTCMonth() + 1).toString();
  let day = d.getUTCDate().toString();
  const year = d.getUTCFullYear().toString();

  if (month.length < 2) month = `0${month}`;
  if (day.length < 2) day = `0${day}`;

  return [year, month, day].join('-');
};

const getConsectuiveDays = days => {
  const dayNumbers = _.map(days, mapDaysToNumbers).sort();
  let firstDay;
  let lastDay;

  for (let i = 0; i < dayNumbers.length; i += 1) {
    const currentDay = dayNumbers[i];
    if (!firstDay) firstDay = currentDay;
    lastDay = currentDay;

    if ((i > 0) && (i < dayNumbers.length)) {
      const previousDay = dayNumbers[i - 1];
      if (currentDay - previousDay > 1) return false;
    }
  }

  return `${mapNumbersToDays(firstDay)} - ${mapNumbersToDays(lastDay)}`;
};

module.exports = {

  stripEnclosingQuotes: strParam => {
    let str = strParam;
    if (str && str.charAt(0) === '"') {
      str = str.slice(1);
    }
    return str;
  },

  deepContains: (dataArray, searchItem) => {
    for (let i = 0; i < dataArray.length; i += 1) {
      if (_.isEqual(dataArray[i], searchItem)) return true;
    }
    return false;
  },

  normalizeDateRange: dateRangeParam => {
    const dateRange = {
      fromDate: normalizeDate(dateRangeParam.start_date),
      toDate: normalizeDate(dateRangeParam.end_date),
    };
    if (dateRangeParam.name) dateRange.name = dateRangeParam.name;
    return dateRange;
  },

  normalizeNA: str => {
    const na = ['N/A', 'NA', 'ON REQUEST'];
    return str && _.indexOf(na, str.trim().toUpperCase()) === -1 ? str.trim() : null;
  },

  nullableTrim: str => (str ? str.trim() : str),

  prettifyDays: days => {
    let consecutiveDays;
    if (days && days.length > 0) {
      if (days.length === 7) return 'Everyday';
      if (days.length === 1) return `${days[0]} Only`;

      consecutiveDays = getConsectuiveDays(days);
      return consecutiveDays || days.join(', ');
    }
    return null;
  },

  normalizeRateSetDetail: detail => {
    if (detail.not_applicable) return null;

    if (detail.nett_rate) {
      return {
        name: detail.desc,
        adults: normalizeCurrency(detail.max_adults),
        adultsPlusChild: normalizeCurrency(detail.max_adults_plus_child),
        nettRate: detail.nett_rate.toFixed(2),
        retailRate: detail.retail_rate ? detail.retail_rate.toFixed(2) : 0,
        extraAdult: normalizeCurrency(detail.extra_adult),
        extraChild: normalizeCurrency(detail.extra_child),
      };
    }
    // TODO: Other rate set types
    return null;
  },

  normalizeLog: text => {
    let logtest = text;

    if (text != null && text !== undefined) {
      if (typeof text !== 'string') {
        logtest = JSON.stringify(logtest);
      }
      logtest = logtest.replace(/"userName"\s*:\s*"[^"]*"/, '"userName":"..."');
      logtest = logtest.replace(/"password"\s*:\s*"[^"]*"/, '"password":"..."');
      logtest = logtest.replace(
        /<Password>[^<]*<\/Password>/,
        '<Password>...</Password>',
      );
      logtest = logtest.replace(/<Login>[^<]*<\/Login>/, '<Login>...</Login>');
    }
    return logtest;
  },
};
