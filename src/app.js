// -----------------------------------------------------------------------------
// The integration: one cycle reads the distributor and feeds Gladys.
//
// A cycle (three a day, src/poller.js):
//   1. signs in to Suez or Saur, reusing the session saved in /data;
//   2. lists the meters of the account (or the one the user named);
//   3. reads each meter: the daily readings from a few days before the last
//      known one (the distributors correct their latest readings) or, the
//      first time, the last 13 months; then the index, the price and the
//      alerts the distributor gives;
//   4. publishes the devices, the dated history of the days (to the meters
//      the user added), the running totals, and fires the "abnormal
//      consumption" event once per episode.
// What the distributor answered is kept in memory and in /data: a device
// added later, the widget and the scene action are served from it without a
// new sign-in.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig, secretsOf } from './config.js';
import { InvalidAuthError } from './errors.js';
import {
  checkUnusual,
  emptyMeterRecord,
  fetchWindow,
  lastKnownDay,
  mergeReadings,
  summarize,
} from './history.js';
import { createHttpSession } from './http.js';
import { formatDay, LANGUAGES, MESSAGES } from './i18n.js';
import { createIssueLog } from './issues.js';
import { buildDevice, currentStates, datedStates, meterIds, meterKey } from './meters.js';
import { createPoller } from './poller.js';
import { findProvider } from './providers/index.js';
import { emptyState, identityOf } from './store.js';
import { addDays, localDate } from './time.js';
import { buildWidgetContent } from './widgets.js';

export const ACTION = {
  REFRESH: 'refresh_now',
};

export const TRIGGER = {
  ABNORMAL: 'abnormal_consumption',
};

export const SCENE_ACTION = {
  SUMMARY: 'get_water_summary',
};

export const WIDGET = {
  SUMMARY: 'water_summary',
};

/** The reasons of an abnormal-consumption episode, most serious first. */
export const REASON = {
  LEAK: 'leak_alert',
  OVERCONSUMPTION: 'overconsumption_alert',
  UNUSUAL: 'unusual_consumption',
};

// Each cycle sends the last days again: the distributors correct them, the
// core updates a day it already has.
const OVERLAP_DAYS = 5;
// A manual refresh within this delay of a successful one is refused.
const MANUAL_REFRESH_MIN_MS = 15 * 60 * 1000;
// An action answers within its timeout; a longer refresh (the first import)
// goes on alone.
const ACTION_WAIT_MS = 100 * 1000;
// Re-send unchanged values at least this often ("no recent value" otherwise).
const HEARTBEAT_MS = 6 * 3600 * 1000;
// POST /state takes 100 states per call and 300 per minute per integration:
// a history of 13 months (400 days per meter) goes out within a budget of
// 240 dated states a minute, shared by the meters, the rest left to the
// running values.
const STATES_PER_CALL = 100;
export const HISTORY_STATES_PER_MINUTE = 240;

const EMPTY_EXTRAS = { priceEurPerM3: null, leak: null, overconsumption: null, index: null };

/** A logger that blanks the given secrets, whatever a message carries. */
function redacting(base, secrets) {
  const clean = (args) =>
    args.map((arg) => {
      let text = arg instanceof Error ? arg.message : arg;
      if (typeof text !== 'string') {
        return arg;
      }
      for (const secret of secrets()) {
        text = text.split(secret).join('***');
      }
      return text;
    });
  return {
    debug: (...args) => base.debug(...clean(args)),
    info: (...args) => base.info(...clean(args)),
    warn: (...args) => base.warn(...clean(args)),
    error: (...args) => base.error(...clean(args)),
  };
}

