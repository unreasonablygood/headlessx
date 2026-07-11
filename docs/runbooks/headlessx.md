# headlessx — fleet Service runbook

Fleet scraping host: HeadlessX v2.x (Camoufox/Firefox, anti-detection) for
JS-rendered/SPA **public** pages. Deployed on `ml-beelinks12-01` over Tailscale.
Adoption tracked in `pi-config-4qq`; audit/corrected-basis in `pi-config-b7w`.

## Deploy contract

| | |
|---|---|
| Repo | `unreasonablygood/headlessx` (fork of `saifyxpro/HeadlessX`; `upstream/main` tracked) |
| Branch | `main` |
| Compose | `/docker-compose.fleet.yml` (repo root; flattened — no profiles; 5 services) |
| build_pack | `dockercompose` |
| Coolify app uuid | `<TBD — created in Phase 1>` |
| Project | `coolify` |
| Server | `ml-beelinks12-01` (`ucc48g4og8ogcscow0cwc8ok`) |
| Destination | `p8sc8sosg0goggsk0088ccwc` (network `coolify`) |
| github_app_uuid | `iookw8o0cgk8kkc4g4kgoc40` (`nickreese-coolify`) |
| API host port | `38473` (Tailscale only) |

The flattened compose drops `profiles` (Coolify does not pass `--profile all`),
drops `web`+`worker` (API-only scraping), removes host ports for internal deps
(postgres/redis/html-to-md/yt-engine), and drops the `../../apps/api/models`
bind-mount (no repo checkout on the Coolify host).

## Secrets (value-blind, op:// refs)

Required by `assertSecurityConfiguration()` (exact env names — no prefix):

- `CREDENTIAL_ENCRYPTION_KEY` — `op://m3_local/CREDENTIAL_ENCRYPTION_KEY/credential`
- `DASHBOARD_INTERNAL_API_KEY` — `op://m3_local/DASHBOARD_INTERNAL_API_KEY/credential`
- `POSTGRES_PASSWORD` — `op://m3_local/POSTGRES_PASSWORD/credential`

Minted via `secret-bootstrap generate <KEY> --to coolify:<uuid>` then
`secret-bootstrap harvest <KEY> --from coolify:<uuid>` (generate writes the env
row; harvest lifts the value into 1Password). **Redeploy after env writes**
(env write ≠ running container).

## Scrape API + wrapper

- Endpoints: `POST /api/operators/website/scrape/{html,html-js,content,screenshot}`.
- Auth: `x-api-key` header (ApiKeyGuard). The wrapper resolves
  `HEADLESSX_API_KEY` via opd (built-in default
  `op://m3_local/DASHBOARD_INTERNAL_API_KEY/credential`); the internal key is
  accepted by scrape routes. Dedicated non-internal key = follow-up.
- Wrapper: `pi-config/skills/headlessx/` (`headlessx render/html/content/screenshot`).
- Health: `GET /api/health` → `{status:'online', browser:'Headfox JS (Camoufox-powered Firefox)'}` (NO `browserConnected` in v2).

## headfox-server (`browser remote` backend)

A **separate Coolify app** (`r5iur7qq2m7xdg1pervg6g4d`, `docker-compose.headfox.yml`)
running a **persistent Camoufox Playwright server** (`firefox.launchServer`) so
pi's `browser` skill can drive the remote anti-detection browser for *interactive*
flows (the scrape API above is for one-shot scraping). Distinct from the v2 scrape
stack — does not touch it.

- **Launcher** (`infra/docker/headfox-server.mjs`): `firefox.launchServer({
  wsPath: '/' + HEADFOX_WS_PATH, host: HEADFOX_BIND (def the tailnet IP),
  ...camoufoxOptions })`. Validates the token (≥16 chars, trims quotes). Never
  logs the wsEndpoint (it carries the secret token).
- **Compose**: `network_mode: host` (workaround for the beelink's docker
  network-pool exhaustion — see [pi-config-1d2](http://bv:2026/pi-config-1d2);
  bridge creation fails "all predefined address pools fully subnetted"). TCP
  healthcheck on the server port → Coolify `running:healthy`. `restart: unless-stopped`.
- **playwright-core pin**: `1.61.0-alpha-1781023400000` (apps/api/package.json) —
  must EXACTLY match the mac's `@playwright/cli` version or `connect` fails (428
  version mismatch). headfox-js declares playwright-core as a peer (>=1.53), so the
  bump changes the shared version the server uses.
- **Client** (pi-config `skills/browser/browser.ts`): `browser remote` resolves
  the token via opd (`op://m3_local/HEADFOX_WS_PATH/credential`), writes
  `ws://<HEADFOX_HOST>/<token>` to a **0600 temp config** (`browser.remoteEndpoint`
  + `viewport:null` — Camoufox rejects `setDefaultViewport`), runs
  `playwright-cli open --config <temp>`, deletes the temp. The daemon reads
  `remoteEndpoint` from the config (into memory) — **never on argv** (persistent
  daemon argv endpoint count: 0). Subsequent `goto`/`snapshot`/`click` forward to
  playwright-cli (same session) → drive the remote.
- **Secret**: `HEADFOX_WS_PATH` (the ws_path token) minted value-blind to Coolify
  env + 1Password (`op://m3_local/HEADFOX_WS_PATH/credential`) via
  `secret-bootstrap generate` + `harvest`. Auth = Tailscale-only (tailnet bind)
  + the token (Playwright validates the path).
- **Known issue — mint quoting**: `secret-bootstrap` sometimes stored the token
  with surrounding single quotes; the client + launcher strip them defensively
  (`.replace(/^["']+|["']+$/g, '').trim()`). Root-cause in secret-bootstrap is a
  separate follow-up.
- **Follow-up**: migrate host networking → an isolated bridge network once
  [pi-config-1d2](http://bv:2026/pi-config-1d2) (the pool fix) lands — see
  [pi-config-bcq](http://bv:2026/pi-config-bcq) (child, blocked on 1d2).

## Upstream sync

`gh repo sync unreasonablygood/headlessx` (parent `saifyxpro/HeadlessX`).
The flattened compose is an additive file — survives upstream merges. Re-vendor
review on minor bumps (Camoufox bundle, API surface, compose shape).

## Teardown (v1.3.0)

The v1.3.0 app (`x804g0owk4w04wcgsoc0w44c`, port 3000, `AUTH_TOKEN`) is the
predecessor. No fleet consumers (audited — `pi-config-b7w`). Stop after v2.x
passes SPA smoke; delete via `coolify delete`; retire
`op://m3_local/AUTH_TOKEN/credential`. `nickreese/HeadlessX` (the old personal
fork) is archived.
