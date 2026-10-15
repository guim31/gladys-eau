// -----------------------------------------------------------------------------
// A whole world for the end-to-end tests: the SDK's fake Gladys, the app wired
// to it, a fake web serving Suez and Saur, an in-memory store, a clock the
// test moves, and the log lines the app wrote.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createApp, registerHandlers } from '../../src/app.js';
import { createMemoryStore } from '../../src/store.js';
import { localDate } from '../../src/time.js';
import { createFakeWeb } from './fake-web.js';
import { SAUR_ACCOUNT, serveSaur } from './saur-api.js';
import { SUEZ_ACCOUNT, serveSuez } from './suez-site.js';

// 10:00 in Paris, 14 October 2026: before the real "now" of the test run.
export const MORNING = Date.parse('2026-10-14T08:00:00Z');

export const SUEZ_CONFIG = { provider: 'suez', ...SUEZ_ACCOUNT, language: 'fr' };
export const SAUR_CONFIG = { provider: 'saur', ...SAUR_ACCOUNT, language: 'fr' };

/** A logger recording every line, by level. */
export function recordingLogger() {
  const lines = [];
  const record =
    (level) =>
    (...args) =>
      lines.push({
        level,
        text: args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
      });
  return {
    lines,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    at: (level) => lines.filter((line) => line.level === level).map((line) => line.text),
    clear: () => lines.splice(0, lines.length),
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {number} [options.now] the clock (ms), moved through `world.clock`
 * @param {number} [options.lagDays] how late the readings are (days before today)
 * @param {object} [options.suez] options of the Suez site
 * @param {object} [options.saur] options of the Saur API
 * @param {object} [options.store]
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {boolean} [options.timers] arm the refresh timer
 */
export function createWorld({
  config = SUEZ_CONFIG,
  now = MORNING,
  lagDays = 1,
  suez = {},
  saur = {},
  store = createMemoryStore(),
  devices = [],
  timers = false,
} = {}) {
  const clock = { ms: now };
  const web = createFakeWeb();
  const dataUntil = () => localDate(clock.ms - lagDays * 86400000);
  const suezSite = serveSuez(web, { dataUntil, ...suez });
  const saurApi = serveSaur(web, { dataUntil, ...saur });
  const gladys = createFakeGladys({ config, devices });
  const logger = recordingLogger();
  const app = createApp({
    gladys,
    store,
    fetch: web.fetch,
    now: () => clock.ms,
    timers,
    logger,
    historyStatesPerMinute: 0,
  });
  registerHandlers(gladys, app);
  return {
    clock,
    web,
    suez: suezSite,
    saur: saurApi,
    gladys,
    app,
    store,
    logger,
    async connect() {
      await gladys.connect();
    },
    /** Add every discovered meter to Gladys, as the user would. */
    async addAllMeters() {
      for (const device of gladys.fake.discoveredDevices) {
        await gladys.fake.deviceCreated(device);
      }
    },
    /** The states published on one feature (by key), oldest call first. */
    statesOf(featureSuffix) {
      return gladys.fake.states.filter((state) =>
        state.device_feature_external_id.endsWith(`:${featureSuffix}`),
      );
    },
    async stop() {
      app.stop();
      await gladys.disconnect();
    },
  };
}
