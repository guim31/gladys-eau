# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-15

### Added

- Water consumption of the remotely read meters of Suez ("Tout sur mon eau")
  and Saur ("Mon espace client"), signed in with the email and password of the
  customer area. One device per meter, identified by its delivery point, or
  only the meter whose number is configured.
- Per meter: the daily consumption in litres, filed in the history on the day
  it was used (13 months imported when the meter is added), the meter index,
  the consumption of the month and of the year in m³; with Suez, the average
  water price and the Suez leak alert.
- The "Abnormal water consumption" scene trigger, once per episode: a Suez
  leak or overconsumption alert, or three days in a row far above the usual
  consumption (threshold to choose in the configuration).
- The "Get the water consumption" scene action and the "Water consumption"
  dashboard widget (yesterday, this month, comparison with last month and last
  year, last 14 days).
- A reading three times a day by the integration itself, the session kept in
  `/data`, and a "Sign in and read now" action.
- Texts in English, French, German and Spanish; documentation in the four
  languages.

[Unreleased]: https://github.com/guim31/gladys-eau/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-eau/releases/tag/v1.0.1
