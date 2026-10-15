// -----------------------------------------------------------------------------
// End to end: the app on the SDK's fake Gladys, Suez and Saur on a fake web.
// The cycle, the history sent once, the refresh timer without onPoll, the
// heartbeat, the calm logs, the refused password, the abnormal-consumption
// episodes, the widget, the scene action and the configuration action.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { REFRESH_PERIOD_MS } from '../src/poller.js';
import { createFileStore, createMemoryStore } from '../src/store.js';
import { addDays, localDate } from '../src/time.js';
import { alertsWith, steadyDays, SUEZ_ACCOUNT } from './helpers/suez-site.js';
import { SAUR_ACCOUNT, singleMeterArea } from './helpers/saur-api.js';
import { createWorld, MORNING, SAUR_CONFIG, SUEZ_CONFIG } from './helpers/world.js';

const HOUR = 3600 * 1000;
const SUEZ_DEVICE = 'ext:test-integration:suez:9876543';

/** A world connected, its meters added to Gladys. */
async function ready(options = {}) {
  const world = createWorld(options);
  await world.connect();
  await world.addAllMeters();
  return world;
}

test('a first cycle finds the meter; its history goes out once the user adds it', async () => {
  const world = createWorld();
  try {
    await world.connect();
    assert.deepEqual(world.gladys.fake.connectionStatus, { connected: true });
    assert.equal(world.gladys.fake.discoveredDevices.length, 1);
    assert.equal(world.gladys.fake.states.length, 0, 'nothing for a device not added yet');

    await world.addAllMeters();
    const daily = world.statesOf('daily_consumption');
    // 1 October 2025 to 13 October 2026, each day stamped on its own noon.
    assert.equal(daily.length, 378);
    assert.deepEqual(daily.at(-1), {
      device_feature_external_id: `${SUEZ_DEVICE}:daily_consumption`,
      state: steadyDays('2026-10-13'),
      created_at: '2026-10-13T12:00:00.000Z',
    });
    assert.ok(daily.every((state) => state.created_at.endsWith('T12:00:00.000Z')));
    assert.equal(world.gladys.fake.lastState(`${SUEZ_DEVICE}:month_consumption`), 3.12);
    assert.equal(world.gladys.fake.lastState(`${SUEZ_DEVICE}:price`), 4.74);
    assert.equal(world.gladys.fake.lastState(`${SUEZ_DEVICE}:leak_alert`), 0);
    assert.ok(world.gladys.fake.widgetRefreshes.includes('water_summary'));
  } finally {
    await world.stop();
  }
});

test('the history is sent in calls of 100 states at most', async (t) => {
  const world = createWorld();
  const sizes = [];
  const original = world.gladys.publishStates.bind(world.gladys);
  t.mock.method(world.gladys, 'publishStates', async (states) => {
    sizes.push(states.length);
    return original(states);
  });
  try {
    await world.connect();
    await world.addAllMeters();
    assert.ok(sizes.length >= 4);
    assert.ok(Math.max(...sizes) <= 100, `${sizes}`);
  } finally {
    await world.stop();
  }
});

test('the next cycles send the new days and a short overlap, not the history again', async () => {
  const world = await ready();
  try {
    const before = world.statesOf('daily_consumption').length;
    world.clock.ms += 24 * HOUR;
    await world.app.sync();
    const sent = world.statesOf('daily_consumption').slice(before);
    assert.deepEqual(
      sent.map((state) => state.created_at.slice(0, 10)),
      [
        '2026-10-08',
        '2026-10-09',
        '2026-10-10',
        '2026-10-11',
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
      ],
    );
  } finally {
    await world.stop();
  }
});

test('the states refresh on the container timer, without any onPoll from the core', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = createWorld({ timers: true });
  let polls = 0;
  const original = world.app.poll;
  world.app.poll = () => {
    polls += 1;
    return original();
  };
  try {
    await world.connect();
    await world.addAllMeters();
    assert.equal(world.gladys.fake.lastState(`${SUEZ_DEVICE}:month_consumption`), 3.12);

    // A day later, the distributor has a new reading: the timer reads it.
    world.clock.ms += 24 * HOUR;
    t.mock.timers.tick(REFRESH_PERIOD_MS);
    await world.app.sync();
    assert.equal(
      world.gladys.fake.lastState(`${SUEZ_DEVICE}:month_consumption`),
      (3120 + steadyDays('2026-10-14')) / 1000,
    );
    assert.equal(world.statesOf('daily_consumption').at(-1).created_at, '2026-10-14T12:00:00.000Z');
    assert.equal(polls, 0, 'no onPoll was involved');
  } finally {
    await world.stop();
  }
});

