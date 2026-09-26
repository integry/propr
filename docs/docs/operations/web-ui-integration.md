# Web UI Integration Guide

This guide is for contributors working on ProPR's browser UI or building against the dashboard API. It explains how the UI fits together with the API, workers, and GitHub automation services — ports, authentication, WebSockets, and where to add code when extending the integration. For a tour of the UI's screens and what each does, see the [Web UI Guide](../features/web-ui.md). For deploying the UI and API in production, see [Production Deployment](./deployment.md); for driving a local stack from the hosted UI, see [Hosted UI Tunnel](./hosted-ui-tunnel.md).

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

- Browser sessions start at `GET /api/auth/github` and finish at `GET /api/auth/github/callback`. Relay-enrolled stacks use `PROPR_WEB_AUTH_MODE=connect` for local loopback URLs and hosted tunnels: Connect owns the shared GitHub OAuth client and hands the instance a short-lived one-use code. Custom deployments may use `PROPR_WEB_AUTH_MODE=github` with their own `GH_OAUTH_CLIENT_ID` and `GH_OAUTH_CLIENT_SECRET`.
- Sessions are stored in Redis (`propr:session:` prefix) and sent as cookies; all frontend fetches use `credentials: 'include'`.
- All `/api/*` routes require authentication; CORS is configured from `FRONTEND_URL`.
- Bearer token authentication (GitHub tokens validated against the GitHub API, cached briefly in Redis) is enabled by default for the CLI; disable it with `ENABLE_BEARER_AUTH=false`.
- `PROPR_DEMO_MODE=true` allows read-only access without login and blocks mutating requests.

## Key API Surfaces

The frontend uses the dashboard API rather than a mock layer. Common integration points include:

- `GET /api/status` for daemon, worker, Redis, GitHub auth, agent health, and indexing state
- `/api/agents/:agentId/login-sessions/*` for short-lived Docker-backed coding-agent login output, input, status, and cancellation
- `GET /api/queue/stats` for queue depth and throughput
- `GET /api/tasks` and the `/api/task/:taskId/...` detail endpoints for execution history, live details, file changes, and Docker logs
- `GET /api/stats/tasks`, `/api/stats/repositories`, and `/api/stats/overview` for dashboard statistics
- `GET /api/dashboard/summary`, `/api/dashboard/attention`, `/api/dashboard/active`, and `/api/dashboard/outcomes` for what needs attention, what is running, and what just happened; each accepts `repository=all` or `repository=owner/repo`. Attention is derived from task and plan-issue state, never from notification read or dismissal state
- `GET /api/stats/dashboard?period=7d|30d` for the dashboard's historical section (completed, success rate, recorded spend, daily chart) with a previous-period comparison
- `GET /api/llm-logs` and `GET /api/llm-metrics` for per-call LLM records and aggregates
- `GET /api/config/*` routes for repositories, settings, agents, and follow-up configuration
- `/api/planner/*` routes for Planner Studio drafts, generation, and execution
- Auth routes under `/api/auth/github/*` for GitHub login flows
- socket.io events for task updates and queue stats, so dashboard panels refresh without polling

When you extend the UI, prefer adding or reusing API routes in `packages/api/` and keeping browser calls centralized in `propr-ui/src/api/`.

## Realtime Updates: Push First, Poll Only As A Fallback

While it is connected, the UI does **not** poll the API on a timer. The backend
publishes an event whenever a relevant change is detected, and the UI refreshes
because of that event.

| Event | Published when | Consumed by |
| --- | --- | --- |
| `task:update` | a task's worker state changes | task detail, task list, header activity |
| `draft:update` / `plan:step:update` | planner generation progresses or finishes | Plan Studio, Plans page |
| `indexing:update` | repository indexing progresses | Repositories page |
| `queue:stats:update` | queue depth or throughput changes | header activity monitor |
| `notification:update` | a notification is created, read or dismissed | Inbox, unread badge |
| `usage:update` | agent capacity or quota changes | usage sidebar, system status |
| `activity:update` | derived from the lifecycle events above, plus the `health` domain when the instance's own health moves | header stats, shared system status (which ignores `change: 'progress'`) |

`activity:update` is the general envelope (`domain`, `change`, `repository`,
`subjectId`, `terminal`, `occurredAt`). It is derived in
`packages/api/services/activityEvents.ts` from the events the backend already
publishes, so a new consumer declares an interest by domain rather than matching
worker state strings, and a new producer publishes its own domain event and lets
the API derive the envelope.

Some events carry the changed data; others — `usage:update` in particular — are
deliberately triggers for the existing authenticated read, so the endpoint keeps
owning its projection and its permission check. `notification:update` is
published into the recipient's socket room only, and names the notification it
concerns so the tab that made the change can recognise its own echo and leave
its optimistic state alone.

