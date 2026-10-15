// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// fixtures: the Suez meter (price and leak alert) and the three Saur
// subscriptions of the EyeOnSaur mocks — in every feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorld, SAUR_CONFIG, SUEZ_CONFIG } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

async function discovered(config) {
  const world = createWorld({ config });
  try {
    await world.connect();
    return world.gladys.fake.discoveredDevices;
  } finally {
    await world.stop();
  }
}

for (const language of ['en', 'fr', 'de', 'es']) {
  test(`every discovered meter follows the Gladys rules (${language} names)`, async () => {
    const devices = [
      ...(await discovered({ ...SUEZ_CONFIG, language })),
      ...(await discovered({ ...SAUR_CONFIG, language })),
    ];
    assert.equal(devices.length, 4, 'one Suez meter, three Saur subscriptions');
    const deviceIds = new Set();
    const deviceNames = new Set();

    for (const device of devices) {
      const where = device.name;
      assert.ok(!deviceIds.has(device.external_id), `${where}: duplicate device external_id`);
      deviceIds.add(device.external_id);
      assert.ok(!deviceNames.has(device.name), `${where}: two devices with the same name`);
      deviceNames.add(device.name);

      // should_poll: true if and only if poll_frequency is provided, in ms.
      if (device.poll_frequency === undefined) {
        assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
      } else {
        assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
        assert.ok(
          table.poll_frequencies_ms.includes(device.poll_frequency),
          `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
        );
      }

      assert.ok(device.features.length > 0, `${where}: no feature`);
      const externalIds = new Set();
      const names = new Set();
      for (const feature of device.features) {
        const at = `${where} / ${feature.name}`;
        const pair = table.pairs[`${feature.category}/${feature.type}`];
        assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
        assert.ok(
          pair.label_en && pair.label_fr && pair.icon,
          `${at}: couple without label or icon`,
        );

        assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
        assert.ok(
          Number.isFinite(feature.min) && Number.isFinite(feature.max),
          `${at}: finite min/max`,
        );
        assert.ok(feature.min <= feature.max, `${at}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
        assert.equal(
          typeof feature.has_feedback,
          'boolean',
          `${at}: has_feedback must be a boolean`,
        );
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
          const allowed = table.units_by_category[feature.category];
          if (allowed) {
            assert.ok(
              allowed.flat().includes(feature.unit),
              `${at}: ${feature.unit} not a unit of ${feature.category}`,
            );
          }
        }

        assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
        externalIds.add(feature.external_id);
        assert.ok(
          feature.external_id.startsWith(`${device.external_id}:`),
          `${at}: feature id outside its device`,
        );
        assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
        names.add(feature.name);
      }
    }
  });
}

test('the volumes are volume sensors in m³ and litres, never in the energy tracking', async () => {
  const devices = [...(await discovered(SUEZ_CONFIG)), ...(await discovered(SAUR_CONFIG))];
  for (const device of devices) {
    // Gladys 5.2 prices electricity only: a water volume on an energy-sensor
    // would be counted as kWh of the electric meter.
    assert.equal(
      device.features.filter((feature) => feature.category === 'energy-sensor').length,
      0,
      device.name,
    );
    const units = Object.fromEntries(
      device.features.map((feature) => [feature.external_id.split(':').at(-1), feature.unit]),
    );
    assert.equal(units.index, 'cubicmeter');
    assert.equal(units.daily_consumption, 'liter');
    assert.equal(units.month_consumption, 'cubicmeter');
    assert.equal(units.year_consumption, 'cubicmeter');
  }
});

test('Suez meters carry the price and the leak alert, Saur meters only what Saur gives', async () => {
  const [suez] = await discovered(SUEZ_CONFIG);
  const keys = (device) => device.features.map((feature) => feature.external_id.split(':').at(-1));
  assert.deepEqual(keys(suez), [
    'index',
    'daily_consumption',
    'month_consumption',
    'year_consumption',
    'price',
    'leak_alert',
  ]);
  const leak = suez.features.find((feature) => feature.external_id.endsWith(':leak_alert'));
  assert.deepEqual([leak.category, leak.type, leak.min, leak.max], ['leak-sensor', 'binary', 0, 1]);
  for (const saur of await discovered(SAUR_CONFIG)) {
    assert.deepEqual(keys(saur), [
      'index',
      'daily_consumption',
      'month_consumption',
      'year_consumption',
    ]);
  }
});

test('the external ids come from the delivery point, never from a label', async () => {
  const [suez] = await discovered(SUEZ_CONFIG);
  // idPDS of test/fixtures/suez/meters-list.json, not the meter serial.
  assert.equal(suez.external_id, 'ext:test-integration:suez:9876543');
  const saur = await discovered(SAUR_CONFIG);
  // sectionSubscriptionId of the EyeOnSaur area.json.
  assert.deepEqual(
    saur.map((device) => device.external_id),
    [
      'ext:test-integration:saur:789012125678968230',
      'ext:test-integration:saur:789012345678901781',
      'ext:test-integration:saur:234567890123456782',
    ],
  );
});
