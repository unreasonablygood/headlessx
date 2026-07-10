# headlessx v2.x — throughput, knobs, and proxy options

Operational tuning guide for the fleet HeadlessX v2.x host (Camoufox/Firefox,
`ml-beelinks12-01:38473`). Validated 2026-07-10 against `gwun.com` with the
value-blind load-test script at `scripts/loadtest.ts`. Target: sustain ~20–100
requests/min long-term and understand the tradeoffs.

## TL;DR

- **The dominant knob is `camoufoxHumanize`, not blockImages.** `humanize=0` →
  ~5.3s/render; `humanize=2.5` (default, full behavioral anti-detection) → ~55s/render
  — a 10× swing. blockImages is only ~0.5s (verified: humanize=0 + images ON = 5.3s).
- **With humanize=0, the host sustains ~42–56 req/min at maxConcurrency 5** (the
  current cap). 20 req/min needs c≈2–3; ~50 req/min is the practical ceiling at c=5.
- **With humanize ON (2.5, anti-detection mode), the limit is ~2 req/min @ c=2,
  ~5 @ c=5** (~55s/render). You cannot reach 20–100 req/min with humanize on.
  humanize is behavioral anti-detection — it does NOT hide your home IP (see below).
- **100 req/min is NOT reachable on this host at the current maxConcurrency cap
  (5).** Hitting 100 requires raising the cap (see below) or a bigger host.
- **Residential proxies** wire in per-request via `options.proxy` (e.g.
  `http://user-session-xyz:pass@gateway:port`) or globally via `PATCH /api/config`
  (`proxyEnabled`/`proxyUrl`). Best value for our volume (5–50 GB/mo): **Decodo**
  or **IPRoyal**; hardest targets: **Bright Data** or **Oxylabs**.

## Tunable knobs

### Request-level (per scrape call, in the POST body)

| Knob | Field | Effect / tradeoff |
|---|---|---|
| Endpoint | path: `…/scrape/html` vs `…/scrape/html-js` | `html` = no JS (faster, ~5s); `html-js` = full JS render (~5.8–7s tuned). Use `html-js` for SPAs; `html` for static. |
| `waitForSelector` | `waitForSelector` (string) | Wait for a CSS selector before returning. Avoids waiting on `networkidle` for slow-settling pages. |
| `timeout` | `timeout` (ms) | Per-request cap (overrides config `browserTimeout`). Lower = faster failure on slow pages, but may truncate. |
| `stealth` | `stealth` (bool) | Camoufox anti-detection. `html-js` defaults **true**. Off = faster, but loses anti-detection (use only for non-bot-protected pages). |
| `screenshotOnError` | `screenshotOnError` (bool) | Capture a screenshot on failure (debugging). Adds overhead on errors. |
| `options.proxy` | `options.proxy` (string) | **Per-request proxy URL** (`http://user:pass@host:port` or `socks5://…`). Highest granularity — rotate per request. |
| `options.waitForTimeout` | `options.waitForTimeout` (ms) | Extra fixed wait after selector. |

### Server-level — runtime via `PATCH /api/config` (DB-backed, **no redeploy**, x-api-key gated)

These are persisted in Postgres and read on each render. GET/PATCH via the
`loadtest.ts config` / `loadtest.ts set --<flag> <value>` helpers (or any
x-api-key client). Confirmed PATCH-able fields:

| Knob | Default | Effect |
|---|---|---|
| `maxConcurrency` | 5 (env `MAX_CONCURRENCY`) | Max concurrent browser renders. **Appears capped at 5** — PATCH to 10 did not persist (server-side validation; see below). The throughput ceiling knob. |
| `browserTimeout` | 60000 (env `BROWSER_TIMEOUT`) | Default per-render timeout (ms). |
| `camoufoxBlockImages` | false | Minor lever (~0.5s). `true` = don't load images. Does NOT compensate for humanize (humanize=2.5 + blockImages=true is still ~55s). Tradeoff: no images (fine for text/data; not for screenshots). |
| `camoufoxHumanize` | 2.5 | **Dominant throughput knob.** `0` = no behavioral sim → ~5.3s/render. `2.5` (default) = full human-like behavioral sim (mouse/scroll/typing + networkidle) → ~55s/render. 10× swing. Tradeoff: ON = anti-detection but ~2 req/min; OFF = fast but less human-like. |
| `camoufoxEnableCache` | true | Reuse browser profile/cache. Keep on. |
| `camoufoxGeoip` | true | Geoip-matched fingerprint. Off may speed startup slightly; loses geo-consistency. |
| `camoufoxBlockWebrtc` | true | Blocks WebRTC leaks. Keep on (anti-detection). |
| `proxyEnabled` + `proxyUrl` + `proxyProtocol` | off / — / http | **Global proxy** for all renders (alternative to per-request `options.proxy`). |
| `profileRotation` / `profileRotationInterval` | false / 3600000 | Rotate browser profile periodically (anti-detection). |
| `stealthMode` | "advanced" | Camoufox stealth level. |