test('the core poll is only a fallback: skipped while the timer is on time', async () => {
  const world = await ready();
  try {
    const logins = world.suez.logins;
    assert.equal(await world.app.poller.fromCore(), false);
    assert.deepEqual(await world.gladys.fake.poll(world.gladys.fake.discoveredDevices[0]), {
      success: true,
    });
    world.clock.ms += REFRESH_PERIOD_MS;
    assert.equal(await world.app.poller.fromCore(), true);
    assert.equal(world.suez.logins, logins, 'the saved session was reused');
  } finally {
    await world.stop();
  }
});

test('unchanged values are re-sent every few hours (heartbeat), not every cycle', async (t) => {
  // The SDK dates its heartbeat with the wall clock.
  t.mock.timers.enable({ apis: ['Date'], now: MORNING });
  const world = await ready();
  try {
    const count = () => world.statesOf('year_consumption').length;
    const first = count();
    await world.app.sync();
    assert.equal(count(), first, 'unchanged and recent: not sent');
    world.clock.ms += 7 * HOUR;
    t.mock.timers.tick(7 * HOUR);
    world.suez.liters = (date) => (date >= '2026-10-14' ? null : steadyDays(date));
    await world.app.sync();
    assert.equal(count(), first + 1, 'unchanged, but older than the heartbeat');
  } finally {
    await world.stop();
  }
});

test('a normal cycle writes nothing at info, and no secret ever reaches a log', async () => {
  const world = await ready();
  try {
    world.logger.clear();
    world.clock.ms += 8 * HOUR;
    await world.app.sync();
    world.clock.ms += 8 * HOUR;
    await world.app.sync();
    assert.deepEqual(world.logger.at('info'), []);
    assert.deepEqual(world.logger.at('warn'), []);
    assert.ok(world.logger.at('debug').length > 0, 'the details are at debug');

    const secrets = [
      SUEZ_ACCOUNT.password,
      ...world.suez.sessions,
      ...Object.values(world.app.persisted.sessions).map((saved) => saved.cookie),
    ];
    for (const line of world.logger.lines) {
      for (const secret of secrets) {
        assert.ok(!line.text.includes(secret), `a secret in "${line.text}"`);
      }
    }
  } finally {
    await world.stop();
  }
});

test('a log line carrying a secret is blanked', async () => {
  const world = await ready();
  try {
    world.suez.down = true;
    world.web.on(
      'GET',
      'https://www.toutsurmoneau.fr/public-api/cel-consumption/meters-list',
      () => {
        throw new TypeError(`fetch failed for ${SUEZ_ACCOUNT.password}`);
      },
    );
    world.clock.ms += 8 * HOUR;
    await world.app.sync();
    assert.ok(world.logger.lines.every((line) => !line.text.includes(SUEZ_ACCOUNT.password)));
  } finally {
    await world.stop();
  }
});

test('a refused password: one warning, no retry until the configuration changes', async () => {
  const world = createWorld();
  world.suez.password = 'changed on the website';
  try {
    await world.connect();
    assert.equal(world.gladys.fake.connectionStatus.connected, false);
    assert.match(world.gladys.fake.connectionStatus.message.fr, /refuse l’adresse e-mail/);
    assert.equal(world.logger.at('warn').length, 1);
    const refused = world.suez.refusedLogins;

    world.clock.ms += 8 * HOUR;
    assert.deepEqual(await world.app.sync(), { status: 'password' });
    assert.equal(world.suez.refusedLogins, refused, 'no new try: the account could be locked');

    world.suez.password = SUEZ_ACCOUNT.password;
    await world.gladys.fake.configUpdated({ ...SUEZ_CONFIG });
    assert.deepEqual(world.gladys.fake.connectionStatus, { connected: true });
    assert.equal(
      world.logger.at('info').filter((line) => /accepts the sign-in/.test(line)).length,
      1,
    );
  } finally {
    await world.stop();
  }
});

test('a distributor down: one warning, then debug, one info line when it is back', async () => {
  const world = await ready();
  try {
    world.logger.clear();
    world.suez.down = true;
    world.app.persisted.sessions = {};
    for (let i = 0; i < 3; i += 1) {
      world.clock.ms += HOUR;
      const outcome = await world.app.sync();
      assert.equal(outcome.retry, true);
    }
    assert.equal(world.logger.at('warn').length, 1);
    assert.match(world.gladys.fake.connectionStatus.message.fr, /Suez est injoignable/);

    world.suez.down = false;
    world.clock.ms += HOUR;
    await world.app.sync();
    assert.deepEqual(world.logger.at('info'), ['Suez answers again']);
    assert.deepEqual(world.gladys.fake.connectionStatus, { connected: true });
  } finally {
    await world.stop();
  }
});

