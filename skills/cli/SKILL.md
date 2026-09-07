---
name: cli
description: Use when operating a user-managed HeadlessX installation through the published `@headlessx-cli/core` command for lifecycle or one-shot operator work. It produces a bootstrapped workspace or bounded CLI result. Do not use for the owner-installed fixed Tailnet client, raw API or MCP calls, or interactive browser sessions.
---

# HeadlessX CLI

Use `headlessx` as the canonical published command. Check current command
grammar with:

```bash
headlessx --help
headlessx <command> --help
```

Do not reconstruct flags from examples when current help is available.

## Choose the surface

- Use lifecycle commands to initialize or operate a user-managed workspace
  under `~/.headlessx`.
- Use operator commands for one-shot work against a user-managed HeadlessX API.
- Use the Browser capability, not this skill, for authenticated or stateful
  interaction.
- The owner-installed fixed Tailnet `headlessx` client is a separate
  value-blind surface. It uses fixed identity admission and never uses this
  skill's login or API-key workflow.

## Conditional references

- Read `references/command-matrix.md` only when selecting an operator family or
  lifecycle command.
- Read `references/auth-and-output.md` when login, credential precedence, or
  output format matters.
- Read `references/operator-routes.md` only when confirming the API route
  behind a CLI operator.

## Lifecycle

Install and initialize:

```bash
npm install -g @headlessx-cli/core
headlessx init
```

The three saved modes have different runtime contracts:

- `developer` runs repository processes locally. It uses the root `.env` for
  non-production credentials and does not require Docker when PostgreSQL and
  Redis are provided another way.
- `self-host` runs the full Compose stack, binds host ports to `127.0.0.1` by
  default, and stores fixed source credentials privately under
  `~/.headlessx/repo/infra/docker/secrets`. Use a non-loopback `--host-bind`
  only when the user explicitly wants it and has named the outer access
  boundary; the CLI warns because the dashboard and data services move too.
- `production` uses the same loopback-bound credential-file-backed app stack
  plus public Caddy domains. Caddy requires a separate dashboard Basic Auth
  password while the API domain keeps ordinary API-key admission.

For Compose-backed modes, the CLI creates or safely migrates fixed app
credential files without printing their values. It never places those values
in the core Compose `.env`. An incomplete existing secret set is an error
rather than authority to regenerate credentials.

For production, use the masked password prompt. Never put the plaintext
dashboard password in arguments, logs, or files. Unattended setup may use a
precomputed `--dashboard-password-hash`; the stored bcrypt verifier is not an
API key or the dashboard-internal app credential. Keep production core ports
on loopback so callers cannot bypass Caddy.

Update an existing workspace before restart:

```bash
headlessx init update
headlessx restart
```

## Authentication and output

The published CLI calls ordinary protected API routes with a user-created
HeadlessX API key. Prefer interactive login:

```bash
headlessx login
```

Use flags or environment variables only when the user already supplied the
ordinary API URL and user key; see `references/auth-and-output.md`. Never use
the dashboard internal key or the fixed evidence credential for CLI login.

Prefer default markdown/text output for an agent or person. Use `--json` only
when a downstream consumer requires structured data.

## Proportional checks

Choose the smallest check that proves the requested surface:

- command composition: `headlessx <command> --help`;
- lifecycle reachability: `headlessx status` or `headlessx doctor`;
- operator behavior: one bounded invocation of that operator.

Do not run an unrelated catalog of help, status, login, logs, and operator
commands. A help screen proves grammar, not service readiness or operator
success.

## Completion

- Lifecycle work completes when the saved mode is configured and the requested
  service reports reachable through `status` or `doctor`.
- Operator work completes only with usable output for the requested target.
- A login/config write without a successful requested operation is not an
  operator result.
- Preserve bounded failures; do not fall back to raw HTTP or another
  credential path.
