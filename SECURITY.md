# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the password of the customer area is a `secret` field of the
  Gladys configuration. The integration reads it from Gladys, keeps it in
  memory, sends it only to the sign-in of the chosen distributor (the
  toutsurmoneau.fr form for Suez, `apib2c.azure.saurclient.fr` for Saur), and
  never writes it to `/data` nor to the logs. Every log line goes through a
  filter that blanks the password and the saved session values.
- **Stored in `/data`**: `eau-state.json`, readable by the owner only (0600):
  the session of the account (the Suez `eZSESSID` cookie and its host, or the
  Saur bearer token, its expiry and the client id), keyed by a hash of the
  distributor and the email (no address in the file); and per meter, its
  daily readings (two years at most), its last index, how far its history
  reached Gladys and the abnormal-consumption episode in progress. Deleting
  the file only means a new sign-in and a new import of the history.
- **Network**: requests go only to `www.toutsurmoneau.fr` (and the host it
  redirects the session to) or to `apib2c.azure.saurclient.fr`, in HTTPS,
  certificates verified; the integration opens no port. It reads data, it
  never changes anything on the account.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
the distributors' websites, and the other devices and services of your
network.
