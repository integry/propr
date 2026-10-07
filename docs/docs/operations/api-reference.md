---
title: API reference
description: OpenAPI 3.1 reference of the ProPR dashboard HTTP API, its authentication and error contract, and the @propr/client TypeScript client.
---

# API reference

The web UI, the desktop app and the CLI all talk to one HTTP API, served by the dashboard API process under `/api`. Use it for monitoring, custom dashboards and CI scripts.

- [Open the interactive reference](pathname:///openapi/index.html) (full screen)
- [Download the OpenAPI 3.1 spec](pathname:///openapi/propr-api.yaml) (`propr-api.yaml`), for code generators, Postman or Insomnia

The spec is generated from the API route registry, so it lists every route the server registers. The interactive reference ships with the docs, so it also works in the offline copy `propr docs` serves. The [`@propr/client`](#typescript-client) types come from the same schemas.

<iframe
  src="/openapi/index.html"
  title="ProPR dashboard API reference"
  width="100%"
  height="900"
  loading="lazy"
  style={{border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: '8px'}}
></iframe>

## Authentication

Unless an operation says otherwise, send one of these:

| Credential | How to send it | Notes |
| --- | --- | --- |
| Browser session | The session cookie set by `GET /api/auth/github` | Used by the web UI. |
| GitHub token | `Authorization: Bearer <token>` | Accepted while `ENABLE_BEARER_AUTH` is not `false`, which is the default. The token is checked against GitHub and cached for five minutes. Used by the CLI. |
| Instance token | `Authorization: Bearer propr_it_…` | Issued by [desktop pairing](./desktop-pairing.md). |
| MCP access token | `Authorization: Bearer …` on `/api/mcp` only | Issued by the [MCP OAuth flow](../features/mcp.md). Each tool checks its scope. |

The GitHub account behind the credential must be allowed on the instance (see [GitHub authentication](./github-auth.md)). Operations marked `x-propr-permission` also need that instance permission, for example `instance.manage_settings`. Admins hold every permission. A demo instance rejects every request that changes data.

Unauthenticated routes are listed with an empty `security` requirement. They cover health, compatibility, desktop discovery, the pairing bootstrap, the login redirects and the MCP OAuth endpoints (`/authorize`, `/token`, `/register`, `/revoke`).

## Errors

New routes return the common error envelope for every `4xx` and `5xx` response:

```json
{
  "code": "TASK_NOT_FOUND",
  "message": "No task with this id exists.",
  "hint": "List tasks with GET /api/tasks to find the id."
}
```

Most existing routes still return an older ad-hoc shape, `{ "error": "…" }`, sometimes with `code` and `message`. These operations are marked `x-legacy-error: true` and reference the `LegacyError` schema, so clients can tell which shape to expect. Their behaviour does not change until each route is migrated.

## Coverage

Routes that have no annotation yet are still in the spec, marked `x-undocumented: true`. `info.x-route-coverage` in the spec counts documented and undocumented routes. Undocumented routes are usable, but their request and response bodies are not described yet and may change between releases.

To document a route, contributors add an entry to `packages/api/openapi/routeDocs*.ts`, describe its bodies as zod schemas in `packages/api/openapi/schemas.ts`, and run `npm run gen:openapi`. Pull request checks run `npm run gen:openapi:check`. It fails when the committed spec or the generated client types are stale, or when the spec is not valid OpenAPI 3.1.

## TypeScript client

[`@propr/client`](https://github.com/integry/propr/tree/main/packages/client#readme) is the REST and Socket.IO client the CLI and the desktop app use. It has typed methods for listing tasks, reading a task's events and creating task submissions, plus an authenticated `request()` for any other route. Its request and response types (`ProprApi.*`) are generated from this spec. `npm run check:client-contract` fails when the methods and the spec disagree.

```ts
import { ProprClient } from '@propr/client';

const client = new ProprClient({
  baseUrl: 'https://propr.example.com',
  authentication: { type: 'bearer', getAccessToken: () => process.env.GITHUB_TOKEN },
});

const { tasks } = await client.listTasks({ status: 'attention', limit: 20 });
```

## Quick start with curl

```bash
export PROPR_URL=https://propr.example.com
export TOKEN=$(gh auth token)

# Version and compatibility (no credentials)
curl -s "$PROPR_URL/api/compatibility"

# Tasks that need attention
curl -s -H "Authorization: Bearer $TOKEN" "$PROPR_URL/api/tasks?status=attention&limit=20"

# Submit a task; repeating the request with the same key does not open a second issue
curl -s -X POST "$PROPR_URL/api/task-submissions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"repository":"acme/app","instruction":"Fix the login redirect loop"}'
```

For the aggregate dashboard and statistics endpoints, see [Metrics](./metrics.md).
