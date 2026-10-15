// -----------------------------------------------------------------------------
// The daily readings of a meter, kept in /data, and what is computed from
// them: the totals of the month and of the year, the comparison with the
// previous month and with last year, and the "unusual consumption" check.
//
// Both distributors give one figure per day (litres used that day), a day or
// two late. Neither gives hourly data through these APIs, so a leak cannot be
// seen as a night-time flow here: the check below looks for several days in a
// row far above the usual level, which is how a running toilet or a broken
// pipe shows in daily readings. Suez also sends its own leak alert, computed
// from the meter's finer data (src/providers/suez.js).
// -----------------------------------------------------------------------------

import { addDays, addMonths, daysBetween, daysInMonth, monthStart } from './time.js';

// Days kept: two years and a little, enough for "same month last year".
const KEEP_DAYS = 800;
// Unusual consumption: the last days checked, how many days make the usual
// level and the least of them needed, the margin a day must also exceed (a
// near-empty house would otherwise flag a single shower), and how old the
// last of those days may be (an old episode is not news).
export const UNUSUAL = {
  DAYS: 3,
  BASELINE_DAYS: 28,
  MIN_BASELINE_DAYS: 14,
  MIN_EXCESS_LITERS: 100,
  MAX_AGE_DAYS: 7,
};
// A comparison needs this share of the days of the reference period.
const MIN_COVERAGE = 0.8;

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The empty record of a meter. */
export function emptyMeterRecord() {
  return { days: {}, index: null, publishedUntil: null, episode: null };
}

/** A record read back from /data, made safe. */
export function normalizeMeterRecord(raw) {
  const record = emptyMeterRecord();
  if (!raw || typeof raw !== 'object') {
    return record;
  }
  if (raw.days && typeof raw.days === 'object') {
    for (const [date, liters] of Object.entries(raw.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(liters) && liters >= 0) {
        record.days[date] = liters;
      }
    }
  }
  if (raw.index && Number.isFinite(raw.index.m3) && typeof raw.index.date === 'string') {
    record.index = { m3: raw.index.m3, date: raw.index.date };
  }
  if (typeof raw.publishedUntil === 'string') {
    record.publishedUntil = raw.publishedUntil;
  }
  if (raw.episode && typeof raw.episode === 'object' && typeof raw.episode.reason === 'string') {
    record.episode = { reason: raw.episode.reason, since: String(raw.episode.since ?? '') };
  }
  return record;
}

/** The dates of a record, oldest first. */
export function knownDates(record) {
  return Object.keys(record.days).sort();
}

/** The last day with a reading, or null. */
export function lastKnownDay(record) {
  return knownDates(record).at(-1) ?? null;
}

/**
 * The days to ask the distributor: from a few days before the last known one
 * (the distributors correct their latest readings) to yesterday, or the last
 * 13 months on the first read (the year so far and "same month last year").
 * @returns {{ from: string, to: string }}
 */
export function fetchWindow(record, today, overlapDays = 5) {
  const to = addDays(today, -1);
  const first = addMonths(monthStart(today), -12);
  const last = lastKnownDay(record);
  const from = last ? addDays(last, -overlapDays) : first;
  return { from: from < first ? first : from > to ? to : from, to };
}

/**
 * Merge new readings into a record. Returns the dates whose value changed.
 * @param {object} record
 * @param {Array<{ date: string, liters: number, indexM3: number|null }>} readings
 * @param {{ m3: number, date: string } | null} [index] a separate index (Saur)
 */
export function mergeReadings(record, readings, index = null) {
  const changed = [];
  for (const reading of readings) {
    if (record.days[reading.date] !== reading.liters) {
      record.days[reading.date] = reading.liters;
      changed.push(reading.date);
    }
    if (
      reading.indexM3 !== null &&
      reading.indexM3 !== undefined &&
      (!record.index || reading.date >= record.index.date)
    ) {
      record.index = { m3: reading.indexM3, date: reading.date };
    }
  }
  if (index && (!record.index || index.date >= record.index.date)) {
    record.index = { m3: index.m3, date: index.date };
  }
  const dates = knownDates(record);
  for (const date of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) {
    delete record.days[date];
  }
  return changed;
}

