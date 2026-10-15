// -----------------------------------------------------------------------------
// What the integration keeps between restarts, in /data (the only writable
// volume of the container):
//   - the session of each account (the Suez session cookie, the Saur token),
//     so a restart does not sign in again for nothing;
//   - per meter, its daily readings (up to two years), its last index, how
//     far its history reached Gladys and the abnormal-consumption episode in
//     progress, so a restart neither replays the history nor fires an
//     episode twice.
// The file holds a session: it is written owner-only (0600), atomically (a
// temporary file renamed over the old one), and never logged.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeMeterRecord } from './history.js';

const VERSION = 1;

export function emptyState() {
  return { version: VERSION, sessions: {}, meters: {} };
}

/** The key of one account: the distributor and the email, hashed (no address in the file). */
export function identityOf(providerKey, username) {
  return createHash('sha256')
    .update(
      `${providerKey}\n${String(username ?? '')
        .trim()
        .toLowerCase()}`,
    )
    .digest('hex')
    .slice(0, 32);
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) {
    return emptyState();
  }
  const meters = {};
  for (const [key, record] of Object.entries(raw.meters ?? {})) {
    meters[key] = normalizeMeterRecord(record);
  }
  return {
    version: VERSION,
    sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
    meters,
  };
}

/**
 * @param {string} [directory] default: $DATA_DIR, else /data
 */
export function createFileStore(directory = process.env.DATA_DIR || '/data') {
  const path = join(directory, 'eau-state.json');
  return {
    path,
    async load() {
      try {
        return normalize(JSON.parse(await readFile(path, 'utf8')));
      } catch {
        return emptyState();
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

/** The same contract in memory (tests). */
export function createMemoryStore(initial = emptyState()) {
  let saved = structuredClone(initial);
  return {
    async load() {
      return normalize(structuredClone(saved));
    },
    async save(state) {
      saved = structuredClone(state);
    },
    get saved() {
      return saved;
    },
  };
}
