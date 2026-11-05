# @propr/client

The TypeScript REST and Socket.IO client for a ProPR instance. The ProPR CLI and the desktop app use it, and you can use it in monitoring jobs, custom dashboards and CI scripts.

- Typed methods for common operations, plus an authenticated `request()` for any route of the [API reference](https://docs.propr.dev/docs/operations/api-reference).
- Request and response types (`ProprApi.*`) generated from the same schemas as the published OpenAPI 3.1 spec, [`propr-api.yaml`](../../docs/static/openapi/propr-api.yaml).
- Session-cookie, GitHub-token and instance-token authentication, timeouts and cancellation, and a single `ProprClientError` type.
- A Socket.IO connection with ProPR's reconnect policy and bearer handshake.

Runs on Node.js 22.12 or newer and in browsers. ESM only.

## Install

The package is not on the npm registry yet. Build it, together with its `@propr/shared` dependency, from a ProPR checkout and install the two tarballs:

```bash
git clone https://github.com/integry/propr.git && cd propr
npm ci
npm run build -w @propr/shared && npm run build -w @propr/client
mkdir -p /tmp/propr-client
npm pack -w @propr/shared -w @propr/client --pack-destination /tmp/propr-client

cd /path/to/your-project
npm install /tmp/propr-client/propr-shared-*.tgz /tmp/propr-client/propr-client-*.tgz
```

Use a client built from the same release as your instance. `client.requireCompatibility()` checks this at runtime.

## Authentication

Outside the browser, authenticate with a bearer token:

```ts
import { ProprClient } from '@propr/client';

const client = new ProprClient({
  baseUrl: 'https://propr.example.com', // your API origin (API_PUBLIC_URL)
  authentication: {
    type: 'bearer',
    // Called before every request and socket handshake, so tokens can rotate.
    getAccessToken: () => process.env.PROPR_TOKEN,
  },
  defaultTimeoutMs: 15_000,
});

await client.requireCompatibility(); // throws if the instance speaks an incompatible API
```

The token can be either of these:

- **A GitHub token** whose account is allowed on the instance, for example `gh auth token` or a fine-grained token. The API accepts GitHub tokens while `ENABLE_BEARER_AUTH` is not `false`; it is enabled by default. It checks each token against GitHub and caches the result for five minutes. Set `ENABLE_BEARER_AUTH=false` on the instance to allow browser sessions only.
- **An instance token** (`propr_it_…`) issued by [desktop pairing](https://docs.propr.dev/docs/operations/desktop-pairing). Instance tokens keep working when `ENABLE_BEARER_AUTH=false`.

In a browser on the instance's own origin, use `{ type: 'session' }`, which is the default. It sends the session cookie. `{ type: 'none' }` sends no credentials and suits unauthenticated routes such as `/api/compatibility`.

Routes that change instance settings also need an instance permission, for example `instance.manage_settings`. The API reference lists it on each operation as `x-propr-permission`.

## Examples

### List tasks

```ts
const page = await client.listTasks({ status: 'attention', repository: 'acme/app', limit: 20 });
for (const task of page.tasks) {
  console.log(task.id, task.status, task.title, task.prNumber ?? '-');
}
console.log(`${page.tasks.length} of ${page.total}`);
```

`status` accepts `all`, `active`, `waiting`, `attention` or a worker state. Page through results with `limit` (up to 1000) and `offset`.

### Get a task with its events

```ts
const { taskInfo, history } = await client.getTaskHistory(page.tasks[0].id);
console.log(taskInfo?.repository, taskInfo?.issueNumber);
for (const event of history) {
  console.log(event.timestamp, event.state, event.reason ?? '');
}
```

### Create a task submission with an idempotency key

A submission opens a GitHub issue with the instruction and starts an implementation run for it. The idempotency key makes retries safe. Sending the same key and content again returns the existing submission, and resumes it if it stopped part way, instead of opening a second issue. A key is 1 to 255 characters on one line; `.` and `..` are refused before any request because they cannot address the submission in a URL path.

```ts
import { randomUUID } from 'node:crypto';
import { isProprClientError, type ProprApi } from '@propr/client';

const request: ProprApi.TaskSubmissionRequest = {
  repository: 'acme/app',
  instruction: 'Fix the redirect loop after logging out on Safari.',
  maxCostUsd: 5,
};
const idempotencyKey = randomUUID(); // store it with your job so a retry reuses it

try {
  let submission = await client.createTaskSubmission(request, { idempotencyKey });
  if (submission.state === 'failed') submission = await client.retryTaskSubmission(idempotencyKey);
  console.log(submission.state, submission.issueUrl, submission.taskId);
} catch (error) {
  if (isProprClientError(error) && error.status === 409) {
    console.error('This key was already used with different content.');
  } else throw error;
}
```

The state is `queued` once the run is enqueued. While the API is still creating the issue, the request answers `202` with an earlier state. Poll with `client.getTaskSubmission(idempotencyKey)`.

### Any other route

`request()` applies the same authentication, timeout and error handling to every route in the API reference:

```ts
const summary = await client.request<Record<string, unknown>>('/api/dashboard/summary?repository=all');
const csv = await client.request<string>('/api/stats/review-scores.csv', {}, { responseType: 'text' });
```

## Errors

Every failure is a `ProprClientError`. `kind` is one of `configuration`, `authentication`, `network`, `timeout`, `aborted`, `http`, `invalid_response` or `compatibility`. For `http` errors, `status` holds the HTTP status, `body` the parsed response body and `code` its `code` field, when there is one.

New API routes return the error envelope `{ code, message, hint? }`. Older routes return `{ error, code?, message? }` and are marked `x-legacy-error` in the spec.

## Real-time events (Socket.IO)

```ts
import { TASK_UPDATE, type TaskUpdatePayload } from '@propr/shared';

const socket = client.connectSocket(); // reconnects automatically; bearer tokens are sent in the handshake
socket.on('connect', () => socket.emit('subscribe:task', taskId));
socket.on(TASK_UPDATE, (update: TaskUpdatePayload) => console.log(update.state));
socket.on('subscription:error', ({ event, code }) => console.error(event, code));
```

Subscribe again after every `connect`, because subscriptions do not survive a reconnect. The server checks that you can see the resource before it joins you to the room.

| Send (`emit`) | Argument | Then receive |
| --- | --- | --- |
| `subscribe:task` / `unsubscribe:task` | task id | `task:update`: state changes of that task |
| `subscribe:task:live` / `unsubscribe:task:live` | task id | `task:live:update`: live agent output |
| `subscribe:draft` / `unsubscribe:draft` | plan draft id | `draft:update`: plan generation progress |
| `subscribe:indexing` / `unsubscribe:indexing` | `owner/repo` | `indexing:update` for that repository |
| `subscribe:indexing:updates` / `unsubscribe:indexing:updates` | none | `indexing:update` for every repository |
| `subscribe:queue:stats` / `unsubscribe:queue:stats` | none | `queue:stats:update`: queue counts |
| `subscribe:activity` / `unsubscribe:activity` | none | `activity:ready`, then `activity:update`, `goal:update`, `usage:update`, `notification:update` (yours only) and `shell:snapshot` |

The server can also emit these events at any time:

- `subscription:error` with `{ event, code }`, when a subscription is refused. `code` is, for example, `INVALID_RESOURCE`, `FORBIDDEN` or `SUBSCRIPTION_LIMIT`.
- `authentication:error` with `{ code }`, when the session or token stops being valid on a live connection. The server then disconnects the socket.

The event names and payload types are exported by `@propr/shared` (`TASK_UPDATE`, `TaskUpdatePayload`, `ACTIVITY_UPDATE`, …).

## Keeping the client in sync with the API

- `PROPR_API_OPERATIONS` in `src/operations.ts` lists every API operation the client calls. Client code builds all API paths from it with `operationPath()`.
- `src/generated/apiTypes.ts` is written by `npm run gen:openapi` from `packages/api/openapi/schemas.ts`.
- `npm run check:client-contract` fails when an operation's method, path, operation id or types differ from the spec, or when client code hard-codes an `/api/` path. `npm run gen:openapi:check` fails when the generated files are stale. Pull request checks run both.

To add a typed method, document the route in `packages/api/openapi`, run `npm run gen:openapi`, add the operation to `PROPR_API_OPERATIONS`, then add the method using the generated `ProprApi.*` types.