test('the Suez leak alert: one event per episode, kept across a restart', async () => {
  const store = createMemoryStore();
  const world = await ready({ store });
  try {
    assert.equal(world.gladys.fake.sceneEvents.length, 0);
    world.suez.alerts = alertsWith({ leak: true });
    world.clock.ms += 8 * HOUR;
    await world.app.sync();
    assert.deepEqual(world.gladys.fake.sceneEvents, [
      {
        key: 'abnormal_consumption',
        data: {
          device: SUEZ_DEVICE,
          reason: 'leak_alert',
          provider: 'Suez',
          date: '2026-10-13',
          liters: steadyDays('2026-10-13'),
          usual_liters: 240,
        },
      },
    ]);
    assert.equal(world.gladys.fake.lastState(`${SUEZ_DEVICE}:leak_alert`), 1);

    world.clock.ms += 8 * HOUR;
    await world.app.sync();
    assert.equal(world.gladys.fake.sceneEvents.length, 1, 'still the same episode');
  } finally {
    await world.stop();
  }

  // A restart: the episode in progress is read back from /data.
  const restarted = await ready({
    store,
    now: MORNING + 24 * HOUR,
    suez: { alerts: alertsWith({ leak: true }) },
  });
  try {
    assert.equal(restarted.gladys.fake.sceneEvents.length, 0, 'no second event after a restart');

    restarted.suez.alerts = alertsWith();
    restarted.clock.ms += 8 * HOUR;
    await restarted.app.sync();
    assert.ok(restarted.logger.at('info').some((line) => /back to normal/.test(line)));
    assert.equal(restarted.gladys.fake.lastState(`${SUEZ_DEVICE}:leak_alert`), 0);

    restarted.suez.alerts = alertsWith({ overconsumption: true });
    restarted.clock.ms += 8 * HOUR;
    await restarted.app.sync();
    assert.deepEqual(
      restarted.gladys.fake.sceneEvents.map((event) => event.data.reason),
      ['overconsumption_alert'],
      'a new episode is a new event',
    );
  } finally {
    await restarted.stop();
  }
});

test('several days far above usual make an event, with the usual level', async () => {
  const leakFrom = '2026-10-11';
  const world = await ready({
    config: SAUR_CONFIG,
    saur: {
      area: singleMeterArea(),
      liters: (date) => (date >= leakFrom ? 1100 : steadyDays(date)),
    },
  });
  try {
    const [event] = world.gladys.fake.sceneEvents;
    assert.equal(event.key, 'abnormal_consumption');
    assert.deepEqual(event.data, {
      device: 'ext:test-integration:saur:789012125678968230',
      reason: 'unusual_consumption',
      provider: 'Saur',
      date: '2026-10-13',
      liters: 1100,
      usual_liters: 240,
    });
    const outputs = await world.gladys.fake.sceneAction('get_water_summary', {
      meter: 'ext:test-integration:saur:789012125678968230',
    });
    assert.equal(outputs.data.outputs.abnormal, true);
  } finally {
    await world.stop();
  }
});

test('with the threshold off, only the distributor alerts make an event', async () => {
  const world = await ready({
    config: { ...SAUR_CONFIG, abnormal_threshold: 'off' },
    saur: { area: singleMeterArea(), liters: (date) => (date >= '2026-10-11' ? 1100 : 200) },
  });
  try {
    assert.equal(world.gladys.fake.sceneEvents.length, 0);
  } finally {
    await world.stop();
  }
});

test('Saur: the last index of the meter, dated with its reading day', async () => {
  const world = await ready({ config: SAUR_CONFIG, saur: { area: singleMeterArea() } });
  try {
    const device = 'ext:test-integration:saur:789012125678968230';
    assert.equal(world.gladys.fake.lastState(`${device}:index`), 123);
    assert.ok(
      world.statesOf('index').some((state) => state.created_at === '2026-10-13T12:00:00.000Z'),
    );
    assert.equal(world.gladys.fake.lastState(`${device}:year_consumption`), 68.54);
  } finally {
    await world.stop();
  }
});

test('the widget content fits the core budget, in the four languages', async () => {
  const world = await ready();
  try {
    world.suez.alerts = alertsWith({ leak: true });
    world.clock.ms += 8 * HOUR;
    await world.app.sync();
    for (const language of ['en', 'fr', 'de', 'es']) {
      const answer = await world.gladys.fake.widgetGet('water_summary', {
        settings: { meter: SUEZ_DEVICE },
        language,
      });
      assert.equal(answer.success, true);
      const { content } = answer.data;
      assert.deepEqual(validateWidgetContent(content), [], language);
      const types = content.components.map((component) => component.type);
      assert.deepEqual(types, ['text', 'value', 'value', 'value', 'value', 'chart', 'status']);
      const status = content.components.at(-1);
      assert.equal(status.items.length, 3, 'year, price, alert');
    }
  } finally {
    await world.stop();
  }
});

