# Brclio客户端服务

A shared Cloudflare backend and administration shell for Brclio clients.
The currently implemented module is **更新与网络** (`update-proxy`), providing
version checks, installer downloads and built-in proxy configuration. Only
implemented modules appear in the authenticated overview. The service uses no
R2, KV, D1, Durable Objects, or paid storage; durable module configuration stays
in the existing private GitHub data repository.

## Service and module layout

- `src/worker.js`: common HTTP entry, public homepage, health route and admin shell assets.
- `src/admin.js`: shared administrator login, session/CSRF guards and overview.
- `src/service.js`: general service identity and authenticated overview data.
- `src/http.js`: shared response, JSON-body and rate-limit helpers.
- `src/verified-tls.js`: fail-closed certificate-extension policy for the pinned TLS library.
- `src/chunk-relay.js`: bounded, fully verified installer ranges for current clients.
- `src/modules/index.js`: registry of implemented modules.
- `src/modules/update-proxy.js`: existing public update and private proxy-config routes.

The legacy `/api/update` and `/api/admin/config` contracts are preserved. Module
routes run after the common authentication guards where appropriate; expanding
the service does not require another account/session system.

## Local checks and browser deployment

The Worker project is `brclio-client-services` in Cloudflare account
`cacceff607775c81f667b7a951d4639f`. The Wrangler configuration pins that account;
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
`dist/browser/brclio-client-services.mjs`. It embeds the public homepage and administration HTML/JavaScript;
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
combined admin attempts (30/minute), update metadata/legacy requests (120/minute per IP),
and installer segment requests (600/minute per IP, separate namespace `1004`).
These limits are per Cloudflare location, as provided by the native rate-limit
API; no storage service is provisioned. The in-memory fallback exists for local
development and unit tests.

The initial subscription comes from `PROXY_SUBSCRIPTION_URL`. Once an
administrator saves a configuration, the private GitHub file
`config/update-proxy.json` takes precedence. Writes validate the subscription,
include its current Git SHA, and report a conflict instead of overwriting a
concurrent change. Public requests cache the file for 15 seconds and parsed
subscription nodes for 10 minutes while the configured URL stays identical. Expired
nodes are never served as an unlimited stale fallback. URL changes bypass the node
cache, and an administrator save clears both caches in that Worker isolate.
Administrator reads always refresh the file.

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
- Current clients request official installers with one explicit `Range: bytes=start-end`
  containing at most 1 MiB. Metadata and checksum manifests cannot use Range.
  The response is HTTP 206 with a precise `Content-Range`, `Content-Length` and
  strong quoted `ETag` (1–256 visible ASCII characters inside the quotes).
  Later requests send that ETag unchanged in `If-Range`.
  Installer requests without Range receive 416 before loading subscription nodes.
  The complete segment is validated and buffered before responding; HTTP 200
  fallback, compressed data, inconsistent lengths/ranges and changed/weak ETags
  are rejected. Invalid request ranges receive 416. Clients must compare the
  total with official release metadata and verify the final full-file SHA-256.
- `GET /`: Brclio introduction and downloads for actual published clients.
- `GET /api/releases/latest`: validated stable-release summary from the same
  subscribed relay: `{version,tag,publishedAt,releaseURL,assets}`. Assets include
  `{name,size,platform,url,checksumURL}` for recognized Mac, Windows and Android
  installers. Homepage installer links point to these validated official GitHub
  asset URLs; release-note links are separate. Draft/prerelease, nonofficial/mismatched URLs, missing or duplicate
  checksum manifests, and ambiguous installers are rejected. The homepage says
  built-in proxy support is included only after validated published metadata
  reports version 0.1.9 or later; older versions retain the unsupported notice. Metadata is bounded
  to 1 MiB and successful summaries may be cached by the browser for 60 seconds.
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
storage. Current clients download serial segments of at most 1 MiB, each in a
separate Worker invocation. Every segment is fully buffered and checked before
any segment byte reaches the client. A transient network/5xx/429 failure or short
body may retry once on another subscribed node, with failed nodes excluded from
that request's retry. Successful nodes are reused per public target host in a
WeakMap keyed by the parsed subscription array; a refreshed or changed array has
no old preferences, and unused arrays can be garbage collected. No socket or other
request I/O object is reused. Validation failures never retry. A client or the
verification script may repeat a still-unemitted segment once after 300–500 ms (the script uses 500 ms) only
when the public HTTP response is 503, within its existing deadline; persistent
503, other statuses and validation failures stop the download. This bounds both memory and per-invocation TLS
CPU instead of decrypting an entire large installer in one request.

