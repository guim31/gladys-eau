// -----------------------------------------------------------------------------
// Calendar dates, without a library.
//
// Suez and Saur count days in French time: a reading "of 12 October" covers
// that day in Paris, whatever the container's zone. The helpers below read
// the Paris wall clock through Intl, and do calendar arithmetic on plain
// YYYY-MM-DD strings.
// -----------------------------------------------------------------------------

export const DAY_MS = 24 * 3600 * 1000;
export const DISTRIBUTOR_TIME_ZONE = 'Europe/Paris';

const formatters = new Map();

function formatter(timeZone) {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** The local date (YYYY-MM-DD) of an instant in a zone. */
export function localDate(ms, timeZone = DISTRIBUTOR_TIME_ZONE) {
  const parts = {};
  for (const { type, value } of formatter(timeZone).formatToParts(new Date(ms))) {
    parts[type] = value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A date shifted by whole days. */
export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A date shifted by whole months, on the first of the month. */
export function addMonths(date, months) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

/** The first day of the month of a date. */
export function monthStart(date) {
  return `${date.slice(0, 7)}-01`;
}

/** The number of days of the month of a date. */
export function daysInMonth(date) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Whole days from one date to another (positive when `to` is later). */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/**
 * The instant a reading of a day is filed at in Gladys: noon UTC, which is
 * the same calendar day in France all year round (13:00 or 14:00), so the
 * history shows each litre on the day it was used.
 */
export function readingInstant(date) {
  return `${date}T12:00:00.000Z`;
}