Three rules are non-negotiable for any surface that consumes these events. A
plain read gets them from `propr-ui/src/hooks/useLiveResource.ts` (built on
`useLiveRefreshScheduler`); surfaces that own more local state implement the
same contract themselves — `useHeaderStats` for its four independently
reconciled resources, and `useInboxRefreshTriggers` for the Inbox, whose
optimistic dismissals must not be undone by a pushed refresh:

1. **Reconnect reconciliation** — exactly one catch-up read per connect or
   reconnect transition, so nothing is missed while the socket was down.
2. **Fallback polling** — an interval read armed *only* while the websocket is
   unavailable, so a client without a socket degrades instead of going stale.
3. **Page visibility** — a hidden or backgrounded tab issues no requests, and
   reconciles once when it becomes visible again.

Do not add a `setInterval` that fetches. If a surface needs to know about a
change, publish an event for it.

### Where The Producers Live

A surface that stopped polling is only as fresh as its producer, so every event
above has one:

- `notification:update` is published by `packages/api/routes/notificationRoutes.ts`
  for a read, dismissal or bulk clear, and — for the changes no request causes —
  by `packages/api/services/notificationProjectionService.ts` (a notification the
  projection creates, and the receipts its cleanup dismisses once a stalled or
  failed activity resolves) and by `NotificationService` itself when a pull
  request is merged or closed and its cards are cleared. Those producers run
  outside the process that owns the websocket, so they publish through Redis
  (`publishNotificationUpdateThroughRedis`) and the socket service relays the
  event to the recipient's room.
- `usage:update` is published when Agent Tank settings are saved, when a manual
  re-probe succeeds, and by `packages/api/services/agentTankUsageWatcher.ts`.
  Agent Tank cannot call us, so that watcher is one of the two timers left in
  the system: the API probes it for the whole instance — only while a client is
  connected — and publishes only when the snapshot actually moved. One backend
  probe replaces the same poll in every open tab.
- `activity:update` with `domain: 'health'` is published by
  `packages/api/services/systemHealthWatcher.ts`, the other remaining timer. A
  worker, the daemon, Redis, GitHub authentication or a coding agent can stop
  while the API and every client socket stay up, and no run lifecycle event says
  so, so there is nothing to derive a health change from: the watcher compares
  the same `/api/status` snapshot the clients read (the route exposes it as
  `readStatusSnapshot`) against an allowlist of the health fields, ignoring the
  response timestamp and routing diagnostics, and publishes only when what the
  health surfaces show actually moved. The one snapshot it watches replaces the
  30-second `/api/status` poll that used to run in every open tab.

Both watchers publish the first state they observe while a client is connected.
A client that read before the first probe may already be behind, and suppressing
that first publication would strand it: every later probe sees the same state
and stays silent, so nothing would ever correct it while its socket stays up.

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

In production, the UI and API can be deployed behind the same domain or different subdomains. In the launcher stack, the UI is the `propr/ui` container (port 5173) and the API is part of the `propr/app` image (port 4000). Reverse-proxy routing, TLS, and the `FRONTEND_URL` / `GH_OAUTH_CALLBACK_URL` wiring are covered in [Production Deployment](./deployment.md); publishing a local API to the hosted UI at `app.propr.dev` is covered in [Hosted UI Tunnel](./hosted-ui-tunnel.md).

If you build your own frontend around ProPR, treat the dashboard API as the system contract and reuse the existing route structure instead of re-implementing worker or daemon logic in the browser.

## API Base URL Resolution

The frontend resolves its API base URL at load time, which is what lets one published UI image serve any backend. The resolution order is: Connect tunnel query param on `app.propr.dev` → remembered hosted tunnel selection → runtime config (`window.__PROPR_CONFIG__.apiBaseUrl`, which the `propr/ui` container rewrites at start from `PROPR_UI_PUBLIC_API_URL`) → build-time `VITE_API_BASE_URL` → empty string (same-origin, local dev through the Vite proxy). **REST and Socket.IO use this same resolved base**, so both always target one origin.

The hosted-UI entries in that chain exist because `app.propr.dev` is one static bundle serving many local stacks — the deployment-side story (Cloudflare Tunnel, `t-<id>.propr.dev` proxy hosts, `FRONTEND_URL` / `API_PUBLIC_URL`) lives in [Hosted UI Tunnel](./hosted-ui-tunnel.md). For the broader hosted bridge that owns GitHub event routing, relay tokens, and managed tunnel coordination, see [ProPR Connect](./propr-connect.md).

## Extending The Integration

When adding new UI features:

1. Add or update the API route in `packages/api/`
2. Add a typed client function under `propr-ui/src/api/`
3. Connect the UI component or page to that client
4. Verify auth, repository scoping, and task visibility behavior in the browser

This keeps the browser layer thin and ensures operational behavior continues to live in the backend services that already own task execution.
