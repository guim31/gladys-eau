// -----------------------------------------------------------------------------
// The daily readings of a meter and what is computed from them: the read
// window, the merge, the totals, the comparisons, the unusual-consumption
// check.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkUnusual,
  emptyMeterRecord,
  fetchWindow,
  mergeReadings,
  normalizeMeterRecord,
  summarize,
  UNUSUAL,
} from '../src/history.js';
import { addDays } from '../src/time.js';

/** A record with `liters(date)` for every day from `from` to `to`. */
function recordOf(from, to, liters) {
  const record = emptyMeterRecord();
  const readings = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const value = liters(date);
    if (value !== null) {
      readings.push({ date, liters: value, indexM3: null });
    }
  }
  mergeReadings(record, readings);
  return record;
}

test('the first read asks 13 months, the next ones from a few days before the last', () => {
  assert.deepEqual(fetchWindow(emptyMeterRecord(), '2026-10-14'), {
    from: '2025-10-01',
    to: '2026-10-13',
  });
  const record = recordOf('2026-09-01', '2026-10-12', () => 200);
  assert.deepEqual(fetchWindow(record, '2026-10-14', 5), { from: '2026-10-07', to: '2026-10-13' });
  // Never more than 13 months back, even after a long stop.
  const old = recordOf('2023-01-01', '2023-01-31', () => 200);
  assert.equal(fetchWindow(old, '2026-10-14').from, '2025-10-01');
});

test('merging keeps the corrected value, the latest index, and two years at most', () => {
  const record = emptyMeterRecord();
  assert.deepEqual(
    mergeReadings(record, [
      { date: '2026-10-12', liters: 200, indexM3: 100.1 },
      { date: '2026-10-13', liters: 210, indexM3: 100.31 },
    ]),
    ['2026-10-12', '2026-10-13'],
  );
  assert.deepEqual(
    mergeReadings(record, [{ date: '2026-10-13', liters: 215, indexM3: null }]),
    ['2026-10-13'],
    'a correction of the distributor',
  );
  assert.deepEqual(record.index, { m3: 100.31, date: '2026-10-13' });
  mergeReadings(record, [], { m3: 101, date: '2026-10-14' });
  assert.deepEqual(record.index, { m3: 101, date: '2026-10-14' });

  const long = recordOf('2023-01-01', '2026-10-13', () => 100);
  assert.equal(Object.keys(long.days).length, 800);
});

test('the month and the year so far, in m³', () => {
  const record = recordOf('2025-10-01', '2026-10-13', () => 250);
  const summary = summarize(record, '2026-10-14');
  assert.deepEqual(summary.lastDay, { date: '2026-10-13', liters: 250 });
  assert.equal(summary.monthM3, 3.25);
  // 1 January to 13 October: 286 days.
  assert.equal(summary.yearM3, 71.5);
  assert.equal(summary.recent.length, 14);
});

test('the month is compared with the same days of last month and of last year', () => {
  const record = recordOf('2025-10-01', '2026-10-13', (date) => {
    if (date >= '2026-10-01') {
      return 300;
    }
    if (date >= '2026-09-01') {
      return 250;
    }
    return 200;
  });
  const { comparison } = summarize(record, '2026-10-14');
  assert.deepEqual(comparison, {
    throughDay: 13,
    currentM3: 3.9,
    previousMonthM3: 3.25,
    lastYearM3: 2.6,
    previousMonthChange: 20,
    lastYearChange: 50,
  });
});

test('no comparison against a period with too few readings', () => {
  const record = recordOf('2026-09-20', '2026-10-13', () => 200);
  const { comparison } = summarize(record, '2026-10-14');
  assert.equal(comparison.previousMonthChange, null, 'September has 11 of its 13 days: too few');
  assert.equal(comparison.lastYearChange, null);
  // On the first of the month, the last known day is in the previous month.
  assert.equal(summarize(record, '2026-11-01').comparison, null);
});

test('unusual consumption: three days in a row far above the usual level', () => {
  const steady = (date) => 200 + (Number(date.slice(8)) % 3) * 10;
  const leak = (date) => (date >= '2026-10-11' ? 950 : steady(date));
  const normal = recordOf('2026-09-01', '2026-10-13', steady);
  assert.equal(checkUnusual(normal, '2026-10-14', 3).suspected, false);

  const leaking = recordOf('2026-09-01', '2026-10-13', leak);
  assert.deepEqual(checkUnusual(leaking, '2026-10-14', 3), {
    suspected: true,
    date: '2026-10-13',
    liters: 950,
    usualLiters: 210,
  });
  assert.equal(checkUnusual(leaking, '2026-10-14', 5).suspected, false, '950 < 5 × 210');
  assert.equal(checkUnusual(leaking, '2026-10-14', null).suspected, false, 'off');
});

test('unusual consumption: one big day, an old episode or a short history are not', () => {
  const steady = () => 200;
  const oneDay = recordOf('2026-09-01', '2026-10-13', (date) =>
    date === '2026-10-13' ? 2000 : steady(),
  );
  assert.equal(checkUnusual(oneDay, '2026-10-14', 3).suspected, false, 'filling a pool');

  const leak = (date) => (date >= '2026-09-20' ? 900 : steady());
  const old = recordOf('2026-08-01', '2026-09-22', leak);
  assert.equal(checkUnusual(old, '2026-10-14', 3).suspected, false, 'readings stopped weeks ago');

  const short = recordOf('2026-10-01', '2026-10-13', (date) => (date >= '2026-10-11' ? 900 : 200));
  assert.equal(
    checkUnusual(short, '2026-10-14', 3).suspected,
    false,
    `< ${UNUSUAL.MIN_BASELINE_DAYS} days`,
  );

  // A near-empty house: three times 2 L is not a leak, the margin is.
  const empty = recordOf('2026-09-01', '2026-10-13', (date) => (date >= '2026-10-11' ? 60 : 2));
  assert.equal(checkUnusual(empty, '2026-10-14', 3).suspected, false);
});

test('a record read back from /data is made safe', () => {
  assert.deepEqual(normalizeMeterRecord(null), emptyMeterRecord());
  assert.deepEqual(
    normalizeMeterRecord({
      days: { '2026-10-13': 200, nonsense: 3, '2026-10-12': -4, '2026-10-11': 'x' },
      index: { m3: 'x' },
      publishedUntil: '2026-10-13',
      episode: { reason: 'leak_alert', since: '2026-10-12' },
    }),
    {
      days: { '2026-10-13': 200 },
      index: null,
      publishedUntil: '2026-10-13',
      episode: { reason: 'leak_alert', since: '2026-10-12' },
    },
  );
});
