# HeadlessX repository guidance

This is the `unreasonablygood/headlessx` owner fork. It contains a self-hosted
scraping platform, a dashboard, queue-backed workers, sidecars, the published
user-managed CLI, and the owner-operated direct API deployment.

Source code and the mode-specific documents below are authority. Do not copy
command catalogs or credential recipes into this file.

## Start with the owning source

Read only the authority for the task:

| Work | Source and contract |
| --- | --- |
| API route or auth | `apps/api/src/app.ts`, matching route/middleware, `docs/api-endpoints.md` |
| Browser behavior | `apps/api/src/services/scrape/`, `packages/headfox-js/` |
| Dashboard | `apps/web/README.md`, `apps/web/src/app/`, `apps/web/src/components/` |
| Published CLI | `packages/cli/src/`, `packages/cli/README.md`, `skills/cli/` |
| Local/self-host setup | `docs/setup-guide.md`, `infra/docker/docker-compose.yml` |
| Caddy domains | `infra/domain-setup/README.md` |
| Owner direct production | `docs/runbooks/headlessx.md`, `docker-compose.fleet.yml` |
| Security or responsible use | `docs/SECURITY.md`, `docs/ETHICS.md` |

The external `headlessx.saify.me` documentation is a separate repository. Do
not treat it as source authority for this fork.

## Repository map

```text
apps/api/                    Express API, worker, MCP, Prisma, browser services
apps/web/                    Next.js dashboard and server-side API proxy
apps/yt-engine/              Python YouTube sidecar
apps/go-html-to-md-service/  Go HTML-to-Markdown sidecar
packages/cli/                @headlessx-cli/core
packages/headfox-js/         Camoufox-compatible browser launcher
infra/docker/                full Compose app stack
infra/domain-setup/          optional production Caddy layer
skills/cli/                  published CLI agent workflow
```

Use pnpm only. The repository enforces it through `preinstall`.

## Runtime and credential modes

| Mode | Runtime | Credential authority |
| --- | --- | --- |
| `developer` | local API, worker, web, and sidecar processes | root `.env`; environment credentials are allowed only because the processes are non-production |
| `self-host` | full `infra/docker` Compose stack, host ports on `127.0.0.1` by default | private source files under `~/.headlessx/repo/infra/docker/secrets`; core `.env` is non-secret |
| CLI-managed `production` | the same app stack plus public `infra/domain-setup` Caddy | root-owned `0400` app credential volumes plus a private domain `.env` containing only the dashboard bcrypt verifier |
| owner API-only production | `docker-compose.fleet.yml` on the fixed Tailnet listener | root-owned `0400` files under `/etc/headlessx/credentials/current`, mounted directly |

The CLI creates or migrates the database, dashboard-internal, encryption, and
evidence credential files without printing values. An existing incomplete set
is an error; never regenerate a database or encryption credential implicitly.
For production browser access, it masked-prompts for a separate dashboard
password, sends it to the fixed Caddy hasher over stdin, and persists only the
bcrypt verifier. In production, the fixed app credentials do not fall back to
`.env`, Coolify rows, or caller-selected secret paths.

Developer mode requires reachable PostgreSQL and Redis but not Docker when
those services are provided another way. `self-host` and `production` require
Docker Engine with Compose v2.

## Authentication boundary

| Surface | Admission |
| --- | --- |
| `GET /api/health` | unauthenticated |
| ordinary protected API routes | `x-api-key` with a user-created key or the dashboard internal key |
| production dashboard browser | Caddy Basic Auth with the configured operator username and bcrypt verifier |
| dashboard server proxy | fixed dashboard internal key; never exposed to browser components |
| MCP `/mcp` | user-created API key only |
| published `@headlessx-cli/core` operator commands | user-created API key through login, flags, or documented env precedence |
| fixed owner website scrape/evidence paths | compiled trusted-seat Tailnet identity; WebDocument additionally presents the fixed evidence credential |

The trusted exception is limited to the website paths enumerated in
`docs/runbooks/headlessx.md`. Other Tailnet identities are refused there.
Public callers fall through to ordinary API-key authentication. Never use
`DASHBOARD_INTERNAL_API_KEY` or the evidence credential for MCP, published CLI
login, or external clients.

The owner-installed fixed Tailnet `headlessx` client and the published
`@headlessx-cli/core` binary share a name but not an admission model. Preserve
that distinction in code and documentation.

## Development

Repository development needs Node.js 22+, pnpm 10.32.1+, PostgreSQL, Redis,
Python/uv for `yt-engine`, and Go for the Markdown sidecar.

```bash
pnpm install
cp .env.example .env
pnpm db:push
pnpm exec headfox-js fetch
pnpm run models:download
pnpm dev
```

`pnpm dev` starts app processes and sidecars, not PostgreSQL or Redis. Compose
host ports bind to `127.0.0.1` by default: web `34872`, API `38473`, PostgreSQL
`35432`, Redis `36379`, HTML-to-Markdown `38081`, and yt-engine `38090`.
Non-loopback self-host binding is an explicit warned opt-in; production core
ports remain loopback-only because public access enters through Caddy.

## Change routing

- API changes belong in the matching controller/service/route. Apply
  `ApiKeyGuard` and `RequestLogger` where the surrounding route family does,
  then update `docs/api-endpoints.md` when the public contract changes.
- Operator changes must stay coherent across backend, MCP registration when
  exposed, dashboard workbench, published CLI when exposed, and the relevant
  CLI reference.
- Dashboard browser requests use `/api/...` through
  `apps/web/src/app/api/[...path]/route.ts`; do not call protected backend
  routes directly from client components.
- CLI handlers live under `packages/cli/src/commands/`; shared HTTP, config,
  workspace, and lifecycle behavior lives under `packages/cli/src/utils/`.
- Prisma schema changes start in `apps/api/prisma/schema.prisma`; use the
  repository's `db:*` targets rather than ad hoc Prisma commands.
- Extend `BrowserService` and the existing scrape services before introducing
  another browser lifecycle.

## Runtime invariants

- Queue jobs and website crawl require Redis and the separate worker.
- Google AI Search requires the one-time dashboard `Build Cookies` flow and the
  shared persistent browser profile.
- YouTube is active only when `YT_ENGINE_URL` reaches a healthy yt-engine.
- Browser profiles belong under `apps/api/data/browser-profile/` locally or the
  Docker volume; never commit them or restore the removed default-data bundle.
- Browser bundles must be fetched for local scraping; the API image fetches its
  bundle during build.
- The CAPTCHA models belong in `apps/api/models/`.
- The Google stream terminates with `end`; other SSE contracts are documented
  in `docs/api-endpoints.md`.

## Style and verification

- Root/API/web/headfox-js use Biome conventions: two spaces in TypeScript,
  single quotes, semicolons, and no explicit `any`. The CLI package uses
  Prettier.
- Reuse existing route, service, workbench, and command patterns. Do not create
  a second registry or copied command catalog.
- Validate the changed surface, not an unrelated itinerary. CLI behavior uses
  `pnpm --filter @headlessx-cli/core test`; headfox-js uses its package tests;
  web UI changes require the actual browser surface.
- Help output proves command grammar only. Service readiness requires
  `headlessx status` or `headlessx doctor`; operator behavior requires one
  bounded operator request.
- Update existing docs when behavior changes. Do not create planning or report
  documents as a substitute for the implementation.

Never commit `.env`, `infra/docker/secrets`, API keys, encryption material,
browser profiles, or generated model binaries.
