# Brclio客户端服务

One Cloudflare Worker provides the Brclio homepage, administrator console and
configuration needed by the clients’ built-in update proxy. Installers and
checksum manifests remain on GitHub. The Worker never forwards or stores those
files. Clients run a temporary local CONNECT → VLESS-over-WSS bridge and use
platform-native TLS to download official GitHub releases.

## Deployment boundary

- Worker: `brclio-client-services`.
- Cloudflare account: `cacceff607775c81f667b7a951d4639f`, pinned in Wrangler.
- Main origin: `https://tools.brclio.com`; administration: `/admin`.
- Configuration-only fallback: `https://brclio-client-services.aiyuechuang.workers.dev`.
- No Pages, second Worker, R2, KV, D1, Durable Objects or installer mirror.

Deploy through GitHub Builds connected in the verified Cloudflare account. Use
project root `cloudflare`, build command `npm ci && npm test`, and deploy command
`npm run deploy`. A local CLI authenticated to another account must not be used
to deploy this project.

Wrangler runs `npm run bundle:browser` before deployment. That build uses
`src/entry.js` and inlines the JS/HTML/TXT graph into the single default-export
module `dist/browser/brclio-client-services.mjs`. The configured `no_bundle =
true`, `find_additional_modules = false` and `upload_source_maps = false` ensure
that only this validated artifact enters an upload. The builder rejects extra
chunks, named Worker exports and unresolved non-runtime dependencies.

The isolated real-CLI regression retained the production package context and
synthetic bindings. Eight runtime modules still failed after activation with
source maps disabled; the single-module form survived consecutive true CLI
uploads and activations. Source-map omission alone is therefore insufficient.
The platform's internal failure mechanism has not been established. Details and
limits are recorded in `docs/cloudflare-deployment-recovery.md`.

These artifact settings also apply to a direct Wrangler invocation. Use
`npm run deploy` to additionally run the npm `postdeploy` HTTP gate.

After a Worker is recreated, the old GitHub Builds connection and history belong
to the previous Worker identity. Reconnect Builds to the current Worker identity
and verify its actual deployment before relying on automatic builds. These source
changes do not establish that the dashboard connection has been restored.

The post-deployment gate performs only five fixed, anonymous GET requests:
homepage, health, account session, client configuration and latest release. It
validates bounded response bodies, content types and data contracts, including
the existing Google/email provider availability and official release asset URLs.
It sends no Cookie or Authorization header and performs no login or data write.
The checks share a 60-second deadline; each request has at most 15 seconds and
each endpoint gets at most three attempts for temporary failures. Any required
check still failing makes the command exit 1. Wrangler uploads before this hook
runs, so a failed hook leaves the uploaded version active for operator review
and recovery.

Run the same read-only gate separately after a direct Wrangler deployment:

```sh
npm run verify:deployment
```

Its JSON evidence contains fixed endpoint labels, HTTP statuses, failure enums,
provider availability booleans and the public release version. Configuration
nodes, response bodies, URLs, headers and credentials are omitted.

The fallback is an alias of the same Worker. Its host guard permits only `GET
/api/client/update-proxy` and `GET /api/health`; all other paths and methods,
including the homepage, login and administration, return 404. Roll out that
host guard before enabling the production alias in the correct account. The
production alias is now enabled and persisted with `workers_dev = true`;
preview URLs remain disabled.
Preview URLs remain disabled. The fallback avoids the custom domain’s confirmed
Bot Fight Mode challenge without disabling zone protection. Its reachability in
any particular network must still be verified.

Dashboard-managed **Text** environment variables, at the owner’s explicit
maintenance preference:

