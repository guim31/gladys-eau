// -----------------------------------------------------------------------------
// The configuration filled in by the user (manifest `config_schema`).
//
// DEFAULT_CONFIG mirrors the manifest defaults (test/manifest.test.js checks
// it); normalizeConfig trims and types what the form sends, so the rest of the
// code never deals with an absent or malformed value.
// -----------------------------------------------------------------------------

import { LANGUAGES } from './i18n.js';

export { LANGUAGES };

/**
 * How many times the usual daily consumption makes a day "unusual" (see
 * src/history.js), or 'off' to rely on the distributor's alerts only.
 */
export const ABNORMAL_THRESHOLDS = ['2', '3', '5', 'off'];

export const DEFAULT_CONFIG = {
  provider: '',
  username: '',
  password: '',
  meter: '',
  abnormal_threshold: '3',
  language: 'fr',
};

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {Record<string, unknown>} [raw] the config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const threshold = ABNORMAL_THRESHOLDS.includes(String(raw.abnormal_threshold))
    ? String(raw.abnormal_threshold)
    : DEFAULT_CONFIG.abnormal_threshold;
  return {
    provider: text(raw.provider).toLowerCase(),
    // The customer areas sign in with the email address, case-insensitive.
    username: text(raw.username),
    // A password may legitimately start or end with a space: kept as typed.
    password: typeof raw.password === 'string' ? raw.password : '',
    meter: text(raw.meter).replace(/\s+/g, ''),
    abnormal_threshold: threshold,
    abnormalFactor: threshold === 'off' ? null : Number(threshold),
    language: LANGUAGES.includes(raw.language) ? raw.language : DEFAULT_CONFIG.language,
  };
}

/** True when a sign-in can be tried. */
export function isConfigured(config) {
  return Boolean(config.provider && config.username && config.password);
}

/** The values of the configuration that must never reach a log line. */
export function secretsOf(config) {
  return [config.password].filter((value) => value && value.length >= 3);
}
