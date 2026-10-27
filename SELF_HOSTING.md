# Self-hosting with Pocket ID and Garage

This branch adds an opt-in browser OIDC flow. Set `OIDC_ONLY=true` to use it.
When unset, the original Keycloak/password authentication remains available.
Node 24 is required for the backend's ESM OIDC library interoperability; both
Dockerfiles and devenv select Node 24.

## Pocket ID

Create a confidential OIDC client in your existing Pocket ID instance:

- Callback: `https://flightbook-api.example-tailnet.ts.net/auth/oidc/callback`
- Use Authorization Code with PKCE (S256).
- Allow `openid profile email`; enable verified email claims.
- Restrict the client to your intended users/groups in Pocket ID.

Configure the API:

```dotenv
OIDC_ONLY=true
OIDC_ISSUER=https://id.example-tailnet.ts.net
OIDC_CLIENT_ID=<client ID>
OIDC_CLIENT_SECRET=<client secret>
OIDC_REDIRECT_URI=https://flightbook-api.example-tailnet.ts.net/auth/oidc/callback
MOBILE_APP_URL=https://flightbook.example-tailnet.ts.net
API_URL=https://flightbook-api.example-tailnet.ts.net
SELF_HOSTED=true
# Optional further restriction; comma-separated verified email addresses:
OIDC_ALLOWED_EMAILS=you@example.com
# Optional local session lifetime; 300–2592000 seconds, default seven days:
SESSION_MAX_AGE_SECONDS=604800
```

All browser-facing endpoints must use HTTPS. The API must reach the issuer's
OIDC discovery, token and JWKS endpoints. The frontend image accepts `API_URL`
at startup as upstream does. Browser API requests include an HttpOnly, Secure,
SameSite=Lax, host-only session cookie; these sibling tailnet hostnames must stay
on the same site. If you move the web app to a different site, revisit the cookie
and CSRF configuration before deployment.

`GET /auth/config` advertises the mode. `GET /auth/oidc/login` starts login;
`GET /auth/oidc/callback` finishes it and redirects to the web app's `/home`.
`POST /auth/oidc/logout` revokes the local session, but does not sign you out of
Pocket ID or other applications. Local passwords, registration, email
verification and legacy login/refresh/logout routes are disabled in OIDC mode.
The local profile still owns flight settings, name and phone; verified email is
updated from the provider at login. Local email changes are disabled.

Sessions and short-lived, single-use login transactions live in PostgreSQL.
Only hashes of opaque session and browser-binding tokens are stored. Provider
access/refresh tokens are not retained. Expired sessions/transactions are pruned
at login. State, nonce, PKCE, issuer, audience and ID-token signatures are checked.
Unsafe API requests require the exact frontend Origin; CORS allows credentials
only for that origin. No API cookie or authorization header is attached to S3
uploads. No OIDC client secret is sent to the frontend.

New issuer/subject identities are provisioned as local users. Existing accounts
are never automatically linked by email. For an existing/imported local account,
an administrator must explicitly insert its trusted `(issuer, subject, user_id)`
into `data.oidc_identity` after verifying the Pocket ID identity. Disabled local
users cannot log in or use existing sessions. Changing Pocket ID membership does
not immediately revoke existing local sessions: disable the local account or
remove its rows from `data.oidc_session` for immediate revocation.

`SELF_HOSTED=true` explicitly grants local premium entitlements and disables
Stripe initialization, checkout, cancellation and webhooks. It does not require
Stripe or RevenueCat credentials. Unset it for upstream billing behavior.

## PostgreSQL and persistence

Use a dedicated database/role in the existing PostgreSQL instance:

```dotenv
DATABASE_HOST=10.88.0.1
DATABASE_PORT=5432
DATABASE_USER=flightbook
DATABASE_PASSWORD=<runtime secret>
DATABASE_NAME=flightbook
DATABASE_SCHEMA=data
DATABASE_SSL=false
DATABASE_SYNCHRONIZE=false
ENV=prod
```

Provision PostGIS and pg_trgm in `public`, and set the role's database-specific
search path to `data, public`. The existing migration chain runs automatically,
including the new OIDC identity/session/login tables. Back up before upgrades;
never enable schema synchronization over production data.

On the impermanent NixOS host, persist PostgreSQL, Garage's entire metadata/data
directory, container image storage, Caddy/Tailscale state and Pocket ID. Sessions
require no extra application state directory: they are in PostgreSQL. Runtime
secrets are recreated by sops. Persistence is separate from backups; restore the
SQL database and bucket contents together.

## Garage and signed uploads

The upstream upload architecture is unchanged: the API signs an S3 URL and the
browser uploads directly. Both browser and backend must reach the HTTPS storage
hostname through Tailscale. Configure bucket CORS for the web app's exact origin.

```dotenv
AWS_S3_ENDPOINT=https://flightbook-s3.example-tailnet.ts.net
AWS_REGION=garage
AWS_BUCKET=flightbook
AWS_ACCESS_KEY_ID=<bucket-scoped key>
AWS_SECRET_ACCESS_KEY=<bucket-scoped secret>
AWS_S3_FORCE_PATH_STYLE=true
AWS_S3_DISABLE_ACL=true
AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
```