`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `GITHUB_DATA_REPOSITORY`,
`GITHUB_PROGRAM_DATA_REPOSITORY`,
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `PROXY_SUBSCRIPTION_URL`.
Store `GITHUB_APP_PRIVATE_KEY` as a Worker Secret. Do not configure a personal
GitHub token for this integration.

`keep_vars = true` preserves those values across builds. They are absent from
source, browser bundles, public JSON and logs. `SESSION_SECRET` requires at least
32 random characters. The GitHub App installation requires Contents read/write
and Metadata read access to both selected private repositories. The server signs a
short-lived RS256 JWT and exchanges it for an installation token scoped to that
repository, caching each repository scope separately until shortly before expiry. App credentials never
enter client code or public responses. The initial subscription comes from the
environment; a saved `config/update-proxy.json` in the program-data repository takes
precedence. Administrator reads and each client configuration request fetch that
file freshly. Writes include its SHA and return 409 on a concurrent edit.

`GITHUB_DATA_REPOSITORY = BrclioData/BrclioUserData` stores accounts and all
account-owned records, including nicknames, settings and each app's user data.
`GITHUB_PROGRAM_DATA_REPOSITORY = BrclioData/BrclioData` stores program-wide
information, including the global `config/update-proxy.json` subscription.
Both repository bindings are explicit: global configuration never falls back to
the account repository, and account storage never falls back to program data.

## Client configuration contract

`GET /api/client/update-proxy` returns JSON, `Cache-Control: no-store`, no CORS,
and no redirects. A native per-IP limit permits 30 requests per minute at each
Cloudflare location. Failures use fixed public error codes and sanitized text.
The response is at most 32 KiB:

```json
{
  "version": 1,
  "ttlSeconds": 600,
  "nodes": [{
    "uuid": "00112233-4455-6677-8899-aabbccddeeff",
    "host": "vpn.example.com",
    "port": 443,
    "path": "/tunnel",
    "servername": "vpn.example.com",
    "wsHost": "vpn.example.com",
    "dialAddress": "104.17.1.1"
  }]
}
```

These are illustrative values. Only the seven necessary node fields are
returned. A client must receive the node UUID and connection parameters to use
the proxy, so those credentials are extractable from the client/API response.
The subscription URL, administrator credentials, session key and GitHub App credentials
remain server-side and are never part of this contract.

Each version check, download and automatic retry using the built-in proxy
performs a new configuration request. The service freshly reads and validates
the private GitHub configuration and fetches the current subscription on every
native-client request, without the previous 15-second validated-subscription
reuse or an additional subscription-fetch retry. The client owns the single
retry budget. Administrator saves remain SHA-protected and take effect on the
next attempt. `ttlSeconds` is a bounded schema hint, not permission for a client
to skip its next request. Subscription and configuration requests use
no-cache/no-store.
The service returns all distinct
compatible routes up to 16, including different preferred IPs for the same TLS
name. More than 16 compatible routes or a response larger than 32 KiB fails
explicitly instead of silently claiming to have tested every route.

Supported nodes are VLESS TCP over TLS WebSocket with no XTLS flow. Enabled
`insecure`, `skip-cert-verify` and equivalent settings are rejected. The same
strict public DNS name must be used for `host`, TLS certificate/SNI `servername`
and HTTP `wsHost`. `dialAddress` preserves the subscription’s connection
address: a canonical public IPv4 address or strict public DNS name. Local names,
private/loopback/link-local/reserved IPv4 ranges, IPv6 and unsupported TLS ports
are rejected. Clients also validate resolved addresses before dialing. A preferred
IP changes TCP routing, never the certificate identity.

Clients probe all returned candidates in one bounded batch using native HTTPS
`HEAD https://github.com/robots.txt`, require HTTP 200 without redirects or a
challenge, and select the fastest successful end-to-end path. Each candidate has
4 seconds and the batch has 8 seconds within the operation deadline. The selected
route stays fixed for that attempt. Recoverable network, bootstrap, node-selection
and interrupted-download failures permit at most ten automatic retries after
the initial attempt. Each retry refreshes configuration and probes again when
the built-in route is selected. From v0.1.14, clients retain identity-bound
partial downloads across network failures, manual retries and process restarts.
After rereading the manifest, they request only the remaining bytes with Range
and an optional strong If-Range validator. A 206 response must match the exact
offset, pinned total size, segment length and identity encoding before append.
The final on-disk file still requires full size and SHA-256 verification.
An ignored Range returning 200 is explicitly reported and safely handled as a
complete replacement, never appended; changed identity or integrity failures
invalidate the old partial file.
All automatic download attempts share the original ten-minute total deadline.
Success stops retries; exhaustion preserves a resumable prefix and leaves a
manual continue action. Certificate, address,
format, integrity, filesystem and cancellation errors stop immediately.
Installation is never automatically repeated.

A detected system proxy is used, including during retries while it remains
configured. Each new attempt checks the current environment. With no system proxy, the session switch enables
the local bridge; disabling it uses direct native networking. The switch resets
to enabled after a complete process restart. The bridge accepts only official
GitHub/CDN CONNECT targets on port 443 and is removed when the operation ends.
Outer WSS and inner GitHub HTTPS both retain native certificate and hostname
validation. Installers still require their official length, full SHA-256 and
platform installation checks.

## HTTP routes

