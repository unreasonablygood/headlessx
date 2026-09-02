# HeadlessX production service runbook

HeadlessX provides one-shot Camoufox/Firefox rendering for public pages. The
production API runs on `ml-beelinks12-01` and is reachable only through the
fixed Tailnet listener `100.83.166.127:38473`.

## Deploy contract

| | |
|---|---|
| Repository | `unreasonablygood/headlessx` |
| Branch | `main` |
| Compose | `/docker-compose.coolify.yml` |
| Coolify application | `bs00lje88r6kest212hp8i6b` |
| Server | `ml-beelinks12-01` |
| Published API | `100.83.166.127:38473` |

The production Compose runs the API, PostgreSQL, Redis, HTML-to-Markdown, and
YouTube engine. Only the API port is published. Internal dependencies remain on
the isolated `headlessx-network`.

## Credential ownership

The host selects an atomically installed generation under
`/etc/headlessx/credentials/current`. Compose mounts four fixed root-owned
`0400` files:

- `evidence-api-key`;
- `postgres-password`;
- `dashboard-internal-api-key`; and
- `credential-encryption-key`.

The API reads all three application credentials from `/run/secrets`; the
evidence credential never enters the process environment. PostgreSQL uses its
standard password-file input, and the API entrypoint constructs `DATABASE_URL`
from the same mounted password file. Coolify environment rows are not the
runtime credential source.

The supported materializer runs from either trusted seat:

```sh
web-service-materializer materialize headlessx
web-service-materializer status headlessx
web-service-materializer rollback headlessx
```

The remote helper has no credential resolution authority. It accepts one
binary-framed complete generation over fixed Tailnet SSH, validates the service
and file set, writes a new root-owned generation, and atomically selects it.

## Scrape admission

The fixed public-page endpoints are:

```text
POST /api/operators/website/scrape/html
POST /api/operators/website/scrape/html-js
POST /api/operators/website/scrape/content
POST /api/operators/website/scrape/screenshot
POST /api/operators/website/evidence
```

The m3 (`100.122.151.60`) and ml-infra-02 (`100.66.252.122`) seats are admitted
by source identity without a reusable bearer. The WebDocument service
(`100.92.188.36`) must present the dedicated evidence credential as well as its
source identity. Other Tailnet identities are refused on these routes. Existing
dashboard and user API-key authentication remains available only outside this
fixed trusted-seat admission.

The installed `headlessx` client has the fixed service address, sends no
credential, rejects authenticated or non-public target URLs, disables ambient
proxies, and emits bounded responses. `GET /api/health` remains unauthenticated.

## Deployment acceptance

After a source deployment or credential rotation:

1. confirm Coolify reports the application running and healthy;
2. run `headlessx status` from m3 and ml-infra-02;
3. render one public JavaScript page from each seat;
4. capture one WebDocument rendered result;
5. prove the prior evidence credential is refused from the WebDocument source;
6. prove an unapproved Tailnet node is refused; and
7. restart the service while local Connect and the retired credential broker
   are unavailable, then repeat the direct and WebDocument canaries.

Rollback is source rollback in Coolify plus
`web-service-materializer rollback headlessx` when the credential generation
must also be restored.

## Upstream review

The repository tracks the original HeadlessX project. Treat upstream updates as
source inputs: review the browser bundle, API surface, container privileges,
Compose shape, and URL-admission behavior before merging. The production
Compose and fixed trusted-admission contract remain owner-controlled.
