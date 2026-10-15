// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  ACTION,
  createApp,
  REASON,
  registerHandlers,
  SCENE_ACTION,
  TRIGGER,
  WIDGET,
} from '../src/app.js';
import { ABNORMAL_THRESHOLDS, DEFAULT_CONFIG, LANGUAGES } from '../src/config.js';
import { PROVIDERS } from '../src/providers/index.js';
import { createMemoryStore } from '../src/store.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

const keysOf = (list) => (list ?? []).map((entry) => entry.key);
const field = (key) => manifest.config_schema.find((entry) => entry.key === key);

function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

/** The handlers the app registers, by kind. */
function registered() {
  const gladys = createFakeGladys();
  const seen = { action: [], sceneAction: [], widgetGet: [], widgetAction: [] };
  for (const kind of Object.keys(seen)) {
    const method = `on${kind[0].toUpperCase()}${kind.slice(1)}`;
    const original = gladys[method].bind(gladys);
    gladys[method] = (key, handler) => {
      seen[kind].push(key);
      return original(key, handler);
    };
  }
  registerHandlers(gladys, createApp({ gladys, store: createMemoryStore(), timers: false }));
  return seen;
}

test('every manifest action has a registered handler, and vice versa', () => {
  assert.deepEqual(keysOf(manifest.actions).sort(), registered().action.sort());
  assert.deepEqual(keysOf(manifest.actions).sort(), Object.values(ACTION).sort());
});

test('every scene action and widget has its handler, and vice versa', () => {
  const seen = registered();
  assert.deepEqual(keysOf(manifest.scene_actions), seen.sceneAction);
  assert.deepEqual(keysOf(manifest.scene_actions), Object.values(SCENE_ACTION));
  assert.deepEqual(keysOf(manifest.widgets), seen.widgetGet);
  assert.deepEqual(keysOf(manifest.widgets), Object.values(WIDGET));
  // The widget has no button: no action handler expected.
  assert.deepEqual(seen.widgetAction, []);
});

test('every scene trigger the code fires is declared, and every declared one is fired', () => {
  // An undeclared key is a 404 on publishSceneEvent; a declared key nobody
  // fires is a dead card in the scene editor.
  assert.deepEqual(keysOf(manifest.scene_triggers).sort(), Object.values(TRIGGER).sort());
});

test('the trigger filters and variables match the keys of the event', () => {
  const trigger = manifest.scene_triggers.find((entry) => entry.key === TRIGGER.ABNORMAL);
  // The core matches the filters on the event keys of the same name.
  assert.deepEqual(keysOf(trigger.fields), ['device', 'reason']);
  assert.deepEqual(
    trigger.fields[1].options.map((option) => option.value),
    Object.values(REASON),
  );
  assert.deepEqual(keysOf(trigger.variables), [
    'reason',
    'provider',
    'date',
    'liters',
    'usual_liters',
  ]);
});

test('the scene action declares the outputs the code returns', () => {
  const action = manifest.scene_actions.find((entry) => entry.key === SCENE_ACTION.SUMMARY);
  assert.deepEqual(keysOf(action.outputs).sort(), [
    'abnormal',
    'index_m3',
    'last_date',
    'last_day_liters',
    'last_year_change_percent',
    'month_m3',
    'previous_month_change_percent',
    'year_m3',
  ]);
  assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
});

test('the manifest needs Gladys 5.1.0 (widgets, scene declarations), as a device integration', () => {
  // No widget button opens a form (#3168): 5.2.0 is not needed.
  assert.ok(isAtLeast(minGladysVersion(), [5, 1, 0]), manifest.gladys_version);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.type, 'device');
});

test('the name is short and the same in every language', () => {
  assert.equal(manifest.name, 'Suez / Saur (eau)');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30, manifest.name);
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const entry of manifest.config_schema) {
    if (entry.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[entry.key], entry.default, `DEFAULT_CONFIG.${entry.key}`);
    }
  }
  assert.equal(DEFAULT_CONFIG.language, 'fr', 'French by default (Guilhem, 12/10/2026)');
});

test('the configuration lists the providers, the thresholds and the languages of the code', () => {
  assert.deepEqual(
    field('provider').options.map((option) => option.value),
    PROVIDERS.map((provider) => provider.key),
  );
  for (const option of field('provider').options) {
    // Brand names are not translated.
    assert.equal(new Set(Object.values(option.label)).size, 1, option.value);
  }
  assert.deepEqual(
    field('abnormal_threshold').options.map((option) => option.value),
    ABNORMAL_THRESHOLDS,
  );
  assert.deepEqual(
    field('language').options.map((option) => option.value),
    LANGUAGES,
  );
  assert.equal(field('password').type, 'secret');
  assert.equal(field('meter').required, false);
});

test('no action field is a secret, none relies on a default', () => {
  // GladysAssistant/Gladys#3154 and #3155: a secret action field cannot be
  // filled in, and an action applies no default.
  for (const action of manifest.actions) {
    for (const entry of action.fields ?? []) {
      assert.notEqual(entry.type, 'secret', `${action.key}.${entry.key}`);
      assert.equal(entry.default, undefined, `${action.key}.${entry.key}`);
    }
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120, action.key);
  }
});

test('number fields would need integer bounds: there are none', () => {
  // The core renders `number` fields without `step` (CLAUDE.md).
  assert.deepEqual(
    allFields.filter((entry) => entry.type === 'number'),
    [],
  );
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((entry) => entry.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.ok(!(section.key in DEFAULT_CONFIG), `section "${section.key}" stores no value`);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('dynamic selects declare a source and no static options', () => {
  const dynamic = allFields.filter((entry) => entry.source !== undefined);
  assert.equal(dynamic.length, 3);
  for (const entry of dynamic) {
    assert.equal(entry.source, 'devices');
    assert.equal(entry.options, undefined, `field "${entry.key}": source and options together`);
  }
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.equal(manifest.docker_image, `ghcr.io/guim31/gladys-eau:${manifest.version}`);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/guim31/gladys-eau/main/cover.png',
  );
});

test('the catalog description holds 10 to 100 characters per language', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters`,
    );
  }
});

test('field placeholders are multi-language objects', () => {
  const withPlaceholder = allFields.filter((entry) => entry.placeholder !== undefined);
  assert.ok(withPlaceholder.length > 0);
  for (const entry of withPlaceholder) {
    assert.equal(typeof entry.placeholder, 'object', `field "${entry.key}": placeholder`);
  }
});