The new S3 flags override upstream's hardcoded region/local-only path addressing.
The ACL flag omits legacy S3 ACL headers; Garage permissions remain restricted to
the dedicated key and private bucket. The SDK checksum setting prevents signing an empty-body checksum before the browser supplies the file. Signed URLs remain valid for ten minutes.

## Manual location coordinates

The location form accepts a single latitude, longitude pair:

- Decimal degrees: `47.146911, 9.253738`
- Degrees and decimal minutes: `47° 8.81466′ N, 9° 15.22428′ E`
- Degrees/minutes/seconds: `47° 8′ 48.8796″ N, 9° 15′ 13.4568″ E`

Unsigned values default to north/east; use negative signs or S/W for south/west.
Valid entries move the map pin. Choosing a pin updates the field. Invalid entries
cannot be saved. Clearing the field removes the coordinates. Manual coordinate
entry looks up elevation and country after a short pause. Existing manual values
require confirmation before replacement, as with a map selection. Saving waits
for the lookup and confirmation; a failed lookup keeps the chosen position and
existing metadata.

## Desktop flight inputs

With a mouse/trackpad, the flight form uses inline text fields instead of date
and duration modals. Dates accept `27.10.2026` or `2026-10-27`; duration accepts
`1:30` or `90` minutes, with optional seconds (`1:30:45`). Invalid dates and
out-of-range durations cannot be saved. Touch devices retain the existing
pickers. IGC imports still update the displayed date and duration.

## Local form preview

Run `devenv shell -- flightbook-preview`, then open http://localhost:4200.
This uses the actual flight and location forms with isolated sample data.
No sign-in or backend is needed and saves only display the resulting values.
Metadata lookup is simulated with 900 m / CH so overwrite confirmation can be
reviewed. Map tiles still come from OpenStreetMap. This separate entry point is
excluded from production builds.

## Build and verify

```bash
devenv shell -- flightbook-install
devenv shell -- flightbook-build
devenv up -d postgres
devenv shell -- flightbook-test-oidc
devenv shell -- flightbook-test-web
```

The integration suite runs the full upstream migration chain in a newly-created
throwaway database. A simulated OIDC provider issues real signed ID tokens; the
suite checks valid login, malicious claims/signatures, browser binding, replay,
account collisions, disabled accounts, session expiry/revocation, local restart,
CSRF, API authorization and browser redirects. The focused Chromium tests check
cookie authentication and preserve signed S3 upload behavior. Upstream's broad
frontend test runner has existing obsolete Zone.js/Ionic test setup; the focused
suite has its own entry point and does not modify those legacy tests. The existing billing suite also has one failing subscription-trial test, reproduced with the unmodified upstream payment facade (12 of 13 pass).

Build OCI images using each component as its context:

```bash
docker build -t flightbook-api:selfhost ./flightbook-api
docker build -t flightbook-web:selfhost ./flightbook-mobile-app
```

Pin published image digests in the NixOS module. Actual login against your Pocket
ID client and an upload/download against your Garage bucket still require a
staging deployment with your runtime secrets. The instructor app's login UI has
not been adapted in this branch; the supported self-hosted UI is the mobile web
app. Native iOS/Android OIDC integration is also outside this change.

## GitHub builds and GHCR

`.github/workflows/selfhost-images.yml` runs the same locked devenv checks used
locally, then builds the API and frontend images. Pushes to `selfhost/pocket-id`
publish these packages using the workflow's `GITHUB_TOKEN`:

- `ghcr.io/tkone7/flightbook-api`
- `ghcr.io/tkone7/flightbook-web`

Each image gets a full source-commit tag (`sha-<40-character SHA>`) and the moving
`selfhost` tag. The build summary records exact digest references; use those in
the NixOS configuration. Reruns can rebuild a source commit with newer base images,
so a commit tag is not a substitute for a pinned image digest. Pull requests run
checks/builds without publishing. Manual builds publish only when run against
`selfhost/pocket-id`. Initial builds target the server's `linux/amd64` platform.

Runtime Pocket ID, database and Garage secrets stay on the server; GitHub does
not need them. Package visibility is separate from repository visibility. Make
these generic application images public for anonymous server pulls, or configure
registry authentication on the server if keeping the packages private.

The inherited upstream release/mobile-store workflows are disabled through the
fork's GitHub settings, keeping their YAML untouched for easier rebases. Review
new inherited workflows when syncing upstream. The self-hosting workflow is the
only workflow that should be enabled for this deployment.

## Keeping the fork maintainable

Keep `main` aligned with `vast-ch/flightbook` and put the self-hosting commits on
`selfhost/pocket-id`. Keep changes separated into backend authentication, browser
authentication, storage compatibility, and development/build tooling. Avoid
renaming/reformatting upstream files or mixing server-specific NixOS configuration
into the application repository. The hostnames above are examples; real deployment
values and secrets belong in the separate server configuration.

A scheduled upstream-update job is intentionally deferred. When added, it should
fetch upstream, create a candidate branch, rebase the self-hosting commits onto
that upstream revision, run these checks, and open a reviewable pull request.
Conflicts should stop the proposal rather than rewriting the deployed branch.
It must not force-push the deployment branch or automatically update server image
digests. Accepting a tested rebase will trigger the existing image workflow.
