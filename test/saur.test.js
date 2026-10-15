// -----------------------------------------------------------------------------
// The Saur client (port of saur_client) against the fake Saur API serving the
// EyeOnSaur mocks: the token, the subscriptions, the days, the last index.
// Nothing reaches the network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidAuthError } from '../src/errors.js';
import { createHttpSession } from '../src/http.js';
import { createSaurClient } from '../src/providers/saur.js';
import { createFakeWeb } from './helpers/fake-web.js';
import { SAUR_ACCOUNT, saurFixture, serveSaur } from './helpers/saur-api.js';

const NOW = Date.parse('2026-10-14T08:00:00Z');

function setup(options = {}) {
  const web = createFakeWeb();
  const api = serveSaur(web, { dataUntil: () => '2026-10-13', ...options });
  const clock = { ms: NOW };
  const client = () =>
    createSaurClient({ session: createHttpSession({ fetch: web.fetch }), now: () => clock.ms });
  return { web, api, clock, client };
}

test('signs in with the payload of the web front and lists the active subscriptions', async () => {
  const { web, api, client } = setup();
  const saur = client();
  const saved = await saur.login(SAUR_ACCOUNT);
  assert.equal(api.logins, 1);
  assert.equal(saved.clientId, '512345678901234560');
  assert.equal(saved.expiresAt, NOW + 900 * 1000);
  const [auth] = web.calls('POST', 'https://apib2c.azure.saurclient.fr/admin/v2/auth');
  assert.equal(auth.json.client_id, 'frontjs-client');
  assert.equal(auth.json.grant_type, 'password');
  const meters = await saur.meters();
  assert.deepEqual(
    meters.map((meter) => [meter.id, meter.number]),
    [
      ['789012125678968230', '100430'],
      ['789012345678901781', '100430'],
      ['234567890123456782', '100430'],
    ],
  );
  assert.ok(meters[0].aliases.includes('L24AA100430T'), 'the registration number matches too');
});

test('a terminated subscription is left out', async () => {
  const area = saurFixture('area.json');
  area.clients[0].customerAccounts[0].sectionSubscriptions[0].isContractTerminated = true;
  const { client } = setup({ area });
  const saur = client();
  await saur.login(SAUR_ACCOUNT);
  assert.equal((await saur.meters()).length, 2);
});

test('a refused password is an InvalidAuthError', async () => {
  const { api, client } = setup();
  api.password = 'not this one';
  await assert.rejects(client().login(SAUR_ACCOUNT), InvalidAuthError);
});

test('the saved token is reused while valid, renewed when expired or refused', async () => {
  const { api, clock, client } = setup();
  const saved = await client().login(SAUR_ACCOUNT);
  const reused = client();
  await reused.login(SAUR_ACCOUNT, saved);
  await reused.meters();
  assert.equal(api.logins, 1, 'a valid token needs no sign-in');

  clock.ms += 15 * 60 * 1000;
  const late = client();
  await late.login(SAUR_ACCOUNT, saved);
  assert.equal(api.logins, 2, 'an expired token signs in again');

  // A token the API forgot (a restart of theirs): 401, then one sign-in.
  api.tokens.clear();
  await late.meters();
  assert.equal(api.logins, 3);
});

test('the days of the EyeOnSaur monthly mock: m³ to litres', async () => {
  const web = createFakeWeb();
  serveSaur(web, { dataUntil: () => '2026-10-13' });
  web.on('GET', /\/consumptions\/monthly\?year=2024&month=7$/, {
    json: saurFixture('monthly.json'),
  });
  const saur = createSaurClient({
    session: createHttpSession({ fetch: web.fetch }),
    now: () => NOW,
  });
  await saur.login(SAUR_ACCOUNT);
  const days = await saur.days({ id: '789012125678968230' }, '2024-07-01', '2024-07-31');
  assert.equal(days.length, 31);
  assert.deepEqual(days.slice(0, 3), [
    { date: '2024-07-01', liters: 120, indexM3: null },
    { date: '2024-07-02', liters: 130, indexM3: null },
    { date: '2024-07-03', liters: 140, indexM3: null },
  ]);
  assert.equal(days[5].liters, 0, 'a day at 0 stays a reading');
});

test('a month the API has no data for is empty, and the last index is read', async () => {
  const { web, client } = setup({ dataUntil: () => '2026-09-30' });
  const saur = client();
  await saur.login(SAUR_ACCOUNT);
  const days = await saur.days({ id: '789012125678968230' }, '2026-09-29', '2026-10-13');
  assert.deepEqual(
    days.map((day) => day.date),
    ['2026-09-29', '2026-09-30'],
  );
  assert.equal(web.calls('GET', /consumptions\/monthly/).length, 2);
  const extras = await saur.extras({ id: '789012125678968230' });
  assert.deepEqual(extras.index, { m3: 123, date: '2026-09-30' });
  assert.equal(extras.priceEurPerM3, null);
  assert.equal(extras.leak, null);
});
