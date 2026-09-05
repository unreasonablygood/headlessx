# Changelog

## 2026-09-05 — Protect public production dashboard access

- **Changed:** Made loopback the Compose host-port default, documented the warned self-host bind opt-in, and routed production setup through a masked Caddy Basic Auth password flow with no plaintext flag.
- **Why:** The public dashboard proxy holds administrative authority through its internal API credential, while the prior production Caddy vhost admitted browsers without a separate access boundary.
- **Evidence:** Dashboard proxy and API-key management callers, CLI lifecycle source, Compose bindings, and the production Caddy configuration.
- **Impact:** Production dashboard browsers authenticate to Caddy before reaching HeadlessX; public API and CLI callers retain their ordinary API-key contract, and the owner API-only deployment is unchanged.

## 2026-09-05 — Separate user-managed CLI operation from fixed owner admission

- **Changed:** Narrowed routing to the published user-managed CLI, moved command detail behind conditional references, documented mode-specific credential files, and replaced the broad smoke itinerary with checks scoped to the requested command.
- **Why:** The skill mixed ordinary API-key operation with unrelated maintainer publication and encouraged unrelated checks while the owner fork also has a distinct credential-free fixed Tailnet client.
- **Evidence:** Current CLI lifecycle source, Compose contract, API trusted-admission middleware, and the owner production runbook.
- **Impact:** Ordinary CLI work continues to use user-created API keys; fixed trusted-seat admission and maintainer publishing no longer enter this runtime workflow.