/** A reason short enough for a status line. */
function reasonOf(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

const sameNumber = (a, b) =>
  String(a).replace(/\s+/g, '').toLowerCase() === String(b).replace(/\s+/g, '').toLowerCase();

/**
 * Meters whose numbers are the same get the end of their id added: the
 * device names must tell them apart (Saur gives several subscriptions of a
 * contract the same meter serial).
 */
function distinctNumbers(list) {
  const counts = new Map();
  for (const meter of list) {
    counts.set(meter.number, (counts.get(meter.number) ?? 0) + 1);
  }
  return list.map((meter) =>
    counts.get(meter.number) > 1
      ? { ...meter, number: `${meter.number}-${meter.id.slice(-4)}` }
      : meter,
  );
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
 * @param {object} options.store persistence (src/store.js)
 * @param {typeof fetch} [options.fetch] for the distributors' requests
 * @param {() => number} [options.now]
 * @param {boolean} [options.timers] arm the refresh timer
 * @param {object} [options.logger]
 * @param {number} [options.historyStatesPerMinute] budget of dated states (0: unlimited)
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export function createApp({
  gladys,
  store,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timers = true,
  logger: baseLogger = createLogger({ name: 'eau' }),
  historyStatesPerMinute = HISTORY_STATES_PER_MINUTE,
  sleep = defaultSleep,
}) {
  let config = normalizeConfig(DEFAULT_CONFIG);
  let persisted = emptyState();
  const sessionSecrets = () =>
    Object.values(persisted.sessions).flatMap((saved) =>
      Object.values(saved ?? {}).filter((value) => typeof value === 'string' && value.length >= 8),
    );
  const logger = redacting(baseLogger, () => [...secretsOf(config), ...sessionSecrets()]);
  const issues = createIssueLog(logger);

  /** Meters read by the last cycle, by meterKey. */
  let meters = new Map();
  /** The account whose password was refused: not tried again until the configuration changes. */
  let refusedIdentity = null;
  /** The message of the last cycle that stopped on the meter list. */
  let listProblem = null;
  let lastSuccessAt = null;
  let running = null;

  const provider = () => findProvider(config.provider);
  const identity = () => identityOf(config.provider, config.username);
  const today = () => localDate(now());

  async function setStatus(connected, message) {
    try {
      await gladys.setConnectionStatus(connected, message);
    } catch (err) {
      logger.debug(`Connection status not sent: ${reasonOf(err)}`);
    }
  }

  async function save() {
    try {
      await store.save(persisted);
    } catch (err) {
      issues.fail('store', `Cannot write the state file: ${reasonOf(err)}`);
      return;
    }
    issues.ok('store', 'The state file is writable again');
  }

  function createdDevices() {
    return new Set((gladys.devices ?? []).map((device) => device.external_id));
  }

  function idsOf(entry) {
    return meterIds(gladys, entry.provider.key, entry.meter.id);
  }

  function meterByDevice(externalId) {
    for (const entry of meters.values()) {
      if (idsOf(entry).device === externalId) {
        return entry;
      }
    }
    return null;
  }

  async function publishDevices() {
    await gladys.publishDiscoveredDevices(
      [...meters.values()].map((entry) =>
        buildDevice(gladys, entry.provider, entry.meter, config.language),
      ),
    );
  }

  async function refreshWidget() {
    try {
      await gladys.requestWidgetRefresh(WIDGET.SUMMARY);
    } catch (err) {
      logger.debug(`Widget refresh not sent: ${reasonOf(err)}`);
    }
  }

  /** The dated states sent in the last minute (wall clock: the budget is the core's). */
  const recentCalls = [];
  async function waitForBudget(count) {
    if (historyStatesPerMinute <= 0) {
      return;
    }
    for (;;) {
      const at = Date.now();
      while (recentCalls.length > 0 && at - recentCalls[0].at >= 60000) {
        recentCalls.shift();
      }
      const used = recentCalls.reduce((total, call) => total + call.count, 0);
      if (recentCalls.length === 0 || used + count <= historyStatesPerMinute) {
        recentCalls.push({ at, count });
        return;
      }
      await sleep(Math.max(1000, recentCalls[0].at + 60000 - at));
    }
  }

  /** Dated states, 100 per call, within the budget of the core's rate limit. */
  async function publishDated(states) {
    for (let i = 0; i < states.length; i += STATES_PER_CALL) {
      const batch = states.slice(i, i + STATES_PER_CALL);
      await waitForBudget(batch.length);
      await gladys.publishStates(batch);
    }
  }

  async function publishCurrent(entry) {
    try {
      await gladys.publishChangedStates(
        currentStates(gladys, entry.provider, entry.meter.id, entry.summary, entry.extras),
        { heartbeat: HEARTBEAT_MS },
      );
      issues.ok(`states:${entry.key}`, `${entry.provider.name}: states published again`);
    } catch (err) {
      issues.fail(
        `states:${entry.key}`,
        `${entry.provider.name}: states not published (${reasonOf(err)})`,
      );
    }
  }

  /**
   * Send a meter to Gladys: the days it does not have yet, then the running
   * values. Only for a device the user added (Gladys drops the rest).
   * @returns {Promise<boolean>} false when the device is not created yet
   */
  async function publishMeter(entry, { full = false } = {}) {
    if (!createdDevices().has(idsOf(entry).device)) {
      return false;
    }
    const { record } = entry;
    const from =
      full || !record.publishedUntil ? null : addDays(record.publishedUntil, -OVERLAP_DAYS);
    const states = datedStates(gladys, entry.provider, entry.meter.id, record, from);
    try {
      if (states.length > STATES_PER_CALL) {
        logger.debug(`${entry.provider.name}: sending ${states.length} days of history`);
      }
      await publishDated(states);
      record.publishedUntil = lastKnownDay(record);
      issues.ok(`history:${entry.key}`, `${entry.provider.name}: history accepted again`);
    } catch (err) {
      // The cursor stays: the next cycle sends these days again.
      issues.fail(
        `history:${entry.key}`,
        `${entry.provider.name}: history not published (${reasonOf(err)})`,
      );
    }
    await publishCurrent(entry);
    return true;
  }

  /**
   * The abnormal-consumption episode of a meter: fired once when it starts,
   * closed when nothing suspicious remains.
   */
  async function updateEpisode(entry) {
    const { record, extras, summary } = entry;
    const unusual = checkUnusual(record, today(), config.abnormalFactor);
    let reason = null;
    if (extras.leak) {
      reason = REASON.LEAK;
    } else if (extras.overconsumption) {
      reason = REASON.OVERCONSUMPTION;
    } else if (unusual.suspected) {
      reason = REASON.UNUSUAL;
    }
    const alertsUnknown = extras.leak === null && extras.overconsumption === null;
    const distributorEpisode = [REASON.LEAK, REASON.OVERCONSUMPTION].includes(
      record.episode?.reason,
    );
    const name = `${entry.provider.name} ${entry.meter.number}`;
    if (reason && !record.episode) {
      record.episode = { reason, since: today() };
      logger.info(`${name}: abnormal consumption suspected (${reason})`);
      try {
        await gladys.publishSceneEvent(TRIGGER.ABNORMAL, {
          device: idsOf(entry).device,
          reason,
          provider: entry.provider.name,
          date: unusual.date ?? summary.lastDay?.date ?? null,
          liters: unusual.liters ?? summary.lastDay?.liters ?? null,
          usual_liters: unusual.usualLiters ?? null,
        });
      } catch (err) {
        logger.warn(`${name}: the abnormal-consumption event was not sent (${reasonOf(err)})`);
      }
    } else if (!reason && record.episode && !(distributorEpisode && alertsUnknown)) {
      // A distributor alert that could not be read this cycle keeps its episode.
      record.episode = null;
      logger.info(`${name}: consumption back to normal`);
    }
    entry.episode = record.episode;
  }

  /** The running values of the meters known, when a cycle cannot read new ones. */
  async function heartbeatKnown() {
    const created = createdDevices();
    for (const entry of meters.values()) {
      if (created.has(idsOf(entry).device)) {
        await publishCurrent(entry);
      }
    }
  }

  async function refused(target) {
    refusedIdentity = identity();
    delete persisted.sessions[identity()];
    await save();
    issues.fail('auth', `${target.name} refused the sign-in: check the email and the password`);
    await setStatus(false, MESSAGES.invalidAuth(target.name));
    return { status: 'password' };
  }

  async function unreachable(target, err) {
    issues.fail('reach', `${target.name} cannot be reached: ${reasonOf(err)}`);
    await setStatus(false, MESSAGES.cannotConnect(target.name, reasonOf(err)));
    await heartbeatKnown();
    return { status: 'unreachable', retry: true, reason: reasonOf(err) };
  }

  /** Read one meter: the new days, then what the distributor tells beside. */
  async function readMeter(client, target, meter) {
    const key = meterKey(target.key, meter.id);
    const record = (persisted.meters[key] ??= emptyMeterRecord());
    const window = fetchWindow(record, today(), OVERLAP_DAYS);
    const readings = await client.days(meter, window.from, window.to);
    let extras;
    try {
      extras = { ...EMPTY_EXTRAS, ...(await client.extras(meter)) };
    } catch (err) {
      if (err instanceof InvalidAuthError) {
        throw err;
      }
      logger.debug(`${target.name}: no index nor alert this cycle (${reasonOf(err)})`);
      extras = { ...EMPTY_EXTRAS, ...(meters.get(key)?.extras ?? {}), leak: null };
    }
    mergeReadings(record, readings, extras.index);
    logger.debug(`${target.name}: ${readings.length} day(s) read from ${window.from}`);
    return {
      key,
      provider: target,
      meter,
      record,
      extras,
      summary: summarize(record, today()),
      episode: record.episode,
    };
  }

  /**
   * One cycle. Never throws: resolves its outcome, `retry` when the
   * distributor could not be reached (the poller tries again within the hour).
   * @returns {Promise<{ status: string, retry?: boolean, reason?: string }>}
   */
  async function cycle() {
    if (!isConfigured(config)) {
      await setStatus(false, MESSAGES.notConfigured);
      return { status: 'not_configured' };
    }
    const target = provider();
    if (!target) {
      await setStatus(false, MESSAGES.unsupportedProvider);
      return { status: 'unsupported' };
    }
    if (refusedIdentity === identity()) {
      // Trying a refused password again and again may lock the account.
      logger.debug(`${target.name}: password refused, waiting for a new configuration`);
      return { status: 'password' };
    }

    const session = createHttpSession({ fetch: fetchImpl });
    const client = target.create({ session, now });
    let list;
    try {
      persisted.sessions[identity()] = await client.login(
        { username: config.username, password: config.password },
        persisted.sessions[identity()],
      );
      list = distinctNumbers(await client.meters());
    } catch (err) {
      return err instanceof InvalidAuthError ? refused(target) : unreachable(target, err);
    }
    issues.ok('auth', `${target.name} accepts the sign-in again`);
    issues.ok('reach', `${target.name} answers again`);

    if (config.meter) {
      const wanted = list.filter((meter) =>
        meter.aliases.some((alias) => sameNumber(alias, config.meter)),
      );
      if (wanted.length === 0 && list.length > 0) {
        listProblem = MESSAGES.meterNotFound(list.map((meter) => meter.number).join(', '));
        await setStatus(false, listProblem);
        await save();
        return { status: 'meter_not_found' };
      }
      list = wanted;
    }
    if (list.length === 0) {
      listProblem = MESSAGES.noMeter(target.name);
      meters = new Map();
      await setStatus(false, listProblem);
      await save();
      return { status: 'no_meter' };
    }
    listProblem = null;

    const read = new Map();
    let failed = 0;
    for (const meter of list) {
      const key = meterKey(target.key, meter.id);
      try {
        read.set(key, await readMeter(client, target, meter));
        issues.ok(`meter:${key}`, `${target.name}: meter ${meter.number} is read again`);
      } catch (err) {
        if (err instanceof InvalidAuthError) {
          return refused(target);
        }
        failed += 1;
        issues.fail(
          `meter:${key}`,
          `${target.name}: meter ${meter.number} could not be read (${reasonOf(err)})`,
        );
        // Keep what the previous cycle read: still the best known values.
        const record = (persisted.meters[key] ??= emptyMeterRecord());
        read.set(
          key,
          meters.get(key) ?? {
            key,
            provider: target,
            meter,
            record,
            extras: { ...EMPTY_EXTRAS },
            summary: summarize(record, today()),
            episode: record.episode,
          },
        );
      }
    }
    const previousCount = meters.size;
    meters = read;

    try {
      await publishDevices();
      issues.ok('devices', 'Meters published again');
    } catch (err) {
      issues.fail('devices', `Publishing the meters failed: ${reasonOf(err)}`);
    }
    if (meters.size !== previousCount) {
      logger.info(`${target.name}: ${meters.size} meter(s) found`);
    }

    for (const entry of meters.values()) {
      await publishMeter(entry);
      await updateEpisode(entry);
    }
    await save();
    await refreshWidget();
    await setStatus(true);
    lastSuccessAt = now();
    logger.debug(`Cycle done: ${meters.size} meter(s), ${failed} failed`);
    return { status: 'ok', retry: failed > 0 };
  }

  /** One cycle at a time: a second caller waits for the one in progress. */
  function sync() {
    if (!running) {
      running = cycle()
        .catch((err) => {
          logger.error(`Cycle failed: ${reasonOf(err)}`);
          return { status: 'unreachable', retry: true, reason: reasonOf(err) };
        })
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  const poller = createPoller({ run: sync, now, timers });

  /** Wait for a refresh at most ACTION_WAIT_MS; it goes on alone past that. */
  async function refreshForAction() {
    let timeout;
    const outcome = await Promise.race([
      poller.runNow(),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(null), ACTION_WAIT_MS);
        timeout.unref?.();
      }),
    ]);
    clearTimeout(timeout);
    return outcome;
  }

  /** The newest day known over the meters, or null. */
  function newestDay() {
    const days = [...meters.values()].map((entry) => entry.summary.lastDay?.date).filter(Boolean);
    return days.sort().at(-1) ?? null;
  }

  /** The message of an action that ran a cycle. */
  function outcomeMessage(outcome) {
    const name = provider()?.name ?? config.provider;
    switch (outcome?.status) {
      case undefined:
        return MESSAGES.stillRunning;
      case 'ok': {
        const created = createdDevices();
        const missing = [...meters.values()].some((entry) => !created.has(idsOf(entry).device));
        const newest = newestDay();
        return missing || !newest
          ? MESSAGES.signedIn(name, meters.size)
          : MESSAGES.refreshed(name, formatDay(newest, config.language));
      }
      case 'password':
        return MESSAGES.invalidAuth(name);
      case 'no_meter':
      case 'meter_not_found':
        return listProblem ?? MESSAGES.noMeter(name);
      case 'not_configured':
        return MESSAGES.notConfigured;
      case 'unsupported':
        return MESSAGES.unsupportedProvider;
      default:
        return MESSAGES.cannotConnect(name, outcome.reason ?? 'see the logs');
    }
  }

  const api = {
    get config() {
      return config;
    },
    get meters() {
      return meters;
    },
    get persisted() {
      return persisted;
    },
    poller,
    sync,

    /** (Re)connected to Gladys: read the config and the saved state, then a cycle. */
    async start() {
      config = normalizeConfig(await gladys.getConfig());
      persisted = await store.load();
      const target = provider();
      logger.info(
        isConfigured(config)
          ? `Water integration started for ${target?.name ?? `an unsupported distributor (${config.provider})`}`
          : 'Water integration started: waiting for the configuration',
      );
      await poller.start();
    },

    async configUpdated(raw) {
      const previousIdentity = identity();
      config = normalizeConfig(raw);
      logger.info('Configuration updated');
      if (identity() !== previousIdentity) {
        // Another account: forget its meters.
        meters = new Map();
      }
      // A new configuration may carry the right password: try it.
      refusedIdentity = null;
      await poller.start();
    },

    async scanRequest() {
      if (meters.size === 0 && isConfigured(config)) {
        await sync();
      }
      await publishDevices();
    },

    async deviceCreated(device) {
      const entry = meterByDevice(device.external_id);
      if (!entry) {
        return;
      }
      logger.info(`${entry.provider.name}: meter ${entry.meter.number} added, sending its history`);
      await publishMeter(entry, { full: true });
      await save();
      await refreshWidget();
    },

    async deviceUpdated(device) {
      const entry = meterByDevice(device.external_id);
      if (entry) {
        await publishMeter(entry);
        await save();
      }
    },

    /**
     * The core's poll: acked at once, the cycle (when one is due) runs on.
     * A cycle signs in and reads for many seconds, past the ack delay.
     */
    poll() {
      poller.fromCore().catch((err) => logger.debug(`Poll fallback failed: ${reasonOf(err)}`));
    },

    stop() {
      poller.stop();
    },

    /** Configuration action: sign in and read now. */
    async refreshNow() {
      logger.info('Action: refresh now');
      if (!isConfigured(config)) {
        return MESSAGES.notConfigured;
      }
      if (!provider()) {
        return MESSAGES.unsupportedProvider;
      }
      if (lastSuccessAt !== null && now() - lastSuccessAt < MANUAL_REFRESH_MIN_MS) {
        return MESSAGES.refreshTooSoon(
          Math.ceil((MANUAL_REFRESH_MIN_MS - (now() - lastSuccessAt)) / 60000),
        );
      }
      // The user asks for it: one more try of a refused password.
      refusedIdentity = null;
      return outcomeMessage(await refreshForAction());
    },

    /** Scene action: the figures of a meter, for a message or a condition. */
    async waterSummary(fields = {}) {
      const entry = meterByDevice(fields.meter);
      if (!entry) {
        throw new Error('Unknown meter: add it to Gladys, then pick it in the action');
      }
      const { lastDay, monthM3, yearM3, index, comparison } = entry.summary;
      // An unknown figure is left out (null for the scene), never a false 0.
      const outputs = { month_m3: monthM3, year_m3: yearM3, abnormal: Boolean(entry.episode) };
      const add = (key, value) => {
        if (value !== null && value !== undefined) {
          outputs[key] = value;
        }
      };
      add('last_date', lastDay?.date);
      add('last_day_liters', lastDay?.liters);
      add('index_m3', index?.m3);
      add('previous_month_change_percent', comparison?.previousMonthChange);
      add('last_year_change_percent', comparison?.lastYearChange);
      return outputs;
    },

    /** Dashboard widget content. */
    async widget({ settings = {}, language = 'en' } = {}) {
      const entry = meterByDevice(settings.meter) ?? [...meters.values()][0] ?? null;
      return buildWidgetContent({
        meter: entry,
        language: LANGUAGES.includes(language) ? language : 'en',
        configured: isConfigured(config),
        passwordRefused: refusedIdentity !== null && refusedIdentity === identity(),
        today: today(),
      });
    },
  };
  return api;
}

/**
 * Register every handler on the SDK client (before connect()).
 * @param {object} gladys
 * @param {ReturnType<typeof createApp>} app
 */
export function registerHandlers(gladys, app) {
  gladys.onScanRequest(() => app.scanRequest());
  gladys.onPoll(() => app.poll());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceUpdated(device));
  gladys.onConfigUpdated((config) => app.configUpdated(config));
  gladys.onAction(ACTION.REFRESH, () => app.refreshNow());
  gladys.onSceneAction(SCENE_ACTION.SUMMARY, (fields) => app.waterSummary(fields));
  gladys.onWidgetGet(WIDGET.SUMMARY, (request) => app.widget(request));
  gladys.on('connected', async () => {
    try {
      await app.start();
    } catch (err) {
      await gladys.setConnectionStatus(false, MESSAGES.initFailed).catch(() => {});
      throw err;
    }
  });
}