- `GET /`: public introduction and links to actual official GitHub releases.
- `GET /api/health`: non-sensitive service availability and identity.
- `GET /api/releases/latest`: validated stable official release summary,
  `{version,tag,publishedAt,releaseURL,assets}`. Recognized assets contain
  `{name,size,platform,url,checksumURL}`. The Worker fetches only the fixed GitHub
  metadata URL with normal HTTPS; metadata is bounded to 1 MiB and may be cached
  for 60 seconds. Drafts, prereleases, other repositories, duplicate manifests
  and mismatched asset names/URLs are rejected.
- `GET /api/update?url=...`: legacy compatibility for the fixed official latest
  metadata URL only. Official installer and checksum URLs return **410** with
  `client_upgrade_required` before loading subscription/configuration nodes.
  They never transmit file bytes. Arbitrary targets return 400; metadata Range
  requests return 416.
- `GET /api/client/update-proxy`: fresh native-client configuration above.
- `GET /admin`: administrator console.
- `POST /api/admin/login`: same-origin JSON login, signed eight-hour `__Host-`
  HttpOnly/Secure/SameSite=Strict session cookie.
- `GET /api/admin/overview`: authenticated account, implemented module metadata
  and actual configuration state; no subscription URL or credentials.
- `GET /api/admin/config`: authenticated `{subscriptionUrl,sha,updatedAt,csrf}`.
- `PUT /api/admin/config`: same-origin `{subscriptionUrl,sha}` with CSRF header;
  validates the subscription before writing the private GitHub file.
- `POST /api/admin/logout`: same-origin session/CSRF validation and cookie removal.

Rotate `SESSION_SECRET` to revoke all active sessions, including after changing
an administrator password. Admin pages use a restrictive CSP and no third-party
assets. Native rate limits also cover per-IP login (8/minute), combined login
(30/minute), and public metadata/legacy routes (120/minute).

## Source and checks

`src/worker.js` is the shared entry and host guard; `src/client-config.js` defines
the public client schema; `src/config.js` handles private storage and subscription
refresh; `src/protocol.js` validates nodes; `src/releases.js` validates fixed
GitHub metadata; `src/modules/` contains implemented module routes. Historical
Worker tunnel helpers retained in the tree are not imported by the runtime entry
or present in the deployed bundle; current downloads do not use JavaScript TLS.

From `cloudflare/`:

```sh
npm ci
npm test
npm run check
npm run bundle:browser
```

These commands do not publish. The optional standalone browser export is
`dist/browser/brclio-client-services.mjs`; its manifest records SHA-256, account,
route, alias guard, compatibility settings, variable names and native limit
bindings. Normal Wrangler deployment uses `src/entry.js` and the existing text
modules. The Worker uses `nodejs_compat` and `global_fetch_strictly_public`.

Tests cover fresh native configuration and subscription reads, legacy cache
invalidation, strict seven-field configuration, all 16
preferred-IP routes, insecure flag rejection, size/rate limits, alias isolation,
410-before-transport, official release parsing, origin/session/CSRF/SHA guards,
and safe failure evidence. Native gate tests use local fixtures and native TLS,
including trusted-but-wrong-host and untrusted certificate rejection.

## Real production download gate

From the repository root, install the native bridge’s production dependency
without downloading Electron development packages:

```sh
npm ci --omit=dev
npm --prefix cloudflare ci
npm --prefix cloudflare run smoke -- https://tools.brclio.com
npm --prefix cloudflare run smoke -- https://tools.brclio.com --large
```

The script refreshes production configuration and probes all candidates once for
the check operation, then again for the download operation. It reuses the desktop
local CONNECT/WSS bridge and Node’s native TLS to read **GitHub** metadata,
`SHA256SUMS.txt` and one entire installer. It validates official redirects,
metadata/manifest digests, exact installer length and full SHA-256. `--large`
selects an installer larger than 100 MiB. It saves and executes no installer and
sends no installer/manifest requests to the Worker. It reports safe JSON on both
success and failure and exits nonzero on failure. The existing 20-second check and 45-second download idle timeouts remain enforced.
Downloads have no total-duration limit; active transfers continue while bytes arrive.

The release workflow installs root production dependencies and Cloudflare test
dependencies before running both sizes. Every Windows/macOS build additionally
runs the real Electron native proxy fixture. Backend deployment, complete live
native downloads, signed packages, publication, and actual installed-client
replacement/relaunch are separate verification stages. Passing local tests or
updating this documentation does not establish any later stage.
