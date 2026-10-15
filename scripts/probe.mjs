#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Probe the real Suez and Saur customer areas, read-only, from a machine with
// Internet.
//
// The tests serve every answer from fixtures: they prove the port follows
// pySuezV2 and saur_client, not that the live sites still answer that way.
// This script checks the live side without an account:
//
//   node scripts/probe.mjs            (add --trace to list every request)
//
// For each distributor, it signs in with a made-up account and expects a
// clean refusal: "refused cleanly" means the site answered through the whole
// flow the integration expects up to the password check (Suez: the sign-in
// page, its CSRF token, the form; Saur: the token endpoint). Anything else (a
// page that changed, a network error) is printed with its class, a reason free
// of any secret, and every request (URL without query, status, redirect,
// headers with the cookies and tokens masked), so the failing step shows.
//
// With a real account, it goes further — still read-only:
//
//   EAU_PROVIDER=suez EAU_USERNAME=... EAU_PASSWORD=... node scripts/probe.mjs
//
// It signs in, counts the meters, the days of the last two weeks, and tells
// whether a price, an index and the alerts were read. It never prints the
// email, the password, a cookie, a token, a meter number nor an address.
// -----------------------------------------------------------------------------

import { CannotConnectError, InvalidAuthError } from '../src/errors.js';
import { createHttpSession } from '../src/http.js';
import { findProvider, PROVIDERS } from '../src/providers/index.js';
import { addDays, localDate } from '../src/time.js';

const TRACE = process.argv.includes('--trace');

const random = () => Math.random().toString(36).slice(2, 10);
const FAKE_ACCOUNT = {
  username: `probe.${random()}@example.com`,
  password: `Probe-${random()}!`,
};

function describe(err) {
  const kind = err?.name ?? 'Error';
  // The messages are built without secrets (src/errors.js); cut them short anyway.
  return `${kind}: ${String(err?.message ?? err).slice(0, 160)}`;
}

/** One line per request: method, URL without query, status, redirect, headers (secrets masked). */
function formatTrace(entries) {
  return entries
    .map((entry) => {
      const answer =
        entry.error ?? `${entry.status}${entry.location ? ` → ${entry.location}` : ''}`;
      const headers = Object.entries(entry.headers)
        .filter(([key]) => key !== 'User-Agent')
        .map(([key, value]) => `${key}: ${value}`)
        .join('; ');
      return `    ${entry.method} ${entry.url} → ${answer}${headers ? `  [${headers}]` : ''}`;
    })
    .join('\n');
}

async function probeRefusal(provider) {
  const entries = [];
  const session = createHttpSession({ trace: (entry) => entries.push(entry) });
  const client = provider.create({ session });
  let line;
  let failed = true;
  try {
    await client.login(FAKE_ACCOUNT, undefined);
    line = `${provider.key}: UNEXPECTED — a made-up account was accepted`;
  } catch (err) {
    if (err instanceof InvalidAuthError) {
      line = `${provider.key}: refused cleanly (${describe(err)})`;
      failed = false;
    } else if (err instanceof CannotConnectError) {
      line = `${provider.key}: FAILED before the password check (${describe(err)})`;
    } else {
      line = `${provider.key}: FAILED (${describe(err)})`;
    }
  }
  console.log(line);
  if (failed || TRACE) {
    console.log(formatTrace(entries));
  }
  return !failed;
}

async function probeAccount(provider, account) {
  const entries = [];
  const session = createHttpSession({ trace: (entry) => entries.push(entry) });
  const client = provider.create({ session });
  try {
    await client.login(account, undefined);
    console.log(`${provider.key}: signed in`);
    const meters = await client.meters();
    console.log(`${provider.key}: ${meters.length} meter(s)`);
    const today = localDate(Date.now());
    for (const [position, meter] of meters.entries()) {
      const days = await client.days(meter, addDays(today, -14), addDays(today, -1));
      const extras = await client.extras(meter);
      const withIndex = days.filter((day) => day.indexM3 !== null).length;
      console.log(
        `  meter #${position + 1}: ${days.length} day(s) over the last 14, last ${days.at(-1)?.date ?? 'none'}, ` +
          `${withIndex} with an index; price ${extras.priceEurPerM3 === null ? 'none' : 'read'}, ` +
          `leak alert ${extras.leak === null ? 'unknown' : 'read'}, ` +
          `separate index ${extras.index ? `read (${extras.index.date})` : 'none'}`,
      );
    }
  } catch (err) {
    console.log(`${provider.key}: FAILED (${describe(err)})`);
    console.log(formatTrace(entries));
    return false;
  } finally {
    if (TRACE) {
      console.log(formatTrace(entries));
    }
  }
  return true;
}

let ok = true;
for (const provider of PROVIDERS) {
  ok = (await probeRefusal(provider)) && ok;
}

const real = findProvider(process.env.EAU_PROVIDER ?? '');
if (real && process.env.EAU_USERNAME && process.env.EAU_PASSWORD) {
  ok =
    (await probeAccount(real, {
      username: process.env.EAU_USERNAME,
      password: process.env.EAU_PASSWORD,
    })) && ok;
}

process.exitCode = ok ? 0 : 1;
