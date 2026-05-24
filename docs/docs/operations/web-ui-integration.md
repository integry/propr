# ProPR Web UI Integration Guide

This guide explains how ProPR's browser UI fits together with the dashboard API, workers, and GitHub automation services.

## Overview

ProPR's Web UI is a live operational surface, not a placeholder project. In this repository:

- The frontend lives in `propr-ui/`
- The dashboard API lives in `packages/api/`
- The daemon and workers handle repository polling, task execution, and PR automation

The frontend talks to the dashboard API over HTTP, and the API reads shared state from Redis plus the shared SQLite application database used by the default deployment. That gives the UI access to task activity, repository configuration, agent settings, planner workflows, and operational metrics.

## Current Integration Model

The Web UI is responsible for:

- Showing dashboard status, queue health, task history, and execution details
- Managing monitored repositories, settings, and AI agent configuration
- Driving Planner Studio and other browser-based workflows
- Sending authenticated requests to the API for follow-up actions

The backend is responsible for:

- GitHub App authentication, webhooks, and issue or PR automation
- Queue coordination and worker orchestration
- Running Claude, Codex, and Gemini agents in isolated execution environments
- Persisting operational data in Redis and the shared application database, then exposing it through API endpoints

## Key API Surfaces

The frontend uses the dashboard API rather than a mock layer. Common integration points include:

- `GET /api/status` for daemon, worker, Redis, and auth health
- `GET /api/queue/stats` for queue depth and throughput
- `GET /api/tasks` and related task detail endpoints for execution history
- `GET /api/config/*` routes for repositories, settings, and follow-up configuration
- Auth routes such as `/api/auth/github/*` for GitHub login flows

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
npm install
npm run dev
```

The Vite dev server runs on `http://localhost:5173` by default. Point `VITE_API_BASE_URL` or `VITE_API_URL` at your local dashboard API if it is running on a different origin.

## Production Integration

In production, the UI and API can be deployed separately behind the same domain or different subdomains. In the repository's default Compose deployment, the UI is built from `propr-ui/`, served by the `api` container, and that container shares the same SQLite database volume as `daemon` and `worker` while Redis handles queue and cache state.

Important integration points:

- Set the frontend API base URL so browser requests reach the dashboard API
- Configure GitHub OAuth callback URLs to match the public API origin
- Allow credentials and cookies to flow correctly if the UI and API are on different origins
- Route `/api/*` traffic to the dashboard API if you serve both behind one reverse proxy

If you build your own frontend around ProPR, treat the dashboard API as the system contract and reuse the existing route structure instead of re-implementing worker or daemon logic in the browser.

## Extending The Integration

When adding new UI features:

1. Add or update the API route in `packages/api/`
2. Add a typed client function under `propr-ui/src/api/`
3. Connect the UI component or page to that client
4. Verify auth, repository scoping, and task visibility behavior in the browser

This keeps the browser layer thin and ensures operational behavior continues to live in the backend services that already own task execution.
