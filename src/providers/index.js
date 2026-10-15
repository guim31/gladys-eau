// -----------------------------------------------------------------------------
// The supported distributors. `key` is stored in the user's configuration and
// in the device external ids: never renamed. `features` tells what the
// distributor gives beside the daily readings, so a device only carries the
// features that will receive a value.
// -----------------------------------------------------------------------------

import { createSaurClient } from './saur.js';
import { createSuezClient } from './suez.js';

export const PROVIDERS = [
  {
    key: 'suez',
    name: 'Suez',
    portal: 'Tout sur mon eau',
    url: 'https://www.toutsurmoneau.fr',
    features: { price: true, leakAlert: true, dailyIndex: true },
    create: (options) => createSuezClient(options),
  },
  {
    key: 'saur',
    name: 'Saur',
    portal: 'Mon espace client Saur',
    url: 'https://mon-espace.saurclient.fr',
    features: { price: false, leakAlert: false, dailyIndex: false },
    create: (options) => createSaurClient(options),
  },
];

/** The provider of a configuration key, or null. */
export function findProvider(key) {
  return PROVIDERS.find((provider) => provider.key === key) ?? null;
}