test('the widget explains what is missing before the first reading', async () => {
  const world = createWorld({ config: { provider: 'suez' } });
  try {
    await world.connect();
    const answer = await world.gladys.fake.widgetGet('water_summary', {
      settings: {},
      language: 'fr',
    });
    assert.deepEqual(validateWidgetContent(answer.data.content), []);
    assert.match(answer.data.content.components[0].text, /Configurez l’intégration/);
    assert.equal(world.gladys.fake.connectionStatus.connected, false);
  } finally {
    await world.stop();
  }
});

test('the scene action gives the figures of a meter', async () => {
  const world = await ready();
  try {
    const answer = await world.gladys.fake.sceneAction('get_water_summary', { meter: SUEZ_DEVICE });
    assert.equal(answer.success, true);
    const { outputs } = answer.data;
    assert.deepEqual(outputs, {
      month_m3: 3.12,
      year_m3: 68.54,
      abnormal: false,
      last_date: '2026-10-13',
      last_day_liters: steadyDays('2026-10-13'),
      index_m3: outputs.index_m3,
      previous_month_change_percent: 0,
      last_year_change_percent: 0,
    });
    assert.equal(typeof outputs.index_m3, 'number');
    const unknown = await world.gladys.fake.sceneAction('get_water_summary', { meter: 'nope' });
    assert.equal(unknown.success, false);
  } finally {
    await world.stop();
  }
});

test('the refresh action reads now, then refuses a second one too soon', async () => {
  const world = createWorld();
  try {
    await world.connect();
    world.clock.ms += HOUR;
    const first = await world.gladys.fake.action('refresh_now', {});
    assert.match(first.data.message.fr, /1 compteur\(s\) trouvé\(s\)/);
    await world.addAllMeters();
    world.clock.ms += 20 * 60 * 1000;
    const second = await world.gladys.fake.action('refresh_now', {});
    assert.match(second.data.message.fr, /données jusqu’au 13 oct\./);
    const third = await world.gladys.fake.action('refresh_now', {});
    assert.match(third.data.message.fr, /réessayez dans 15 min/);
    assert.equal(
      world.logger.at('info').filter((line) => line === 'Action: refresh now').length,
      3,
    );
  } finally {
    await world.stop();
  }
});

test('a configured meter number keeps that meter, or says which ones exist', async () => {
  const world = createWorld({
    config: { ...SAUR_CONFIG, meter: 'L24AA100430T' },
  });
  try {
    await world.connect();
    assert.equal(
      world.gladys.fake.discoveredDevices.length,
      3,
      'the registration number of all three',
    );
    await world.gladys.fake.configUpdated({ ...SAUR_CONFIG, meter: '789 012 345 678 901 781' });
    assert.deepEqual(
      world.gladys.fake.discoveredDevices.map((device) => device.external_id),
      ['ext:test-integration:saur:789012345678901781'],
    );
    await world.gladys.fake.configUpdated({ ...SAUR_CONFIG, meter: '000' });
    assert.match(
      world.gladys.fake.connectionStatus.message.fr,
      /Compteurs du compte : 100430-8230/,
    );
  } finally {
    await world.stop();
  }
});

test('a meter added later gets its whole history from what was already read', async () => {
  const world = createWorld({ config: SAUR_CONFIG, saur: { area: singleMeterArea() } });
  try {
    await world.connect();
    const calls = world.web.requests.length;
    await world.addAllMeters();
    assert.equal(world.web.requests.length, calls, 'no new request to Saur');
    assert.equal(world.statesOf('daily_consumption').length, 378);
  } finally {
    await world.stop();
  }
});

test('the state file is written owner-only and read back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gladys-eau-'));
  try {
    const store = createFileStore(directory);
    const world = await ready({ store });
    await world.stop();
    const info = await stat(store.path);
    assert.equal(info.mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(store.path, 'utf8'));
    assert.ok(!JSON.stringify(saved).includes(SUEZ_ACCOUNT.username), 'the email is hashed');
    assert.ok(!JSON.stringify(saved).includes(SUEZ_ACCOUNT.password));
    const record = saved.meters['suez:9876543'];
    assert.equal(record.publishedUntil, '2026-10-13');
    assert.equal(Object.keys(record.days).length, 378);
    const loaded = await store.load();
    assert.deepEqual(Object.keys(loaded.meters), ['suez:9876543']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the days follow the Paris calendar', () => {
  // 23:30 UTC on 13 October is already the 14th in Paris.
  assert.equal(localDate(Date.parse('2026-10-13T23:30:00Z')), '2026-10-14');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30');
  assert.ok(SAUR_ACCOUNT.username);
});
