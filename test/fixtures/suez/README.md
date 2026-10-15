# Suez fixtures

Shapes of the "Tout sur mon eau" answers as pySuezV2 reads them
([jb101010-2/pySuez](https://github.com/jb101010-2/pySuez), Apache-2.0, `src/pysuez/models.py`
and `suez_client.py`), with made-up values: no real account, meter or address. The price answer
is the one of the Home Assistant `suez_water` tests (`tests/components/suez_water/conftest.py`,
Apache-2.0). The sign-in page is synthetic: it only carries the CSRF token the way
`extract_token` expects it.

Not checked against the live site from the development session (no account, and the session's
network refuses the host): `scripts/probe.mjs` does that from a machine with Internet.
