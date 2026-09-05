# headlessx Tests

The original pasted Firecrawl test surface has not been kept as the source of truth for `headlessx`.

Current package direction:

- HeadlessX-first command tree
- API-key auth for operator commands; production dashboard Basic Auth is a lifecycle boundary
- pnpm workspace compatibility
- no MCP commands in `0.1.24`

Current isolated coverage focuses on:

- loopback health fallback for localhost-based checks
- production dashboard Basic Auth challenge reachability
- loopback-by-default Compose host binding
- fixed Compose credential creation, permissions, and incomplete-set refusal
- removal of migrated credential values from Compose `.env`
- Caddy dashboard verifier validation, stdin-only hashing, and plaintext leak prevention
- protected Caddy configuration refresh refusal for legacy templates
- production dashboard fixed-file loading with no environment fallback
- mode-specific runtime prerequisites

Extend it with observable config, payload, polling, or output behavior when
those contracts change.
