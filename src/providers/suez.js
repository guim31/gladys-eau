// -----------------------------------------------------------------------------
// Suez, « Tout sur mon eau » (www.toutsurmoneau.fr): the customer area of the
// Suez water services in France.
//
// A port of pySuezV2 (jb101010-2/pySuez, Apache-2.0), the library of the Home
// Assistant `suez_water` integration:
//   1. GET  /mon-compte-en-ligne/je-me-connecte: session cookies and the CSRF
//      token, written in the page as an escaped JSON string
//      (`csrfToken\u0022\u003A\u0022<token>\u0022,\u0022targetUrl`);
//   2. POST the same form (`_csrf_token`, `tsme_user_login[_username]`,
//      `tsme_user_login[_password]`): a good password sets the `eZSESSID`
//      session cookie and redirects away from the form, maybe to another host
//      (the API calls follow that host);
//   3. the JSON API under /public-api, with the session cookie. An expired
//      session answers a redirect to the sign-in form: sign in again once.
// Volumes and indexes come in m³.
// -----------------------------------------------------------------------------

import { CannotConnectError, InvalidAuthError } from '../errors.js';
import { safeUrl } from '../http.js';
import { addMonths, isDate, monthStart } from '../time.js';

export const SUEZ_BASE = 'https://www.toutsurmoneau.fr';
export const LOGIN_PATH = '/mon-compte-en-ligne/je-me-connecte';
export const API = {
  METERS: '/public-api/cel-consumption/meters-list',
  TELEMETRY: '/public-api/cel-consumption/telemetry',
  PRICE: '/public-api/cel-consumption/get-price',
  ALERTS: '/public-api/contract/tile/alerts',
  CONTRACTS: '/public-api/user/donnees-contrats',
  PRICE_BY_TOWN: '/information/donnee/price/',
};
const SESSION_COOKIE = 'eZSESSID';
// The telemetry answers this code (with an error status) for a month without data.
const NO_DATA_CODE = '02';

const JSON_HEADERS = { Accept: 'application/json, text/javascript, */*; q=0.01' };

/**
 * The CSRF token of the sign-in page. The page carries it in a JSON string
 * escaped as \uXXXX sequences (what pySuez reads); a plain JSON or a hidden
 * form field are accepted too, in case the page is rewritten.
 * @param {string} page
 * @returns {string|null}
 */
export function extractCsrfToken(page) {
  const escaped = /csrfToken\\u0022\\u003A\\u0022(.*?)\\u0022,\\u0022targetUrl/.exec(page);
  if (escaped) {
    return escaped[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
  const plain = /"csrfToken"\s*:\s*"([^"]+)"/.exec(page);
  if (plain) {
    return plain[1];
  }
  const field =
    /name="_csrf_token"[^>]*value="([^"]+)"/.exec(page) ??
    /value="([^"]+)"[^>]*name="_csrf_token"/.exec(page);
  return field ? field[1] : null;
}

const isLoginUrl = (url) => typeof url === 'string' && url.includes(LOGIN_PATH);

const finite = (value) => {
  const number = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};

/**
 * @param {object} options
 * @param {ReturnType<import('../http.js').createHttpSession>} options.session
 * @param {string} [options.base] the customer area (tests: same, served by the fake web)
 */
