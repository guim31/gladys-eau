// -----------------------------------------------------------------------------
// The Suez client (port of pySuezV2) against the fake "Tout sur mon eau":
// the CSRF token, the sign-in, the saved session, the telemetry and the
// extras. Nothing reaches the network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CannotConnectError, InvalidAuthError } from '../src/errors.js';
import { createHttpSession } from '../src/http.js';
import { createSuezClient, extractCsrfToken } from '../src/providers/suez.js';
import { createFakeWeb } from './helpers/fake-web.js';
import {
  alertsWith,
  CSRF_TOKEN,
  LOGIN_PAGE,
  serveSuez,
  SUEZ_ACCOUNT,
  suezFixture,
} from './helpers/suez-site.js';

function setup(options = {}) {
  const web = createFakeWeb();
  const site = serveSuez(web, { dataUntil: () => '2026-10-13', ...options });
  const client = () => createSuezClient({ session: createHttpSession({ fetch: web.fetch }) });
  return { web, site, client };
}

test('the CSRF token is read from the escaped JSON of the sign-in page', () => {
  assert.equal(extractCsrfToken(LOGIN_PAGE), CSRF_TOKEN);
  // The other shapes a rewritten page could use.
  assert.equal(extractCsrfToken('{"csrfToken":"abc123","targetUrl":"/"}'), 'abc123');
  assert.equal(extractCsrfToken('<input type="hidden" name="_csrf_token" value="xyz">'), 'xyz');
  assert.equal(extractCsrfToken('<html>no token</html>'), null);
});

test('signs in with the form pySuez posts, and lists the meter by its delivery point', async () => {
  const { web, site, client } = setup();
  const suez = client();
  const saved = await suez.login(SUEZ_ACCOUNT);
  assert.equal(site.logins, 1);
  assert.equal(saved.host, 'https://www.toutsurmoneau.fr');
  assert.ok(site.sessions.has(saved.cookie), 'the session cookie is the one to save');
  const [post] = web.calls(
    'POST',
    'https://www.toutsurmoneau.fr/mon-compte-en-ligne/je-me-connecte',
  );
  assert.deepEqual(Object.keys(post.form).sort(), [
    '_csrf_token',
    'tsme_user_login[_password]',
    'tsme_user_login[_username]',
  ]);
  assert.deepEqual(await suez.meters(), [
    { id: '9876543', number: '19ZZ123456', aliases: ['9876543', '19ZZ123456'] },
  ]);
});

test('a refused password is an InvalidAuthError, never retried in a loop', async () => {
  const { site, client } = setup();
  site.password = 'another one';
  await assert.rejects(client().login(SUEZ_ACCOUNT), InvalidAuthError);
  assert.equal(site.refusedLogins, 1);
});

test('a saved session is reused, and an expired one signs in again once', async () => {
  const { site, client } = setup();
  const saved = await client().login(SUEZ_ACCOUNT);
  assert.equal(site.logins, 1);

  const again = await client().login(SUEZ_ACCOUNT, saved);
  assert.equal(site.logins, 1, 'no new sign-in while the session works');
  assert.equal(again.cookie, saved.cookie);

  site.sessions.clear();
  const renewed = await client().login(SUEZ_ACCOUNT, saved);
  assert.equal(site.logins, 2);
  assert.notEqual(renewed.cookie, saved.cookie);
});

test('the daily telemetry is read month by month, in litres, index in m³', async () => {
  const { web, client } = setup();
  const suez = client();
  await suez.login(SUEZ_ACCOUNT);
  const days = await suez.days({ id: '9876543' }, '2026-09-29', '2026-10-13');
  assert.equal(days.length, 15);
  assert.deepEqual(days[0], { date: '2026-09-29', liters: 280, indexM3: days[0].indexM3 });
  assert.equal(typeof days[0].indexM3, 'number');
  const calls = web.calls(
    'GET',
    'https://www.toutsurmoneau.fr/public-api/cel-consumption/telemetry',
  );
  assert.deepEqual(
    calls.map((call) => [call.query.id_PDS, call.query.start_date, call.query.end_date]),
    [
      ['9876543', '2026-09-01', '2026-10-01'],
      ['9876543', '2026-10-01', '2026-11-01'],
    ],
  );
});

test('the measures of the fixture: m³ to litres, the empty day left out', async () => {
  const web = createFakeWeb();
  serveSuez(web, { dataUntil: () => '2026-10-13' });
  web.on('GET', 'https://www.toutsurmoneau.fr/public-api/cel-consumption/telemetry', {
    json: suezFixture('telemetry-daily.json'),
  });
  const suez = createSuezClient({ session: createHttpSession({ fetch: web.fetch }) });
  await suez.login(SUEZ_ACCOUNT);
  assert.deepEqual(await suez.days({ id: '9876543' }, '2026-09-01', '2026-10-13'), [
    { date: '2026-09-28', liters: 287, indexM3: 1234.512 },
    { date: '2026-09-29', liters: 222, indexM3: 1234.734 },
    { date: '2026-09-30', liters: 246, indexM3: 1234.98 },
  ]);
});

test('a month without data (code 02) is empty, another error is a CannotConnectError', async () => {
  const { web, client } = setup({ dataUntil: () => '2026-08-31' });
  const suez = client();
  await suez.login(SUEZ_ACCOUNT);
  const days = await suez.days({ id: '9876543' }, '2026-08-30', '2026-10-13');
  assert.deepEqual(
    days.map((day) => day.date),
    ['2026-08-30', '2026-08-31'],
  );
  web.on('GET', 'https://www.toutsurmoneau.fr/public-api/cel-consumption/telemetry', {
    status: 500,
    text: 'Internal error',
  });
  await assert.rejects(
    suez.days({ id: '9876543' }, '2026-10-01', '2026-10-13'),
    CannotConnectError,
  );
});

test('the extras: the price, its fallback on the town price, and the alerts', async () => {
  const { site, client } = setup();
  const suez = client();
  await suez.login(SUEZ_ACCOUNT);
  assert.deepEqual(await suez.extras(), {
    priceEurPerM3: 4.74,
    leak: false,
    overconsumption: false,
  });
  site.price = null;
  site.alerts = alertsWith({ leak: true });
  assert.deepEqual(await suez.extras(), {
    priceEurPerM3: 4.21,
    leak: true,
    overconsumption: false,
  });
});

test('a sign-in page without token is a CannotConnectError (the site changed)', async () => {
  const { web, client } = setup();
  web.on('GET', 'https://www.toutsurmoneau.fr/mon-compte-en-ligne/je-me-connecte', {
    text: '<html>maintenance</html>',
  });
  await assert.rejects(client().login(SUEZ_ACCOUNT), CannotConnectError);
});
