// -----------------------------------------------------------------------------
// One Gladys device per water meter.
//
// External ids are built from the distributor's id of the delivery point,
// never from the meter serial: Suez's `idPDS` and Saur's
// `sectionSubscriptionId` stay when the distributor swaps the meter (end of
// life, failure), so the user's history, dashboards and scenes survive the
// swap. `ext:<selector>:<provider>:<id>`. Feature keys are forever.
//
// Features, read-only sensors with history, the shapes of the Veolia and
// Agur integrations (volume-sensor, m³ and litres):
//   - index (m³): the cumulative reading, dated with its reading day, and
//     re-sent as "now" (a staircase: the last known index stays displayed);
//   - daily consumption (L): one state per day, dated with that day: the
//     history shows each litre on the day it was used;
//   - consumption of the month and of the year (m³): running totals, "now";
//   - average price (€/m³, Suez only) and the Suez leak alert (0/1), "now".
// Gladys 5.2's energy tracking prices electricity only (the core refuses a
// `water` contract): nothing here enters it, the volumes are plain sensors.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import { DEVICE_NAMES, FEATURE_NAMES, pick } from './i18n.js';
import { readingInstant } from './time.js';

export const FEATURE = {
  INDEX: 'index',
  DAILY: 'daily_consumption',
  MONTH: 'month_consumption',
  YEAR: 'year_consumption',
  PRICE: 'price',
  LEAK: 'leak_alert',
};

/** The ids of a meter's device and features. */
export function meterIds(gladys, providerKey, meterId) {
  return gladys.externalIds(providerKey, meterId);
}

/** The key of a meter in /data. */
export function meterKey(providerKey, meterId) {
  return `${providerKey}:${meterId}`;
}

const sensor = (definition) => ({
  ...definition,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

/**
 * The device Gladys discovers for a meter.
 * @param {object} gladys the SDK client
 * @param {object} provider an entry of PROVIDERS
 * @param {{ id: string, number: string }} meter
 * @param {string} language
 */
export function buildDevice(gladys, provider, meter, language) {
  const ids = meterIds(gladys, provider.key, meter.id);
  const names = pick(FEATURE_NAMES, language);
  const volume = (key, type, unit, max) =>
    sensor({
      name: names[key],
      external_id: ids.feature(key),
      category: CAT.VOLUME_SENSOR,
      type,
      unit,
      min: 0,
      max,
    });
  const features = [
    volume(FEATURE.INDEX, TYPE.VOLUME_SENSOR.DECIMAL, UNIT.CUBIC_METER, 1000000),
    volume(FEATURE.DAILY, TYPE.VOLUME_SENSOR.INTEGER, UNIT.LITER, 1000000),
    volume(FEATURE.MONTH, TYPE.VOLUME_SENSOR.DECIMAL, UNIT.CUBIC_METER, 100000),
    volume(FEATURE.YEAR, TYPE.VOLUME_SENSOR.DECIMAL, UNIT.CUBIC_METER, 1000000),
  ];
  if (provider.features.price) {
    features.push(
      sensor({
        name: names[FEATURE.PRICE],
        external_id: ids.feature(FEATURE.PRICE),
        category: CAT.CURRENCY,
        type: TYPE.CURRENCY.DECIMAL,
        unit: UNIT.EURO,
        min: 0,
        max: 100,
      }),
    );
  }
  if (provider.features.leakAlert) {
    features.push(
      sensor({
        name: names[FEATURE.LEAK],
        external_id: ids.feature(FEATURE.LEAK),
        category: CAT.LEAK_SENSOR,
        // The core types the binary sensors through the generic SENSOR group.
        type: TYPE.SENSOR.BINARY,
        min: 0,
        max: 1,
      }),
    );
  }
  return {
    name: `${pick(DEVICE_NAMES, language)} ${provider.name} ${meter.number}`,
    external_id: ids.device,
    // The container refreshes the meters itself (src/poller.js); the core's
    // poll, once a minute, is only a fallback the poller skips.
    should_poll: true,
    poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
    features,
    params: [
      { name: 'provider', value: provider.key },
      { name: 'meter_number', value: meter.number },
    ],
  };
}

/**
 * The dated states of the days from `from` (inclusive): the daily
 * consumption of each day, and the index of the day it was read.
 * @param {object} gladys
 * @param {object} provider
 * @param {string} meterId
 * @param {object} record the meter record (src/history.js)
 * @param {string|null} from
 */
export function datedStates(gladys, provider, meterId, record, from) {
  const ids = meterIds(gladys, provider.key, meterId);
  const states = Object.keys(record.days)
    .filter((date) => from === null || date >= from)
    .sort()
    .map((date) => ({
      device_feature_external_id: ids.feature(FEATURE.DAILY),
      state: record.days[date],
      created_at: readingInstant(date),
    }));
  if (record.index && (from === null || record.index.date >= from)) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE.INDEX),
      state: record.index.m3,
      created_at: readingInstant(record.index.date),
    });
  }
  return states;
}

/**
 * The "now" states of a meter, for publishChangedStates (heartbeat).
 * @param {object} gladys
 * @param {object} provider
 * @param {string} meterId
 * @param {object} summary see summarize()
 * @param {{ priceEurPerM3: number|null, leak: boolean|null }} extras
 */
export function currentStates(gladys, provider, meterId, summary, extras) {
  const ids = meterIds(gladys, provider.key, meterId);
  const states = [];
  const add = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      states.push({ device_feature_external_id: ids.feature(key), state: value });
    }
  };
  add(FEATURE.INDEX, summary.index?.m3);
  add(FEATURE.MONTH, summary.monthM3);
  add(FEATURE.YEAR, summary.yearM3);
  if (provider.features.price) {
    add(FEATURE.PRICE, extras?.priceEurPerM3);
  }
  if (provider.features.leakAlert && typeof extras?.leak === 'boolean') {
    add(FEATURE.LEAK, extras.leak ? 1 : 0);
  }
  return states;
}
