# Suez / Saur (eau) for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that brings the
**water consumption** of the remotely read meters of the two large French water distributors
into Gladys:

- **Suez**, customer area "Tout sur mon eau" ([toutsurmoneau.fr](https://www.toutsurmoneau.fr));
- **Saur**, "Mon espace client" ([mon-espace.saurclient.fr](https://mon-espace.saurclient.fr)).

> **Developed without an account: feedback welcome.** The integration was written and tested
> without a real Suez or Saur account, from the open-source libraries of the Home Assistant
> integrations (see the credits). `scripts/probe.mjs` checks the live websites up to the refusal
> of a made-up account; the first users will tell whether a real account goes through.

User documentation: [English](docs/en.md) · [Français](docs/fr.md) · [Deutsch](docs/de.md) ·
[Español](docs/es.md).

## Features

One Gladys device per water meter, identified by the distributor's delivery point (it survives a
meter replacement):

| Feature                    | Unit | Notes                                                                                                                                    |
| -------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Meter index                | m³   | Dated with its reading day.                                                                                                              |
| Daily consumption          | L    | One state per day, dated with that day: the history shows each litre on the day it was used. 13 months imported when the meter is added. |
| Consumption this month     | m³   | Running total of the calendar month.                                                                                                     |
| Consumption this year      | m³   | Since 1 January.                                                                                                                         |
| Average water price (€/m³) | €    | Suez only.                                                                                                                               |
| Leak alert (Suez)          | 0/1  | Suez only: the alert Suez shows in the customer area.                                                                                    |

Plus:

- the **"Abnormal water consumption"** scene trigger (`abnormal_consumption`), once per episode:
  a Suez leak or overconsumption alert, or the last three days in a row far above the usual
  level (a configurable multiple of the median of the 28 previous days, and 100 L above it);
- the **"Get the water consumption"** scene action (`get_water_summary`): last day, month, year,
  index, comparisons, for a message or a condition;
- the **"Water consumption"** dashboard widget (`water_summary`): yesterday, this month, the
  change against the same days of last month and of last year, the last 14 days;
- a reading **three times a day** by the integration itself, and a "Sign in and read now" action;
- texts in English, French (default), German and Spanish.

## Requirements

- Gladys **5.1.0** or later.
- A remotely read water meter and an online customer area at Suez or Saur (email and password).
- Internet access from Gladys.

## Installation

In Gladys, **Integrations → Install from GitHub**, then enter `guim31/gladys-eau`. Open the
integration, choose the distributor, enter the email and the password of the customer area, save,
then add the meters from the **Discovery** tab.

## How it works

- **Suez**: a port of pySuezV2. The integration opens the sign-in page of toutsurmoneau.fr, reads
  its CSRF token, posts the form, keeps the `eZSESSID` session cookie, then reads the JSON API
  behind the customer area (`/public-api/cel-consumption/meters-list`, `telemetry`, `get-price`,
  `/public-api/contract/tile/alerts`). Volumes come in m³.
- **Saur**: a port of saur_client. A bearer token from `apib2c.azure.saurclient.fr/admin/v2/auth`
  (15 minutes), the contracts (`/admin/users/v2/website_areas`), the days of each month
  (`/deli/section_subscription/<id>/consumptions/monthly`) and the last index.
- The session is saved in `/data/eau-state.json` (0600) with the days read (two years at most),
  the last index, how far the history reached Gladys and the episode in progress.
- The daily consumption is published as **past states** (`created_at` = noon UTC of the day, the
  same calendar day in France all year). The running totals are published "now", with a 6-hour
  heartbeat. Gladys 5.2's energy tracking only prices electricity, so the volumes stay volume
  sensors, as in the Veolia and Agur integrations.
- The core does not reliably poll external devices (GladysAssistant/Gladys#3198): an internal
  8-hour timer does the work, the core's `onPoll` is only a fallback.

## Limitations

- Daily data, one or two days late; no hourly data, so no night-time leak detection.
- Price and leak alert: Suez only. The Suez alerts are per contract.
- A past-dated state never fires a "device state" scene in Gladys: react through the trigger and
  the scene action.
- No official API: a change of the distributors' websites can break the integration until an
  update.
- Developed without an account (see above).

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
node scripts/probe.mjs          # from a machine with Internet: the live sign-ins, read-only
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`) and a fake
web (`test/helpers/`) serving Suez and Saur in the shapes of the libraries' tests
(`test/fixtures/`). Nothing reaches the network. See [`CLAUDE.md`](CLAUDE.md) for the project
rules. Versions are cut by the Release workflow (Actions → Release).

## Credits

- [jb101010-2/pySuez](https://github.com/jb101010-2/pySuez) (pySuezV2, Apache-2.0) by jb101010-2
  and ooii: the Suez sign-in and API calls are ports of its client.
- Home Assistant's
  [`suez_water`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/suez_water)
  integration (Apache-2.0): the 12-hour pace, the sensors and the price fixture.
- [cekage/Saur_fr_client](https://github.com/cekage/Saur_fr_client) (saur_client, MIT) and
  [cekage/eyeonsaur-ha](https://github.com/cekage/eyeonsaur-ha) (EyeOnSaur, MIT) by Cekage Dave:
  the Saur API calls, and the mocked answers used as fixtures (`test/fixtures/saur/`).
- The architecture and the conformity tests follow
  [gladys-opower](https://github.com/guim31/gladys-opower) and
  [gladys-wled](https://github.com/guim31/gladys-wled); the water features mirror the Veolia
  (prohand/gladys-veolia) and Agur (cicoub13/gladys-agur) integrations.

## Disclaimer

This project is not affiliated with Suez or Saur, nor endorsed or sponsored by them. "Suez",
"Tout sur mon eau" and "Saur" are trademarks of their owners.

## License

Apache-2.0 (see [LICENSE](LICENSE)).