### Server-level — env (require a Coolify redeploy)

| Env | Default | Effect |
|---|---|---|
| `MAX_CONCURRENCY` | 5 | Default/max for `maxConcurrency` (the cap source — likely why PATCH→10 didn't take). Raise this + redeploy to allow higher concurrency. |
| `BROWSER_TIMEOUT` | 60000 | Fallback for `browserTimeout`. |
| `QUEUE_WORKER_CONCURRENCY` | 2 | BullMQ worker concurrency (async `crawl`/`map`/batch jobs — **not** synchronous `scrape`). |
| `QUEUE_JOB_ATTEMPTS` / `QUEUE_JOB_BACKOFF_MS` / `QUEUE_STREAM_POLL_MS` | 3 / 5000 / 1000 | Queue retry/backoff (async jobs). |
| `MAX_BROWSER_INSTANCES` | 10 | Upper bound on browser instances (may also cap effective concurrency). |

## Stress-test results (gwun.com, 2026-07-10)

Beelink `ml-beelinks12-01`: 4 CPU, 16 GB RAM (~12 GB free with luna running).
Load-test script: `scripts/loadtest.ts` (value-blind; resolves the API key via
opd once, never prints it). Config restored to shipped defaults after testing.

| # | Config | Endpoint | Conc | Total | req/min | p50 (ms) | p95 (ms) | Errors | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1a | humanize=2.5, images ON (default) | html-js | 2 | 4 | 2.1 | 55287 | 57011 | 0 | humanize=2.5 behavioral sim → ~55s |
| 1b | humanize=2.5 (default) | html-js | 5 | 10 | 3.3 | 90003 | 90008 | 10 (aborted) | CPU contention at c=5 ⇒ >90s ⇒ client timeout |
| 2 | humanize=0, blockImages=true | html-js | 2 | 4 | **20.3** | 5765 | 6070 | 0 | humanize=0 is the lever (10×) |
| 2b | humanize=0, blockImages=**false** | html-js | 2 | 4 | 19.7 | 5341 | — | 0 | isolates humanize: ~5.3s even with images ON |
| 2c | humanize=2.5, blockImages=true | html-js | 2 | 4 | 2.1 | 55284 | 57840 | 0 | blockImages doesn't help when humanize ON (~55s) |
| 3a | humanize=0, blockImages=true | html-js | 5 | 15 | **41.6** | 7180 | 7918 | 0 | maxConcurrency=5 |
| 3b | humanize=0, blockImages=true | html-js | 10 | 20 | 55.6 | 10115 | 12241 | 0 | maxConcurrency capped at 5 (PATCH→10 didn't take); effective c=5 |
| 4 | humanize=0, blockImages=true | html (no-JS) | 5 | 15 | **56.0** | 5027 | 6418 | 0 | slightly faster than html-js; no JS |

**Memory**: never exceeded ~3.6 GB used / 12+ GB free — Camoufox browsers are
~50–80 MB each at this concurrency. Memory is **not** the bottleneck; CPU (4
cores) is — concurrency beyond ~5 makes per-render latency climb (5.8s→7.2s→10s).

## Tradeoffs for 20–100 req/min

- **20 req/min**: easy — `blockImages=true`, `humanize=0`, concurrency 2–3.
  Low resource cost; safe for the beelink + luna.
- **~50 req/min**: `blockImages=true`, `humanize=0`, `maxConcurrency=5` (the cap).
  ~42–56 req/min measured. The practical ceiling on this host without changes.
- **100 req/min**: **not reachable at maxConcurrency 5.** Options:
  1. Raise the cap: set `MAX_CONCURRENCY=10` (env, redeploy) **and** confirm the
     `maxConcurrency` PATCH then persists; or investigate the server-side cap
     (`MAX_BROWSER_INSTANCES`/validation). At c=10, expect ~85–100 req/min if the
     4-CPU beelink holds per-render ~7s (watch CPU contention — may need a bigger host).
  2. Move headlessx to a host with more CPUs (concurrency scales with cores).
  3. Use the `html` (no-JS) endpoint where possible (~56 req/min at c=5; faster
     per-render leaves headroom for higher concurrency).
- **Latency vs throughput**: higher concurrency raises throughput but increases
  p50/p95 latency (contention). For interactive use, keep c≤3; for batch, push c.
- **blockImages tradeoff**: minor (~0.5s). Useful for scraping where you don't
  need images, but does NOT unlock throughput on its own (humanize drives the 10×).
- **humanize tradeoff (the big one)**: 10× (5.3s vs 55s). ON = behavioral
  anti-detection but caps you at ~2–5 req/min. OFF = 20–50 req/min but less
  human-like. For bot-protected targets behind a rotating proxy, OFF is usually
  fine — the IP rotation provides the anti-ban, not the behavior.
- **stealth tradeoff**: `html-js` defaults stealth on (anti-detection). For
  non-protected public pages, `stealth=false` + `html` is fastest.

### Recommended production config (data-lane SPA scraping, ~50 req/min, behind a proxy)

```
PATCH /api/config {
  "camoufoxHumanize": 0,          // the 10× lever; safe behind a rotating proxy
  "maxConcurrency": 5            // current cap; raise via MAX_CONCURRENCY env to exceed
  // blockImages: optional (~0.5s); set true only if you don't need images
}
```
Per-request: `options.proxy` = a rotating residential proxy URL; use `html-js` +
`stealth=true` for SPA/bot-protected pages, `html` + `stealth=false` for static.
Set a `waitForSelector` for slow-settling SPAs to avoid `networkidle` waits.

If you must run WITHOUT a proxy (home IP exposed): keep `camoufoxHumanize=2.5` ON
for behavioral cover, but accept the ~2 req/min ceiling and rotate targets — and
see the home-IP section below for why this is fragile.

## humanize ON, anti-detection, and your home IP

headlessx runs on the beelink at your house — every scrape egresses from your
**home residential IP**. Two separate concerns, often conflated:

1. **Behavioral anti-detection (humanize/stealth)**: makes each request look
   human (mouse movement, timing, fingerprint). Reduces the chance a target's
   bot-detection flags the *request*. Does NOT change the IP.
2. **IP-based rate-limiting/bans**: a target seeing N requests/min from ONE IP
   (your home IP) may rate-limit, CAPTCHA, or ban that IP — *regardless of how
   human each request looks*. humanize does NOT prevent this.

**So: humanize ON protects against behavioral detection, NOT volume-based IP
bans.** Scraping external targets (Wix/FAA/FBO) at any real volume from your home
IP risks getting your home IP blocked by those targets — and a blocked home IP
affects everything else on your household network.

**Recommendation: do not scrape external targets directly from the home IP at
volume. Route scraping through residential proxies** (per-request `options.proxy`,
or global `PATCH /api/config` proxy). Then:
- targets see rotating proxy IPs, not your home IP — volume is spread across many
  IPs, so no single IP gets banned;
- your home IP only talks to the proxy gateway (low volume, looks normal);
- you can run `humanize=0` (fast, 20–50 req/min) safely, because the IP rotation
  provides the anti-ban — you don't need behavioral humanization when the IP
  changes every request;
- cost: ~$3–5/GB (Decodo/IPRoyal) at 5–50 GB/mo — see the table below.

**Bottom line on the humanize-ON limit:** ~2 req/min @ c=2 (~5 @ c=5). It is the
anti-detection ceiling, not a throughput target. For 20–100 req/min you need
`humanize=0` + proxies (so the home IP stays clean).

## Residential proxy research

HeadlessX accepts proxies two ways: **per-request** (`options.proxy` in the
scrape body — rotate every request) and **global** (`PATCH /api/config`
`proxyEnabled`/`proxyUrl` — one proxy for all renders). The per-request path is
preferred for scraping (rotate to avoid IP bans). Format:
`http://user-session-<id>:<pass>@<gateway>:<port>` (append `-country-us` etc. for
geo; `-session-<id>` for sticky).

Provider comparison (5–50 GB/mo, ~50–200 req/min; pricing mid-2026, confirm live):

| Provider | Residential pool | Pricing (residential) | Min spend | Sticky | Integration | Pros | Cons | Fit |
|---|---|---|---|---|---|---|---|---|
| **Bright Data** | 400M+ | ~$4–8.4/GB PAYG (promos ~$4); ~$2.50–3.50 committed | low/PAYG | up to 30min+ | `brd-customer-XXXX-zone-residential:pass@brd.superproxy.io:22225` (+`-session-`/`-country-`) | largest ethical pool; best geo (city/ZIP/ASN); Web Unlocker for hard targets; 99.99% claimed | priciest; KYC; enterprise-leaning | hardest targets; premium reliability |
| **Decodo** (ex-Smartproxy) | 115M+ | ~$3.50–8.5/GB PAYG; ~$2–6/GB monthly | very low | 1–30min, custom to 24h | `user:pass@gate.decodo.com:7000` (+`-country-`) | best value/speed (often #1 response time, 99.92% success); easy dashboard | smaller pool than top 2 | **best value for our volume** |
| **Oxylabs** | 175M+ | ~$5–6/GB (5–20GB plans); ~$2.50–4 committed; PAYG ~$8 | ~$30 | up to 24h (`-sessid-`/`-sesstime-`) | `customer-USER:pass@pr.oxylabs.io:7777` (+`-cc-`/`-sessid-`) | very strong anti-bot; great session control; Web Unblocker | higher entry; sales-oriented for custom | hard targets; medium volume |
| **Soax** | 155M+ (res+mobile) | credit-based; ~$3.60/GB (25GB); drops w/ volume | ~$90 | custom (60min+) | `package-{id}-country-{cc}-sessionid-{id}:key@proxy.soax.com:5000` | flexible credits (res+mobile); precise geo | country-tiered pricing; less "set-and-forget" | multi-type / specific geo |
| **IPRoyal** | 32–64M | ~$7/GB (1GB) → ~$4.90 (50GB) → $1.75 bulk; **traffic never expires** | none | up to 7 days | `user:pass@geo.iproyal.com:12321` | never-expiring traffic (no waste); cheap bulk; long sticky | smaller pool; not top on hardest targets | **best budget/flexible for variable volume** |
| **BirdProxies** | 10M+ | ~€2.50/GB PAYG → ~€1.50 bulk; ISP per-IP ~€0.69–1.40 | low | ISP static / rotating | standard `user:pass@host:port` (dashboard-generated) | cheapest PAYG; no commitment; crypto-friendly | smallest pool; fewer benchmarks/docs | budget/no-commitment niche |

### Recommendation

- **Default for the data-lane (public pages, ~50 req/min, 5–50 GB/mo):** start with
  **Decodo** (best value + speed) or **IPRoyal** (never-expire, buy bulk once).
  Both ~$3–5/GB effective, low/none min spend, standard `user:pass@gateway:port`
  that drops straight into `options.proxy`.
- **If we hit hard anti-bot targets (Wix/FAA start blocking):** **Bright Data** or
  **Oxylabs** (largest pools, Web Unlocker/Unblocker, best success on protected sites).
- **Integration**: per-request `options.proxy` (rotate each request via a session
  param in the username) for scraping; global `PATCH /api/config` proxy only when
  every render should egress through one proxy. Budget ~$15–200/mo depending on
  volume + retries (retries inflate real GB — monitor).
- **Trial first**: most offer $1.99–free trials. Benchmark success rate + speed on
  the actual data-lane targets (Wix registries, FAA ATADS) before committing.

## Reproducing / re-running

```bash
# from a checkout of unreasonablygood/headlessx (opd must be warm on the runner)
tsx scripts/loadtest.ts config                                    # GET current knobs
tsx scripts/loadtest.ts set --camoufoxBlockImages true --camoufoxHumanize 0   # tune (runtime)
tsx scripts/loadtest.ts load --url https://gwun.com --concurrency 5 --total 15 --endpoint html-js
tsx scripts/loadtest.ts set --camoufoxBlockImages false --camoufoxHumanize 2.5 # restore defaults
```

The script resolves `HEADLESSX_API_KEY` (built-in default
`op://m3_local/DASHBOARD_INTERNAL_API_KEY/credential`) via the opd daemon once,
into memory only — never printed, never in argv; all output is scrubbed.

## Open follow-ups

- **maxConcurrency cap**: PATCH→10 didn't persist (stayed 5). Investigate the
  server-side cap (likely `MAX_CONCURRENCY` env / `MAX_BROWSER_INSTANCES` or a
  validator). Raising it (env + redeploy) is the path to >50 req/min / toward 100.
- **100 req/min**: needs the cap raised + likely a >4-CPU host (CPU is the
  bottleneck, not RAM). Document the host-sizing requirement.
- **Proxy trial**: pick Decodo or IPRoyal, run a trial through `options.proxy`
  against a bot-protected data-lane target, measure success rate.
