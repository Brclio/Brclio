# Brclio客户端服务

A shared Cloudflare backend and administration shell for Brclio clients.
The currently implemented module is **更新与网络** (`update-proxy`), providing
version checks, installer downloads and built-in proxy configuration. Only
implemented modules appear in the authenticated overview. The service uses no
R2, KV, D1, Durable Objects, or paid storage; durable module configuration stays
in the existing private GitHub data repository.

## Service and module layout

- `src/worker.js`: common HTTP entry, health route and admin shell assets.
- `src/admin.js`: shared administrator login, session/CSRF guards and overview.
- `src/service.js`: general service identity and authenticated overview data.
- `src/http.js`: shared response, JSON-body and rate-limit helpers.
- `src/modules/index.js`: registry of implemented modules.
- `src/modules/update-proxy.js`: existing public update and private proxy-config routes.

The legacy `/api/update` and `/api/admin/config` contracts are preserved. Module
routes run after the common authentication guards where appropriate; expanding
the service does not require another account/session system.

## Local checks and browser deployment

The Worker project is `brclio-client-services` in Cloudflare account
`cacceff607775c81f667b7a951d4639f`. Both Wrangler configurations pin that account;
an authenticated CLI session for another account must not select a deployment
target implicitly. The current deployment is performed through the verified
account in the browser.

Run these local, non-publishing commands from this directory:

```sh
npm ci
npm test
npm run check
npm run bundle:browser
```

The browser bundle is a standalone ES module at
`dist/browser/brclio-client-services.mjs`. It embeds the admin HTML and JavaScript;
no auxiliary assets need uploading. `dist/browser/manifest.json` records its
SHA-256, intended account/project, compatibility settings, environment-variable names and native
rate-limit bindings. Rebuild it after any source or UI changes. In the correct
account's Worker editor, use that complete module, compatibility date `2026-10-18`,
and flags `nodejs_compat` and `global_fetch_strictly_public`.

Configure these environment-variable names on the same Worker in the browser:
`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `GITHUB_TOKEN`,
`GITHUB_DATA_REPOSITORY`, and `PROXY_SUBSCRIPTION_URL`. No environment-variable values are present
in the bundle or manifest.

At the owner’s request, all six values are Dashboard-managed **Text** variables,
viewable in the Cloudflare console for maintenance. `keep_vars = true` preserves
those values across deployments. They remain server-only; the Worker never
returns them in a public response. `SESSION_SECRET`
must be a random string with at least 32 characters. The GitHub repository value
is `owner/repository`; the token needs access to that private repository with
Contents read/write. Do not place actual credential values in source, Wrangler
configuration, commands saved in shell history, or logs. Local development may
use the ignored `.dev.vars` file.

Wrangler declares native rate limits for per-IP login attempts (8/minute),
combined admin attempts (30/minute), and update requests (120/minute per IP).
These limits are per Cloudflare location, as provided by the native rate-limit
API; no storage service is provisioned. The in-memory fallback exists for local
development and unit tests.

The initial subscription comes from `PROXY_SUBSCRIPTION_URL`. Once an
administrator saves a configuration, the private GitHub file
`config/update-proxy.json` takes precedence. Writes validate the subscription,
include its current Git SHA, and report a conflict instead of overwriting a
concurrent change. Public requests cache the file for 15 seconds and parsed
subscription nodes for 60 seconds. Administrator reads always refresh the file.

The deployment uses one Worker at the confirmed custom-domain origin
`https://tools.brclio.com` in that same Cloudflare account. The administration
shell at `https://tools.brclio.com/admin` and all APIs share that HTTPS origin.
Wrangler pins the custom-domain route and disables workers.dev. Domain binding,
application deployment and live verification are distinct checks.
No Pages project, gateway, service binding, or second deployment is required.
The client uses the update-proxy module only when its session switch is enabled
and it detects no system proxy.

## API

- `GET /api/health`: basic availability for `brclio-client-services`; retains the
  existing `proxyProtocol` field for compatibility, with no private config.
- `GET /api/update?url=...`: latest metadata or release file from
  `Brclio/Brclio` only. Arbitrary targets, arbitrary GitHub repositories, direct
  signed asset URLs, HTTP, and custom ports are rejected.
- `GET /admin`: general Brclio client-services administration interface.
- `POST /api/admin/login`: JSON `{email,password}`; returns `{ok,csrf}` and an
  eight-hour signed `__Host-` HttpOnly, Secure, SameSite=Strict cookie.
- `GET /api/admin/overview`: authenticated service/account identity, metadata for
  exactly the implemented `update-proxy` module, CSRF token, and actual private
  configuration state. It includes `updates.configurationStatus` as `configured`
  or `unavailable`, official release repository and last-save time. It does not
  return the subscription URL, GitHub SHA or credential values, and does not
  claim a live proxy health check.
- `GET /api/admin/config`: returns `{subscriptionUrl,sha,updatedAt,csrf}` to an
  authenticated administrator.
