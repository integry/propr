# ProPR API

The ProPR API provides the backend server for the web-based management interface for monitoring and controlling your ProPR instance.

## Components

- **api**: Express.js backend API with GitHub OAuth authentication
- **client**: React frontend built with Vite and Tailwind CSS

## Setup

### Prerequisites

1. Create a GitHub OAuth App:
   - Go to GitHub Settings > Developer settings > OAuth Apps
   - Click "New OAuth App"
   - Set Authorization callback URL to: `http://localhost:4000/api/auth/github/callback`
   - Save the Client ID and Client Secret

2. Configure environment variables in your `.env` file:
   ```
   # GitHub OAuth Configuration
   GH_OAUTH_CLIENT_ID=your_github_oauth_client_id
   GH_OAUTH_CLIENT_SECRET=your_github_oauth_client_secret
   GH_OAUTH_CALLBACK_URL=http://localhost:4000/api/auth/github/callback
   SESSION_SECRET=your-session-secret-here
   
   # Dashboard Configuration
   DASHBOARD_API_PORT=4000
   FRONTEND_URL=http://localhost:5173
   ```

### Running with Docker Compose

The dashboard is integrated into the main docker-compose setup:

```bash
docker-compose up api
```

### Development

To run the API in development mode:

1. Backend API:
   ```bash
   cd packages/api
   npm install
   npm run dev
   ```

## Features

- **GitHub OAuth Authentication**: Secure login with GitHub
- **System Status Monitoring**: View health status of all ProPR components
- **Queue Statistics**: Monitor task queue metrics
- **Activity Log**: Track recent system activities
- **Performance Metrics**: View processing times and throughput

## API Endpoints

All API endpoints are protected by authentication:

- `GET /api/auth/github` - Initiate GitHub OAuth flow
- `GET /api/auth/github/callback` - OAuth callback
- `GET /api/auth/logout` - Logout user
- `GET /api/auth/user` - Get current user info
- `GET /api/status` - System health status
- `GET /api/queue/stats` - Queue statistics
- `GET /api/activity` - Activity log
- `GET /api/metrics` - Performance metrics
- `GET /api/task/:taskId/history` - Task history

### Notification preferences and Web Push

Notification routes always derive the user from the authenticated session. A
new user receives all six categories (`plan`, `task`, `review`,
`pull_request`, `indexing`, and `system_failure`) with Inbox enabled and Push
disabled. Quiet hours default to `{ "start": null, "end": null, "timezone":
"UTC" }`. Push is not enabled by registering a browser; the user must also set
`pushEnabled` for each desired category. A synthesized category default has
`updatedAt: null`; persisted choices carry their actual update timestamp.
When a trusted producer assigns recipients, its channel eligibility is
intersected with the stored category preference. In particular, an explicit
producer `pushEnabled: true` cannot bypass a user opt-out, while an opt-in only
enables Push for events whose producer also selected that channel. Object-form
recipient assignments must always provide `pushEnabled`; the string shorthand
is explicitly Inbox-only. The repository currently has no production event
producers, so there are no omitted call sites to migrate.

This API currently stores notification delivery policy and browser enrollment;
it does not include a Web Push dispatcher. Quiet hours therefore do not yet
suppress outbound requests. A future dispatcher must apply both boundaries in
the stored IANA timezone at claim time (including retries and DST transitions),
treat either null boundary as disabled, treat equal non-null boundaries as a
zero-length window, and retain jobs until the quiet window ends. Preference
opt-outs atomically cancel pending, retryable, and expired-lease jobs; current
preferences are also checked when jobs are created or claimed. Revocation erases
stored keys and cancels the same queued work, but both opt-out and subscription
refresh/revocation remain best-effort for a live lease that may already hold old
state. A future dispatcher must re-read the current category preference,
subscription, and job immediately before network I/O, use the latest refreshed
keys, and skip an opted-out user, revoked subscription, expired subscription, or
cancelled job. It must also reject loopback destinations independently unless it
is intentionally running in the same isolated local-development mode.

- `GET /api/notifications/config` - Canonical capability route; return Web Push availability and the VAPID public key. The private key is never serialized. `/api/notifications/capabilities` is a compatibility alias.
- `GET /api/notifications/preferences` - Return the complete category and quiet-hour snapshot.
- `PATCH /api/notifications/preferences` - Apply a sparse update; omitted categories and channel values remain unchanged.
- `GET /api/notifications/push-subscriptions` - List the authenticated user's active browser subscriptions without encryption keys.
- `POST /api/notifications/push-subscriptions` - Create or refresh the authenticated user's browser subscription by endpoint.
- `DELETE /api/notifications/push-subscriptions` - Revoke the authenticated user's subscription. Supply `endpoint` only in the JSON body; capability URLs are never accepted in query strings.
- `DELETE /api/notifications/push-subscriptions/:subscriptionId` - Revoke an owned subscription by the opaque ID returned from the list route.

Enrollment is limited to 10 active and 50 retained subscription rows per user,
with at most 20 new enrollments/reactivations per hour. Refreshing an already
active endpoint does not consume the enrollment rate limit, and an unchanged
refresh takes a read-only path. Expired rows are atomically revoked before
enrollment, which releases active quota and endpoint ownership, erases keys, and
cancels queued jobs. The API runs bounded expiration and garbage-collection
batches at startup and hourly. Revoked rows older than 30 days are deleted only
when no delivery job references them; quota pressure may safely collect newer
unreferenced revocations. Referenced delivery history remains immutable and
counts toward the retained quota. Rate-limit responses use HTTP 429 with
`Retry-After`; quota responses use HTTP 409 so clients can prompt the user to
revoke another browser.

Subscription endpoints are intentionally limited to FCM, Mozilla Autopush, and
Apple Web Push vendor hosts. Adding another browser provider requires updating
the shared allowlist and shipping a schema migration that updates the persisted
SQLite `CHECK`; delivery clients must revalidate stored endpoints and disable
redirects. Insecure `localhost`/`127.0.0.1` enrollment is off by default and is
available only for isolated local development through
`PROPR_ALLOW_INSECURE_LOCAL_WEB_PUSH=true`. The API additionally requires a
non-production `NODE_ENV` and a loopback `API_PUBLIC_URL` (or its unset localhost
default), so the flag is ineffective on remote preview/staging URLs. The SQLite
constraint is deliberately stable across restarts and permits loopback rows;
the authenticated service deployment checks are the enrollment policy boundary.
Missing, malformed, and mismatched VAPID configuration is reported with a
sanitized startup warning that never includes either key.

Quiet-hour timezone aliases are canonicalized using the server's ICU database
before storage. Shared response parsing validates the returned identifier's
shape without consulting the browser's potentially older timezone database.

The preference API migration remains startup-blocking and transactional because
it rebuilds the subscription table while preserving delivery foreign keys. Its
work is linear in historical subscription count: runtime URL/key validation is
performed in batches of 500 and collision reconciliation uses set-based SQLite
updates. Operators with unusually large subscription history should run the
migration during a maintenance window and budget time for one P-256 validation
per active legacy row.

For example, this enables Push for task notifications and configures local
quiet hours without changing any other category:

```json
{
  "preferences": {
    "task": { "pushEnabled": true }
  },
  "quietHours": {
    "start": "22:00",
    "end": "07:30",
    "timezone": "America/New_York"
  }
}
```

## Security

- Session-based authentication with secure cookies
- All API endpoints require authentication
- CORS configured for frontend origin
- Environment-based session secrets