export function createSuezClient({ session, base = SUEZ_BASE }) {
  let host = base;
  let credentials = null;
  // The meter list read to check the session, served once to meters().
  let checkedMeters = null;

  async function signIn() {
    const page = await session.request(`${host}${LOGIN_PATH}`, {
      headers: { Accept: 'text/html' },
    });
    if (!page.ok) {
      throw new CannotConnectError(`Suez sign-in page answered HTTP ${page.status}`);
    }
    const token = extractCsrfToken(page.text());
    if (!token) {
      throw new CannotConnectError('Suez sign-in page changed: no CSRF token found');
    }
    const formUrl = page.url;
    const answer = await session.request(formUrl, {
      method: 'POST',
      headers: { Accept: 'text/html,application/json' },
      form: {
        _csrf_token: token,
        'tsme_user_login[_username]': credentials.username,
        'tsme_user_login[_password]': credentials.password,
      },
    });
    if (answer.status === 401 || answer.status === 403) {
      throw new InvalidAuthError('Suez refused the email or the password');
    }
    if (answer.status >= 400) {
      throw new CannotConnectError(`Suez sign-in answered HTTP ${answer.status}`);
    }
    // A refused password shows the form again; an accepted one leaves it.
    if (isLoginUrl(answer.url) || !session.jar.get(SESSION_COOKIE, answer.url)) {
      throw new InvalidAuthError('Suez refused the email or the password');
    }
    host = new URL(answer.url).origin;
  }

  /** One API call; resolves the JSON, or null for "no data". */
  async function call(path, { query, noDataCode } = {}, retried = false) {
    const url = new URL(`${host}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const answer = await session.request(url.toString(), {
      headers: JSON_HEADERS,
      followRedirects: false,
    });
    if (answer.status >= 300 && answer.status < 400) {
      if (isLoginUrl(answer.location()) && !retried) {
        // The saved session expired: sign in again, once.
        await signIn();
        return call(path, { query, noDataCode }, true);
      }
      if (isLoginUrl(answer.location())) {
        throw new InvalidAuthError('Suez closed the session right after the sign-in');
      }
      throw new CannotConnectError(`Suez redirected ${safeUrl(url.toString())} unexpectedly`);
    }
    if (answer.status === 204) {
      return null;
    }
    if (!answer.ok) {
      if (noDataCode) {
        try {
          if (JSON.parse(answer.body)?.code === noDataCode) {
            return null;
          }
        } catch {
          // Not JSON: a real error.
        }
      }
      throw new CannotConnectError(`Suez answered HTTP ${answer.status} on ${path}`);
    }
    return answer.json();
  }

  return {
    key: 'suez',

    /**
     * Sign in, reusing the saved session cookie when it still works.
     * @param {{ username: string, password: string }} account
     * @param {{ cookie?: string, host?: string } | undefined} saved
     * @returns {Promise<{ cookie: string, host: string }>} what to save in /data
     */
    async login(account, saved) {
      credentials = account;
      if (saved?.cookie && saved?.host?.startsWith('https://')) {
        host = saved.host;
        session.jar.set(SESSION_COOKIE, saved.cookie, new URL(host).hostname);
        // A redirect to the form signs in again inside call().
        checkedMeters = await call(API.METERS);
      } else {
        await signIn();
        // The form may accept a sign-in the API then refuses: check it now.
        checkedMeters = await call(API.METERS);
      }
      return { cookie: session.jar.get(SESSION_COOKIE, `${host}/`) ?? '', host };
    },

    /** The meters of the account: one per delivery point (idPDS). */
    async meters() {
      const answer = checkedMeters ?? (await call(API.METERS));
      checkedMeters = null;
      const clients = answer?.content?.clientCompteursPro;
      if (!Array.isArray(clients)) {
        throw new CannotConnectError('Suez meter list changed: no clientCompteursPro');
      }
      const found = [];
      for (const client of clients) {
        for (const meter of client?.compteursPro ?? []) {
          if (meter?.idPDS === undefined || meter?.idPDS === null) {
            continue;
          }
          found.push({
            id: String(meter.idPDS),
            number: String(meter.matriculeCompteur ?? meter.idPDS),
            aliases: [meter.idPDS, meter.matriculeCompteur, meter.numeroBadge]
              .filter((value) => value !== undefined && value !== null && value !== '')
              .map(String),
          });
        }
      }
      return found;
    },

    /**
     * The daily readings from `from` to `to` (dates, inclusive), month by
     * month as pySuez asks them.
     * @returns {Promise<Array<{ date: string, liters: number, indexM3: number|null }>>}
     */
    async days(meter, from, to) {
      const readings = new Map();
      for (let month = monthStart(from); month <= to; month = addMonths(month, 1)) {
        const answer = await call(API.TELEMETRY, {
          query: {
            id_PDS: meter.id,
            mode: 'daily',
            start_date: month,
            end_date: addMonths(month, 1),
          },
          noDataCode: NO_DATA_CODE,
        });
        for (const measure of answer?.content?.measures ?? []) {
          const date = String(measure?.date ?? '').slice(0, 10);
          const volume = finite(measure?.volume);
          if (!isDate(date) || date < from || date > to || volume === null || volume < 0) {
            continue;
          }
          readings.set(date, {
            date,
            liters: Math.round(volume * 1000),
            indexM3: finite(measure?.index),
          });
        }
      }
      return [...readings.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    },

    /**
     * What Suez tells beside the readings: the average price and the alerts.
     * Each part is optional: a failure leaves it null.
     */
    async extras() {
      const extras = { priceEurPerM3: null, leak: null, overconsumption: null };
      try {
        const answer = await call(API.PRICE);
        extras.priceEurPerM3 = finite(answer?.content?.price);
        if (extras.priceEurPerM3 === null) {
          // KO_SERVICE: pySuez falls back to the price of the town.
          const contracts = await call(API.CONTRACTS);
          const insee = Array.isArray(contracts) ? contracts[0]?.inseeCode : null;
          if (insee && /^[0-9AB]{5}$/.test(String(insee))) {
            const town = await call(`${API.PRICE_BY_TOWN}${insee}`);
            extras.priceEurPerM3 = finite(town?.price);
          }
        }
      } catch (err) {
        if (err instanceof InvalidAuthError) {
          throw err;
        }
      }
      try {
        const answer = await call(API.ALERTS);
        const leak = answer?.content?.leak_alert?.status;
        const over = answer?.content?.overconsumption_alert?.status;
        extras.leak = typeof leak === 'string' ? leak !== 'NO_ALERT' : null;
        extras.overconsumption = typeof over === 'string' ? over !== 'NO_ALERT' : null;
      } catch (err) {
        if (err instanceof InvalidAuthError) {
          throw err;
        }
      }
      return extras;
    },
  };
}