The ordinary response route remains for metadata and small checksum manifests.
Large installer requests without Range are rejected before transport because
production observability confirmed `exceededCpu` for a whole Windows download.
The older internal streaming helper is retained, but recognized official installers
cannot reach it through the public route. Homepage installer links point to GitHub.
All responses use `no-transform`; full-file client
SHA-256 and platform installer checks remain required.

Private configuration reads retain a 5-second timeout. Subscription reads have
a 10-second timeout so a cold subscription response taking more than 5 seconds
can complete. The overall 18-second initial-response deadline includes both
setup reads and is passed to the relay as only the remaining time. In single-range
mode this deadline also covers buffering and verification of the complete segment.

Each tunnel has a 4.5-second header/handshake deadline and a 15-second read-idle
deadline. An 18-second overall initial-response deadline includes private config
and subscription reads, keeping version checks inside the clients’ 20-second
timeout. Legacy requests attempt at most three subscription routes; a single-range
request makes at most two complete segment attempts. Client cancellation
closes the active socket and aborts any segment being opened. An unread-data cap
also closes a socket instead of allowing unbounded memory growth.

The `subtls` dependency implements a limited TLS 1.3 client and is explicitly
marked by its upstream author as not intended for production. It supports a
limited set of certificate/signature algorithms, so a GitHub TLS/certificate
change can make a currently working route fail. Certificates and hostnames are
always verified; `skip-cert-verify` subscription flags never disable checks.
The verified TLS adapter additionally rejects every received/selected-anchor
certificate with unsupported name constraints, unrecognized critical extensions,
duplicate/malformed extensions, a CA key usage that cannot sign certificates,
or a CA extended key usage that does not explicitly permit TLS server authentication.
It uses the public `Cert.create` hook of the pinned dependency; upgrades must keep
the real certificate-chain regression tests passing. The pre-indexed Mozilla
database parses only the selected trust anchor at connection time, so unrelated
unused roots do not invalidate a working chain. Unsupported constraints are
rejected instead of partially interpreted. The adapter parses KeyUsage directly from DER with the standard MSB-first bit
order (upstream’s right-aligned mapping is incorrect) and enforces the standard
CA `keyCertSign` permission and leaf `digitalSignature` permission when a key
usage extension exists, replacing upstream’s incorrect demand that signing CAs
also carry `digitalSignature`. Normal signature, hostname, validity,
CA/path-length and TLS-transcript checks remain enabled.
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
segmented streaming and cancellation, buffered one-MiB Range validation and fail-closed
ETag/If-Range behavior, node-cache expiry/invalidation, login/origin/CSRF/session cookies, native
rate-limit routing, GitHub authorization containment and SHA conflicts. Actual
TLS handshakes additionally cover constrained intermediate CAs, unknown critical
extensions, CA signing key usage, and permitted noncritical extensions. Homepage
release wording is tested around the 0.1.9 feature boundary and on metadata failure.

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

Installer downloads use the same serial verified one-MiB requests as current clients,
including strong ETag/If-Range checks. `--large` selects an installer larger than 100 MiB. Neither command saves or runs
an installer. The default origin is `https://tools.brclio.com`; an explicit
origin or `BRCLIO_CLIENT_SERVICE_URL` can override it for verification. On a Node runtime that supports it,
`node --use-env-proxy scripts/verify-live.mjs https://tools.brclio.com
--large` may be used
when the test environment itself requires its configured system proxy.
