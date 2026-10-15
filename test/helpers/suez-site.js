// -----------------------------------------------------------------------------
// A fake "Tout sur mon eau" on the fake web: the sign-in form, the session
// cookie, and the /public-api answers in the shapes pySuezV2 reads (see
// test/fixtures/suez). The days are generated from the test clock.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { cookiesOf } from './fake-web.js';

const BASE = 'https://www.toutsurmoneau.fr';
const LOGIN = `${BASE}/mon-compte-en-ligne/je-me-connecte`;

export function suezFixture(name) {
  const text = readFileSync(new URL(`../fixtures/suez/${name}`, import.meta.url), 'utf8');
  return name.endsWith('.json') ? JSON.parse(text) : text;
}

export const LOGIN_PAGE = suezFixture('login-page.html');
export const CSRF_TOKEN = 'a1B2c3D4e5-f6G7h8_fake';
export const SUEZ_ACCOUNT = { username: 'jean.dupont@example.com', password: 'Eau-Secrete-42' };

/** Litres of a day, a steady household by default (200 to 280 L). */
export const steadyDays = (date) => 200 + (Number(date.slice(8, 10)) % 5) * 20;

const nextDay = (date) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/**
 * @param {ReturnType<import('./fake-web.js').createFakeWeb>} web
 * @param {object} options
 * @param {() => string} options.dataUntil the last day with a reading (YYYY-MM-DD)
 * @param {(date: string) => number|null} [options.liters]
 * @param {object} [options.alerts] the alerts answer
 * @param {object|null} [options.price] the price answer (null: KO_SERVICE)
 * @param {object} [options.meters] the meters-list answer
 */
export function serveSuez(web, options) {
  const site = {
    password: SUEZ_ACCOUNT.password,
    liters: options.liters ?? steadyDays,
    alerts: options.alerts ?? suezFixture('alerts-none.json'),
    price: options.price === undefined ? suezFixture('price.json') : options.price,
    meters: options.meters ?? suezFixture('meters-list.json'),
    sessions: new Set(),
    logins: 0,
    refusedLogins: 0,
    down: false,
  };

  const loggedIn = (request) => site.sessions.has(cookiesOf(request).eZSESSID);
  const toLogin = { status: 302, headers: { location: '/mon-compte-en-ligne/je-me-connecte' } };
  const guard = (handler) => (request) => {
    if (site.down) {
      return { status: 503, text: 'Service indisponible' };
    }
    return loggedIn(request) ? handler(request) : toLogin;
  };

  web.on('GET', LOGIN, () =>
    site.down
      ? { status: 503, text: 'Service indisponible' }
      : {
          text: LOGIN_PAGE,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          cookies: ['PHPSESSID=anonymous-session; Path=/; Secure; HttpOnly'],
        },
  );
  web.on('POST', LOGIN, (request) => {
    const form = request.form ?? {};
    if (
      form._csrf_token !== CSRF_TOKEN ||
      form['tsme_user_login[_username]'] !== SUEZ_ACCOUNT.username ||
      form['tsme_user_login[_password]'] !== site.password
    ) {
      site.refusedLogins += 1;
      // The form again, as the site does on a refused password.
      return toLogin;
    }
    site.logins += 1;
    const session = `sess-${site.logins}-${Math.random().toString(36).slice(2, 10)}`;
    site.sessions.add(session);
    return {
      status: 302,
      headers: { location: '/mon-compte-en-ligne/tableau-de-bord' },
      cookies: [`eZSESSID=${session}; Path=/; Secure; HttpOnly`],
    };
  });
  web.on(
    'GET',
    `${BASE}/mon-compte-en-ligne/tableau-de-bord`,
    guard(() => ({ text: '<html/>' })),
  );
  web.on(
    'GET',
    `${BASE}/public-api/cel-consumption/meters-list`,
    guard(() => ({ json: site.meters })),
  );
  web.on(
    'GET',
    `${BASE}/public-api/cel-consumption/telemetry`,
    guard((request) => {
      const { start_date: start, end_date: end, mode } = request.query;
      if (mode !== 'daily' || !start || !end) {
        return { status: 400, json: { code: '01', message: 'Bad request' } };
      }
      const until = options.dataUntil();
      const measures = [];
      for (let date = start; date < end && date <= until; date = nextDay(date)) {
        const liters = site.liters(date);
        if (liters === null) {
          continue;
        }
        measures.push({
          date: `${date} 00:00:00`,
          // An index that grows with the days: m³, three decimals.
          index: Math.round((1000 + Date.parse(`${date}T00:00:00Z`) / 86400000 / 4) * 1000) / 1000,
          volume: liters / 1000,
        });
      }
      if (measures.length === 0) {
        return { status: 400, json: suezFixture('telemetry-no-data.json') };
      }
      return { json: { code: '00', message: 'OK', content: { measures } } };
    }),
  );
  web.on(
    'GET',
    `${BASE}/public-api/cel-consumption/get-price`,
    guard(() =>
      site.price === null
        ? { json: { code: 'KO', content: null, message: 'KO_SERVICE' } }
        : { json: site.price },
    ),
  );
  web.on(
    'GET',
    `${BASE}/public-api/user/donnees-contrats`,
    guard(() => ({ json: [{ inseeCode: '00000', name: 'Contrat' }] })),
  );
  web.on(
    'GET',
    `${BASE}/information/donnee/price/00000`,
    guard(() => ({ json: { price: '4,21' } })),
  );
  web.on(
    'GET',
    `${BASE}/public-api/contract/tile/alerts`,
    guard(() => ({ json: site.alerts })),
  );
  return site;
}

/** An alerts answer with a leak (and optionally an overconsumption) alert. */
export function alertsWith({ leak = false, overconsumption = false } = {}) {
  const alerts = structuredClone(suezFixture('alerts-none.json'));
  if (leak) {
    alerts.content.leak_alert.status = 'ALERT';
  }
  if (overconsumption) {
    alerts.content.overconsumption_alert.status = 'ALERT';
  }
  return alerts;
}
