// -----------------------------------------------------------------------------
// A fake Saur API on the fake web, answering with the EyeOnSaur mocks (see
// test/fixtures/saur): the bearer token, the contracts, the days of a month
// and the last index. The days are generated from the test clock.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { steadyDays } from './suez-site.js';

const BASE = 'https://apib2c.azure.saurclient.fr';

export function saurFixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/saur/${name}`, import.meta.url), 'utf8'));
}

export const SAUR_ACCOUNT = { username: 'johndoe@example.com', password: 'Saur-Secret-7' };
const CLIENT_ID = saurFixture('auth.json').clientId;

/**
 * @param {ReturnType<import('./fake-web.js').createFakeWeb>} web
 * @param {object} options
 * @param {() => string} options.dataUntil the last day with a reading (YYYY-MM-DD)
 * @param {(date: string) => number|null} [options.liters]
 * @param {object} [options.area] the contracts answer
 * @param {number} [options.expiresIn] token lifetime (s)
 */
export function serveSaur(web, options) {
  const api = {
    password: SAUR_ACCOUNT.password,
    liters: options.liters ?? steadyDays,
    area: options.area ?? saurFixture('area.json'),
    tokens: new Set(),
    logins: 0,
    down: false,
  };
  const authorized = (request) =>
    api.tokens.has(String(request.headers.authorization ?? '').replace(/^Bearer /, ''));
  const guard = (handler) => (request) => {
    if (api.down) {
      return { status: 503, text: 'Service Unavailable' };
    }
    return authorized(request) ? handler(request) : { status: 401, json: { message: 'expired' } };
  };

  web.on('POST', `${BASE}/admin/v2/auth`, (request) => {
    if (api.down) {
      return { status: 503, text: 'Service Unavailable' };
    }
    const body = request.json ?? {};
    if (
      body.username !== SAUR_ACCOUNT.username ||
      body.password !== api.password ||
      body.client_id !== 'frontjs-client'
    ) {
      return { status: 401, json: { message: 'Invalid credentials' } };
    }
    api.logins += 1;
    const token = `token-${api.logins}-${Math.random().toString(36).slice(2, 12)}`;
    api.tokens.add(token);
    const answer = saurFixture('auth.json');
    answer.token.access_token = token;
    answer.token.expires_in = String(options.expiresIn ?? 900);
    return { json: answer };
  });
  web.on(
    'GET',
    `${BASE}/admin/users/v2/website_areas/${CLIENT_ID}`,
    guard(() => ({ json: api.area })),
  );
  web.on(
    'GET',
    /\/deli\/section_subscription\/[^/]+\/consumptions\/monthly\?/,
    guard((request) => {
      const year = Number(request.query.year);
      const month = Number(request.query.month);
      const until = options.dataUntil();
      const consumptions = [];
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= days; day += 1) {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const liters = date <= until ? api.liters(date) : null;
        if (liters === null) {
          continue;
        }
        const end = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
        consumptions.push({
          quality: 0,
          startDate: `${date}T00:00:00`,
          endDate: `${end}T00:00:00`,
          value: liters / 1000,
          realConsumptionValue: 0,
          estimateConsumptionValue: 0,
          rangeType: 'Day',
        });
      }
      if (consumptions.length === 0) {
        // EyeOnSaur sets such months aside: the API answers an error.
        return { status: 404, json: { message: 'No consumption' } };
      }
      return {
        json: {
          consumptions,
          isRemoteReading: true,
          isEstimateConsumption: false,
          isYearlyViewOnly: false,
        },
      };
    }),
  );
  web.on(
    'GET',
    /\/deli\/section_subscriptions\/[^/]+\/meter_indexes\/last$/,
    guard(() => ({
      json: { ...saurFixture('last.json'), readingDate: `${options.dataUntil()}T00:00:00` },
    })),
  );
  return api;
}

/** The contracts answer with only the first subscription of the fixture. */
export function singleMeterArea() {
  const area = saurFixture('area.json');
  area.clients = area.clients.slice(0, 1);
  area.clients[0].customerAccounts = area.clients[0].customerAccounts.slice(0, 1);
  area.clients[0].customerAccounts[0].sectionSubscriptions =
    area.clients[0].customerAccounts[0].sectionSubscriptions.slice(0, 1);
  return area;
}