/** Sum the litres of the known days in [from, to]; with the count of known days. */
function sumDays(record, from, to) {
  let liters = 0;
  let count = 0;
  for (const [date, value] of Object.entries(record.days)) {
    if (date >= from && date <= to) {
      liters += value;
      count += 1;
    }
  }
  return { liters, count };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A change in percent, or null without a usable reference. */
function change(current, reference) {
  if (reference === null || reference <= 0) {
    return null;
  }
  return Math.round(((current - reference) / reference) * 100);
}

/**
 * The same days of another month: day 1 to `day` of the month `offset`
 * months away, cut to that month's length.
 */
function sameDays(monthFirst, offset, day) {
  const first = addMonths(monthFirst, offset);
  const last = addDays(first, Math.min(day, daysInMonth(first)) - 1);
  return { from: first, to: last };
}

function referenceLiters(record, period) {
  const { liters, count } = sumDays(record, period.from, period.to);
  const days = daysBetween(period.from, period.to) + 1;
  return count >= Math.ceil(days * MIN_COVERAGE) ? liters : null;
}

/**
 * The figures of a meter, as of `today` (a Paris date).
 * @returns {object} lastDay, month, year, comparison, recent (last 14 days)
 */
export function summarize(record, today) {
  const lastDate = lastKnownDay(record);
  const lastDay = lastDate ? { date: lastDate, liters: record.days[lastDate] } : null;
  const month = monthStart(today);
  const year = `${today.slice(0, 4)}-01-01`;
  const monthLiters = sumDays(record, month, today).liters;
  const yearLiters = sumDays(record, year, today).liters;

  // Month to date against the same days: the comparison stops at the last
  // known day, so the missing days of the current month weigh on neither side.
  let comparison = null;
  if (lastDate && lastDate >= month) {
    const day = Number(lastDate.slice(8, 10));
    const current = sumDays(record, month, lastDate).liters;
    const previous = referenceLiters(record, sameDays(month, -1, day));
    const lastYear = referenceLiters(record, sameDays(month, -12, day));
    comparison = {
      throughDay: day,
      currentM3: round(current / 1000, 3),
      previousMonthM3: previous === null ? null : round(previous / 1000, 3),
      lastYearM3: lastYear === null ? null : round(lastYear / 1000, 3),
      previousMonthChange: change(current, previous),
      lastYearChange: change(current, lastYear),
    };
  }

  const recent = [];
  if (lastDate) {
    for (let date = addDays(lastDate, -13); date <= lastDate; date = addDays(date, 1)) {
      if (record.days[date] !== undefined) {
        recent.push({ date, liters: record.days[date] });
      }
    }
  }
  return {
    lastDay,
    monthM3: round(monthLiters / 1000, 3),
    yearM3: round(yearLiters / 1000, 3),
    index: record.index,
    comparison,
    recent,
  };
}

/**
 * The unusual-consumption check: the last UNUSUAL.DAYS days known, in a row
 * and recent, each at least `factor` times the usual level (the median of
 * the days before them) and UNUSUAL.MIN_EXCESS_LITERS above it.
 * @returns {{ suspected: boolean, date?: string, liters?: number, usualLiters?: number }}
 */
export function checkUnusual(record, today, factor) {
  if (!factor) {
    return { suspected: false };
  }
  const dates = knownDates(record);
  const last = dates.at(-1);
  if (!last || daysBetween(last, today) > UNUSUAL.MAX_AGE_DAYS) {
    return { suspected: false };
  }
  const window = [];
  for (let i = UNUSUAL.DAYS - 1; i >= 0; i -= 1) {
    const date = addDays(last, -i);
    if (record.days[date] === undefined) {
      return { suspected: false };
    }
    window.push(record.days[date]);
  }
  const firstChecked = addDays(last, -(UNUSUAL.DAYS - 1));
  const baselineFrom = addDays(firstChecked, -UNUSUAL.BASELINE_DAYS);
  const baseline = dates
    .filter((date) => date >= baselineFrom && date < firstChecked)
    .map((date) => record.days[date]);
  if (baseline.length < UNUSUAL.MIN_BASELINE_DAYS) {
    return { suspected: false };
  }
  const usual = median(baseline);
  const suspected = window.every(
    (liters) => liters >= usual * factor && liters >= usual + UNUSUAL.MIN_EXCESS_LITERS,
  );
  return {
    suspected,
    date: last,
    liters: record.days[last],
    usualLiters: Math.round(usual),
  };
}
