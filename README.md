# Flightbook — self-hosting branch

Local branch `selfhost/pocket-id`, based on https://github.com/vast-ch/flightbook.
The original API, mobile web app, instructor app and public website remain in
separate directories. This branch adds optional generic OIDC login for a personal
self-hosted browser deployment, configured for Pocket ID.

See [SELF_HOSTING.md](SELF_HOSTING.md) for configuration, data persistence,
Pocket ID setup and verification commands. Direct S3 uploads using signed URLs
are preserved.

## Development

Use the checked-in devenv environment (Node 24, Chromium, PostgreSQL/PostGIS):

```bash
devenv shell
flightbook-install
flightbook-build
```

Start the local database with `devenv up -d postgres`, then run
`devenv shell -- flightbook-test-oidc` and
`devenv shell -- flightbook-test-web`. The OIDC suite creates and drops its own
empty test database and uses a simulated provider with real signed ID tokens.
It never contacts your Pocket ID instance or production database.
