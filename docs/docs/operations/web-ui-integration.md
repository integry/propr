# Web UI Integration Guide

This guide explains how ProPR's browser UI fits together with the dashboard API, workers, and GitHub automation services — ports, authentication, WebSockets, and deployment. For a tour of the UI's screens and what each does, see the [Web UI Guide](../features/web-ui.md).

## Overview

The browser UI is a thin client over the dashboard API. In this repository:

- The frontend lives in `propr-ui/`
- The dashboard API lives in `packages/api/`
- The daemon and workers handle repository polling, task execution, and PR automation

The frontend talks to the dashboard API over HTTP and WebSockets. The API reads shared state from Redis plus the shared SQLite application database used by the default deployment. That gives the UI access to task activity, repository configuration, agent settings, planner workflows, and operational metrics. What each of those surfaces looks like to a user is covered in the [Web UI Guide](../features/web-ui.md); this page focuses on how they connect.

## Responsibility Split

The Web UI renders state and sends authenticated requests; it holds no task-execution logic. The screens it presents — dashboard, tasks, repositories, agents, planner, settings — are documented in the [Web UI Guide](../features/web-ui.md).

The backend is responsible for:

- GitHub App authentication, webhooks, and issue or PR automation
- Queue coordination and worker orchestration
- Running supported coding agents in isolated execution environments
- Persisting operational data in Redis and the shared application database, then exposing it through API endpoints

## Ports And Processes

| Component | Default port | Notes |
|---|---|---|
| Web UI | 5173 | Static bundle served by a dedicated container (`propr/ui` image, `serve`); Vite dev server in development |
| Dashboard API | 4000 | Express server (`packages/api/server.ts`), `DASHBOARD_API_PORT` |
| Webhook endpoint | 4000 | `POST /webhook` on the API, when `GITHUB_EVENT_INTAKE_MODE=direct_webhook` |
| WebSockets | 4000 | socket.io at `/socket.io/` on the API origin |

The UI is not served by the API container. In both the launcher stack and the development Compose stack it runs as its own container; the API, daemon, and workers share the SQLite database volume while Redis handles queue and cache state.

## Authentication

- Browser sessions use GitHub OAuth (`GET /api/auth/github` → `GET /api/auth/github/callback`). Configure `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET`, and `GH_OAUTH_CALLBACK_URL`; the callback URL must match the GitHub OAuth App settings and the public API origin.
- Sessions are stored in Redis (`propr:session:` prefix) and sent as cookies; all frontend fetches use `credentials: 'include'`.
- All `/api/*` routes require authentication; CORS is configured from `FRONTEND_URL`.
- Bearer token authentication (GitHub tokens validated against the GitHub API, cached briefly in Redis) is enabled by default for the CLI; disable it with `ENABLE_BEARER_AUTH=false`.
- `PROPR_DEMO_MODE=true` allows read-only access without login and blocks mutating requests.

## Key API Surfaces

The frontend uses the dashboard API rather than a mock layer. Common integration points include:

- `GET /api/status` for daemon, worker, Redis, GitHub auth, agent health, and indexing state
- `GET /api/queue/stats` for queue depth and throughput
- `GET /api/tasks` and the `/api/task/:taskId/...` detail endpoints for execution history, live details, file changes, and Docker logs
- `GET /api/stats/tasks`, `/api/stats/repositories`, and `/api/stats/overview` for dashboard statistics
- `GET /api/llm-logs` and `GET /api/llm-metrics` for per-call LLM records and aggregates
- `GET /api/config/*` routes for repositories, settings, agents, and follow-up configuration
- `/api/planner/*` routes for Planner Studio drafts, generation, and execution
- Auth routes under `/api/auth/github/*` for GitHub login flows
- socket.io events for task updates and queue stats, so dashboard panels refresh without polling

When you extend the UI, prefer adding or reusing API routes in `packages/api/` and keeping browser calls centralized in `propr-ui/src/api/`.

## Running The UI In Development

1. Start the ProPR backend services you need for local development.
2. Create a frontend env file:

```bash
cp propr-ui/.env.example propr-ui/.env
```

3. Start the frontend:

```bash
cd propr-ui
npm ci
npm run dev
```

The Vite dev server runs on `http://localhost:5173` by default. `VITE_API_URL` sets the dev-server proxy target for `/api` requests (typically `http://localhost:4000`); `VITE_API_BASE_URL` sets the absolute API base URL compiled into the bundle (leave it empty to use same-origin requests through the proxy). The socket.io client also connects to `VITE_API_BASE_URL` when set.

## Production Integration

In production, the UI and API can be deployed behind the same domain or different subdomains. In the launcher stack, the UI is the `propr/ui` container (port 5173) and the API is part of the `propr/app` image (port 4000).

Important integration points:

- Point the frontend at the correct API origin so browser requests reach the dashboard API. Prefer runtime config (`PROPR_UI_PUBLIC_API_URL` → `window.__PROPR_CONFIG__.apiBaseUrl`), which lets one published image serve any backend; build-time `VITE_API_BASE_URL` is a fallback for single-target builds. See [Hosted UI And Runtime Config](#hosted-ui-and-runtime-config) below
- Configure `GH_OAUTH_CALLBACK_URL` to match the public API origin
- Allow credentials and cookies to flow correctly if the UI and API are on different origins (`FRONTEND_URL` drives the API's CORS configuration)
- Route `/api/*`, `/webhook`, and `/socket.io/` traffic to the dashboard API if you serve everything behind one reverse proxy, and enable WebSocket upgrades for `/socket.io/`

If you build your own frontend around ProPR, treat the dashboard API as the system contract and reuse the existing route structure instead of re-implementing worker or daemon logic in the browser.

## Hosted UI And Runtime Config

The hosted ProPR UI at `https://app.propr.dev` is one static bundle that serves many local stacks, so its API base URL cannot be baked in at build time. Instead the browser reads it at runtime from `window.__PROPR_CONFIG__`, which the UI container rewrites at start from `PROPR_UI_PUBLIC_API_URL`. The resolution order is: runtime config (`window.__PROPR_CONFIG__.apiBaseUrl`) → build-time `VITE_API_BASE_URL` → empty string (same-origin, local dev through the Vite proxy). **REST and Socket.IO use this same resolved base**, so both always target one origin.

When a local stack opts in to the hosted UI, an optional Cloudflare Tunnel publishes its **API** (the API container on port 4000) at a per-instance `https://<PROPR_INSTANCE_ID>.proxy.propr.dev` host — distinct from the vendor-run hosts (`app.propr.dev` for the UI, `webhook.propr.dev` for routing/relay). The browser is loaded from `app.propr.dev` and calls the API at that proxy host, so the two are different origins: set `FRONTEND_URL` to the hosted UI origin (`https://app.propr.dev`, the CORS allow-origin) and `API_PUBLIC_URL` plus `GH_OAUTH_CALLBACK_URL` to the proxy host. `http://api:4000` remains the internal service-to-service address inside the Docker network. See [Production Deployment → Hosted UI Tunnel](./deployment.md#hosted-ui-tunnel) for the full architecture and config block.

For the broader hosted bridge that owns GitHub event routing, relay tokens, and
managed tunnel coordination, see [ProPR Connect](./propr-connect.md).

## Extending The Integration

When adding new UI features:

1. Add or update the API route in `packages/api/`
2. Add a typed client function under `propr-ui/src/api/`
3. Connect the UI component or page to that client
4. Verify auth, repository scoping, and task visibility behavior in the browser

This keeps the browser layer thin and ensures operational behavior continues to live in the backend services that already own task execution.
