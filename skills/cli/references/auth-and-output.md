# Auth And Output

## Canonical Package And Command

- package: `@headlessx-cli/core`
- command: `headlessx`

## Install

```bash
npm install -g @headlessx-cli/core
headlessx --help
```

With pnpm:

```bash
pnpm add -g @headlessx-cli/core
headlessx --help
```

## Auth Precedence

Highest priority first:

1. command flags
2. environment variables
3. stored local credentials
4. default API URL

This precedence applies only to the published CLI against ordinary HeadlessX
API routes. The owner-installed fixed Tailnet client is a separate surface and
does not use these credentials.

Production dashboard Basic Auth is a separate browser-to-Caddy boundary. Its
password and bcrypt verifier are never CLI login credentials. Caddy removes
the browser `Authorization` header before the request reaches HeadlessX; the
public API domain and operator CLI continue to use `x-api-key`.

## Environment Variables

Primary names:

```bash
export HX_API_KEY=your_headlessx_api_key
export HX_API_URL=http://localhost:38473
```

Alternative names:

```bash
export HEADLESSX_API_KEY=your_headlessx_api_key
export HEADLESSX_API_URL=http://localhost:38473
```

## Login Patterns

Interactive:

```bash
headlessx login
```

Interactive `headlessx login` now uses a guided modern prompt with masked API key entry.

Prompt only for the missing field:

```bash
headlessx login --api-key your_headlessx_api_key
headlessx login --api-url http://localhost:38473
```

Direct login:

```bash
headlessx login --api-key your_headlessx_api_key --api-url http://localhost:38473
```

Inspect config:

```bash
headlessx config view
```

Clear config:

```bash
headlessx logout
```

## Output Rules

Prefer markdown/text output for agents and LLM-facing workflows.

Use `--json` only when:

- the user explicitly asks for machine-readable output
- another tool in the workflow will parse the response
- the output is going directly to a `.json` file

Common patterns:

```bash
headlessx google "latest ai news"
headlessx google "latest ai news" --json --pretty
headlessx scrape https://example.com --type content -o page.md
```

## Scoped verification

Use only the check that matches the requested result:

```bash
headlessx <command> --help
headlessx status
headlessx doctor
```

Command help verifies grammar. `status` and `doctor` verify lifecycle
configuration or reachability. Prove operator behavior with one bounded
operator request rather than an unrelated command sweep.

Status and doctor do not require an API key for local reachability checks.
When the CLI is not logged in, auth-dependent operator checks are reported as
skipped instead of failed.