- `PUT /api/admin/config`: JSON `{subscriptionUrl,sha}` and `X-CSRF-Token`;
  requires a same-origin browser request. Returns saved metadata and the number
  of compatible nodes. A concurrent edit returns HTTP 409.
- `POST /api/admin/logout`: requires the session, origin and CSRF header and
  removes the browser cookie. Rotate `SESSION_SECRET` to revoke all sessions
  immediately, including after an administrator password change.

No CORS access is enabled. Login and all mutations require the exact service
origin. The administration page has a restrictive CSP and no third-party assets.
The login response and config responses use `Cache-Control: no-store`.

## Actual proxy transport

The relay parses Clash YAML (requested with the `clash.meta` user agent) and
VLESS URI subscriptions. Compatible nodes must use VLESS TCP over TLS WebSocket;
unsupported transports and XTLS flows are excluded. When the subscription gives
Cloudflare anycast IP hints, the Worker connects to the authenticated SNI/WS
hostname, preserving its port, path and UUID. The WebSocket API cannot select an
arbitrary IP while independently authenticating another TLS SNI hostname.

The Worker explicitly enables `global_fetch_strictly_public` so subrequests
to Worker-backed subscription/WebSocket hostnames use their public front door
instead of bypassing mapped Workers to an origin. The WebSocket connection is
certificate-verified by Cloudflare. It carries a
VLESS TCP request for the target GitHub host, then an independent TLS 1.3 session
verified against the bundled Mozilla CA trust database. HTTPS requests and
responses pass inside that VLESS tunnel. There is no direct-fetch fallback for
update traffic. Normal authenticated HTTPS is used only to access the private
GitHub configuration and retrieve the proxy subscription itself.

Release redirects are followed manually and only to GitHub's recognized asset
storage. Download responses are streamed as consecutive 4 MiB HTTP ranges, with
range/length/ETag validation. This bounds unread WebSocket data and avoids
loading a whole installer into the Worker. Cloudflare responses use a `FixedLengthStream` and `no-transform` to retain the
original installer length without edge recompression; client SHA-256 verification remains necessary. A failed
segment aborts the download; the client must start a fresh download. Incoming
custom Range requests are rejected. An upstream that ignores Range can serve
only a small response up to 4 MiB.

Each tunnel has a 4.5-second header/handshake deadline and a 15-second read-idle
deadline. An 18-second overall initial-response deadline includes private config
and subscription reads, keeping version checks inside the clients’ 20-second
timeout. At most three subscription routes are attempted. Client cancellation
closes the active socket and aborts any segment being opened. An unread-data cap
also closes a socket instead of allowing unbounded memory growth.

The `subtls` dependency implements a limited TLS 1.3 client and is explicitly
marked by its upstream author as not intended for production. It supports a
limited set of certificate/signature algorithms, so a GitHub TLS/certificate
change can make a currently working route fail. Certificates and hostnames are
always verified; `skip-cert-verify` subscription flags never disable checks.
Keep the dependency/trust roots reviewed and verify deployed behavior after
changes. See `certs/README.md` for trust-store provenance and regeneration.

Proxy failures log only a fixed event, stage enum and error-code enum. No raw
exception, URL, node UUID, subscription, response body or credential is logged.
Native observability persistence is disabled. A successful relay includes
`X-Brclio-Route: subscription-vless`.

## Verification

`npm test` covers VLESS framing, fragmented/chunked HTTP, certificate stream
peek behavior, socket queue bounds, actual workerd binary-WebSocket handling,
fixed-length streaming in the actual Worker runtime, strict target/redirect restrictions,
segmented streaming and cancellation, login/origin/CSRF/session cookies, native
rate-limit routing, GitHub authorization containment and SHA conflicts.

`npm run check` bundles the Worker and validates its binding configuration. An additional actual workerd runtime test validates Request
options for GitHub and subscription requests; notably workerd rejects
`redirect: 'error'` despite the documentation listing it, so the service uses
`manual` and explicitly refuses redirect responses.
These checks do not establish that a live subscription node is reachable or
that the account's Worker CPU limits permit a large real download. Verify the
deployed metadata route, admin read/write, and a complete release installer
against the official SHA-256 before claiming a production rollout.

A reusable deployed verification command streams the smallest current installer
and compares its byte count and SHA-256 to both official GitHub release metadata and
exactly one matching entry in the bounded `SHA256SUMS.txt` manifest, all retrieved
through the verified TLS/VLESS relay. The manifest bytes are also checked against
the manifest asset's GitHub metadata digest:

```sh
npm run smoke -- https://tools.brclio.com
npm run smoke -- https://tools.brclio.com --large
```

`--large` selects an installer larger than 100 MiB. Neither command saves or runs
an installer. The default origin is `https://tools.brclio.com`; an explicit
origin or `BRCLIO_CLIENT_SERVICE_URL` can override it for verification. On a Node runtime that supports it,
`node --use-env-proxy scripts/verify-live.mjs https://tools.brclio.com
--large` may be used
when the test environment itself requires its configured system proxy.
