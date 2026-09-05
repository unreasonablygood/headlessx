# HeadlessX Dashboard

`apps/web` is the Next.js dashboard for HeadlessX operators, API keys, jobs,
logs, proxies, and runtime configuration. It is part of the pnpm/Nx monorepo
and is not a standalone create-next-app or Vercel deployment.

## Run locally

From the repository root, configure the root `.env` and start the complete
development runtime:

```bash
cp .env.example .env
pnpm install
pnpm dev
```

To run only the dashboard while a compatible API is already available:

```bash
pnpm --filter headlessx-web dev
```

The default dashboard URL is `http://localhost:34872`.

## Internal API authentication

Browser requests use the server-side proxy under `src/app/api/[...path]`; the
dashboard credential must never be exposed to client components.

- Development reads `DASHBOARD_INTERNAL_API_KEY` from the non-production
  environment.
- Production reads the fixed root-owned `0400` file at
  `/run/secrets/headlessx-dashboard-internal-api-key` and does not fall back to
  an environment credential.

The supported self-host and production Compose flow mounts that file. See
`../../docs/setup-guide.md` for the mode-specific bootstrap contract.

## Browser admission

The dashboard has no in-app account/session layer. Self-host Compose therefore
binds its host port to `127.0.0.1` by default. CLI-managed production exposes
the dashboard only through the Caddy vhost, which requires a separate Basic
Auth username/password and strips `Authorization` before forwarding.

Do not publish the production web host port directly: browser requests would
otherwise reach administrative proxy routes without the Caddy boundary. The
public API domain is separate and keeps its normal `x-api-key` contract.

## Source map

- `src/app/` — App Router pages and server-side API proxy
- `src/components/playground/` — operator workbenches and shared UI
- `src/lib/playgroundAvailability.ts` — server-side operator availability
- `src/app/api/[...path]/route.ts` — authenticated backend forwarding

Use Space Grotesk and JetBrains Mono through `src/app/layout.tsx`; do not add
the removed create-next-app Geist setup.
