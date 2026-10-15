// -----------------------------------------------------------------------------
// Saur, « Mon espace client » (mon-espace.saurclient.fr), through the JSON API
// behind it (apib2c.azure.saurclient.fr).
//
// A port of saur_client (cekage/Saur_fr_client, MIT), the library of the
// EyeOnSaur Home Assistant integration (cekage/eyeonsaur-ha, MIT), whose test
// answers are the fixtures of test/fixtures/saur:
//   1. POST /admin/v2/auth (JSON: username, password, the web front's client
//      id): a bearer token valid 15 minutes, the client id and the default
//      subscription;
//   2. GET /admin/users/v2/website_areas/<clientId>: the contracts and their
//      subscriptions (one per meter, `sectionSubscriptionId`);
//   3. GET /deli/section_subscription/<id>/consumptions/monthly?year&month:
//      the days of a month (m³); a month without data answers an error;
//   4. GET /deli/section_subscriptions/<id>/meter_indexes/last: the index.
// A 401 or 403 means the token expired: sign in again, once.
// -----------------------------------------------------------------------------

import { CannotConnectError, InvalidAuthError } from '../errors.js';
import { addMonths, isDate, monthStart } from '../time.js';

export const SAUR_BASE = 'https://apib2c.azure.saurclient.fr';
const FRONT = 'https://mon-espace.saurclient.fr';
// Renew a little before the announced expiry.
const TOKEN_MARGIN_MS = 60 * 1000;
const DEFAULT_TOKEN_TTL_S = 900;

const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null;

/**
 * @param {object} options
 * @param {ReturnType<import('../http.js').createHttpSession>} options.session
 * @param {string} [options.base]
 * @param {() => number} [options.now]
 */
export function createSaurClient({ session, base = SAUR_BASE, now = () => Date.now() }) {
  let credentials = null;
  let auth = null;

  const headers = () => ({
    Accept: 'application/json',
    Referer: `${FRONT}/`,
    Origin: FRONT,
    ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}),
  });

  async function signIn() {
    auth = null;
    const answer = await session.request(`${base}/admin/v2/auth`, {
      method: 'POST',
      headers: headers(),
      // What the web front sends (saur_client): the captcha fields are fixed.
      json: {
        username: credentials.username,
        password: credentials.password,
        client_id: 'frontjs-client',
        grant_type: 'password',
        scope: 'api-scope',
        isRecaptchaV3: true,
        captchaToken: true,
      },
    });
    if ([400, 401, 403].includes(answer.status)) {
      throw new InvalidAuthError('Saur refused the email or the password');
    }
    if (!answer.ok) {
      throw new CannotConnectError(`Saur sign-in answered HTTP ${answer.status}`);
    }
    const data = answer.json();
    const token = data?.token?.access_token;
    if (typeof token !== 'string' || !token || !data?.clientId) {
      throw new InvalidAuthError('Saur did not accept the sign-in (no token)');
    }
    const ttl = finite(data.token.expires_in) ?? DEFAULT_TOKEN_TTL_S;
    auth = {
      token,
      expiresAt: now() + ttl * 1000,
      clientId: String(data.clientId),
      defaultSectionId: data.defaultSectionId ? String(data.defaultSectionId) : null,
    };
  }

  /** One API call; resolves the JSON, or null for an empty or missing answer. */
  async function call(path, { missingIsEmpty = false } = {}, retried = false) {
    if (!auth || auth.expiresAt - TOKEN_MARGIN_MS <= now()) {
      await signIn();
    }
    const answer = await session.request(`${base}${path}`, { headers: headers() });
    if ((answer.status === 401 || answer.status === 403) && !retried) {
      await signIn();
      return call(path, { missingIsEmpty }, true);
    }
    if (answer.status === 401 || answer.status === 403) {
      throw new InvalidAuthError('Saur refused the session right after the sign-in');
    }
    if (answer.status === 204) {
      return null;
    }
    if (!answer.ok) {
      // EyeOnSaur sets aside the months the API answers with an error: no data.
      if (missingIsEmpty && answer.status >= 400 && answer.status < 500) {
        return null;
      }
      throw new CannotConnectError(`Saur answered HTTP ${answer.status} on ${path.split('?')[0]}`);
    }
    return answer.json();
  }

  return {
    key: 'saur',

    /**
     * Sign in, reusing the saved token while it is valid.
     * @param {{ username: string, password: string }} account
     * @param {object|undefined} saved
     * @returns {Promise<object>} what to save in /data
     */
    async login(account, saved) {
      credentials = account;
      if (
        typeof saved?.token === 'string' &&
        typeof saved?.expiresAt === 'number' &&
        saved.expiresAt - TOKEN_MARGIN_MS > now() &&
        saved.clientId
      ) {
        auth = { ...saved };
      } else {
        await signIn();
      }
      return { ...auth };
    },

    /** The meters of the account: one per active subscription. */
    async meters() {
      const area = await call(`/admin/users/v2/website_areas/${encodeURIComponent(auth.clientId)}`);
      const found = new Map();
      for (const client of area?.clients ?? []) {
        for (const account of client?.customerAccounts ?? []) {
          for (const subscription of account?.sectionSubscriptions ?? []) {
            const id = subscription?.sectionSubscriptionId;
            if (!id || subscription.isContractTerminated === true) {
              continue;
            }
            found.set(String(id), {
              id: String(id),
              number: String(subscription.serialNumber || subscription.registrationNumber || id),
              aliases: [id, subscription.serialNumber, subscription.registrationNumber]
                .filter((value) => value !== undefined && value !== null && value !== '')
                .map(String),
            });
          }
        }
      }
      if (found.size === 0 && auth.defaultSectionId) {
        // An account without the contracts page: its default subscription.
        found.set(auth.defaultSectionId, {
          id: auth.defaultSectionId,
          number: auth.defaultSectionId,
          aliases: [auth.defaultSectionId],
        });
      }
      return [...found.values()];
    },

    /**
     * The daily readings from `from` to `to` (dates, inclusive), month by
     * month. Saur gives no index per day: the last index comes apart.
     * @returns {Promise<Array<{ date: string, liters: number, indexM3: null }>>}
     */
    async days(meter, from, to) {
      const readings = new Map();
      for (let month = monthStart(from); month <= to; month = addMonths(month, 1)) {
        const [year, number] = month.split('-').map(Number);
        const answer = await call(
          `/deli/section_subscription/${encodeURIComponent(meter.id)}/consumptions/monthly?year=${year}&month=${number}`,
          { missingIsEmpty: true },
        );
        for (const entry of answer?.consumptions ?? []) {
          const date = String(entry?.startDate ?? '').slice(0, 10);
          const value = finite(entry?.value);
          if (entry?.rangeType && entry.rangeType !== 'Day') {
            continue;
          }
          if (!isDate(date) || date < from || date > to || value === null || value < 0) {
            continue;
          }
          readings.set(date, { date, liters: Math.round(value * 1000), indexM3: null });
        }
      }
      return [...readings.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    },

    /** The last index of the meter. Saur publishes no price nor alert there. */
    async extras(meter) {
      const extras = { priceEurPerM3: null, leak: null, overconsumption: null, index: null };
      const last = await call(
        `/deli/section_subscriptions/${encodeURIComponent(meter.id)}/meter_indexes/last`,
        { missingIsEmpty: true },
      );
      const value = finite(last?.indexValue);
      const date = String(last?.readingDate ?? '').slice(0, 10);
      if (value !== null && value >= 0 && isDate(date)) {
        extras.index = { m3: value, date };
      }
      return extras;
    },
  };
}
