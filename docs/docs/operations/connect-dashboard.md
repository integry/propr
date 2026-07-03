---
sidebar_position: 9
title: Connect Dashboard
---

# Connect Dashboard

The ProPR Connect dashboard at [connect.propr.dev](https://connect.propr.dev) is where you manage the hosted side of a relay-connected installation: seats and plan, delivery history, relay tokens, and hosted-UI tunnels. Everything else — repositories, agents, tasks — lives in your self-hosted stack's own Web UI.

Sign in with the GitHub account that installed the [ProPR GitHub App](https://github.com/apps/propr-dev); the installation picker at the top scopes every page to one installation.

## Dashboard

The landing page shows the installation's plan badge (Community or Plus), the **Assigned seats** roster — which developers hold a seat this billing cycle — and webhook activity for the last 24 hours: events by repository, type, and user, average delivery latency, cached events, and failed deliveries that still need replay. An **All seats in use** alert appears when a new developer's trigger would exceed the plan; **Manage Plus seats** opens the Polar-backed checkout and customer portal. Seat mechanics are covered in [ProPR Connect → Seats and limits](./propr-connect.md#seats-and-limits).

## Deliveries

The Deliveries page is the audit trail: every forwarded GitHub delivery with the status your stack acknowledged — `accepted`, `ignored` (with a reason such as `user_not_allowed` or `unsupported_event`), or `blocked` (`limit_reached`). Failed deliveries are cached and replayed when your stack reconnects; ones that keep failing surface here for investigation. When "nothing happened" after a labeled issue, this page tells you whether the event arrived and what your stack decided.

## Relay tokens

Relay tokens (`prt_…`) are the durable credential a self-hosted stack uses to connect. Create one here or with `propr relay enroll`; the plaintext is shown **once**, and only its hash is stored. Revoke a token here (or with `propr relay revoke`) if a stack is retired or the credential may have leaked — revocation cuts that stack's routing and token minting immediately.

## Tunnels

Plus installations can provision a managed hosted-UI tunnel: Connect creates the Cloudflare connector and shows a one-time `propr tunnel setup --token … --url https://t-<id>.propr.dev --start` command to run in the stack directory. The page also health-checks the tunnel and offers rotate/delete. Architecture and configuration live in [Production Deployment → Hosted UI Tunnel](./deployment.md#hosted-ui-tunnel).

## Checking Connect health

When you suspect the hosted side rather than your stack:

- `https://webhook.propr.dev/health` returns `{ "ok": true }` when the relay worker is up.
- `propr status` (and `propr remote-status`) report your stack's routing connection and, when enabled, tunnel reachability.
- `propr tunnel verify` checks the tunnel end to end.
- The Deliveries page shows whether GitHub events are arriving and being acknowledged — a growing failed-deliveries count with a healthy stack points at connectivity between the two.

Failed deliveries replay automatically on reconnect, so a brief outage on either side loses no triggers. For stack-side symptoms, start with [Troubleshooting](./troubleshooting.md).
