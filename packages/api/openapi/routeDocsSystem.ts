import {
  AuthenticatedUser,
  Compatibility,
  DemoModeStatus,
  DesktopDiscovery,
  Health,
  JsonObject,
} from './schemas.js';
import type { RouteDoc } from './types.js';

const PAIRING_ID = 'Pairing identifier returned when the pairing started.';
const PAIRING_GUIDE = 'See the desktop pairing guide (docs/operations/desktop-pairing) for the protocol.';

export const SYSTEM_ROUTE_DOCS: Record<string, RouteDoc> = {
  'GET /health': {
    operationId: 'getHealth',
    summary: 'Liveness probe',
    tags: ['System'],
    responses: { 200: { description: 'The API process is serving requests.', schema: Health } },
  },
  'GET /api/compatibility': {
    operationId: 'getCompatibility',
    summary: 'Get version and compatibility metadata',
    description: 'Unauthenticated. Clients compare `apiCompatibility` with the date they were built against before calling other routes.',
    tags: ['System'],
    responses: { 200: { description: 'Version and capability metadata.', schema: Compatibility } },
  },
  'GET /api/status': {
    operationId: 'getSystemStatus',
    summary: 'Get the system health snapshot',
    description: 'Redis, queue, worker and agent health, the same snapshot the dashboard header shows.',
    tags: ['System'],
    responses: { 200: { description: 'The health snapshot.', schema: JsonObject } },
  },

  'GET /api/auth/user': {
    operationId: 'getAuthenticatedUser',
    summary: 'Get the signed-in user',
    tags: ['Authentication'],
    responses: { 200: { description: 'The caller and their instance role.', schema: AuthenticatedUser } },
  },
  'GET /api/auth/demo-mode': {
    operationId: 'getDemoMode',
    summary: 'Report whether the instance runs in read-only demo mode',
    tags: ['Authentication'],
    responses: { 200: { description: 'Demo mode flag.', schema: DemoModeStatus } },
  },
  'GET /api/auth/github': {
    operationId: 'startGitHubLogin',
    summary: 'Start the GitHub OAuth login (browser)',
    tags: ['Authentication'],
    responses: { 302: { description: 'Redirect to GitHub.' } },
  },
  'GET /api/auth/github/callback': {
    operationId: 'completeGitHubLogin',
    summary: 'GitHub OAuth callback (browser)',
    tags: ['Authentication'],
    responses: { 302: { description: 'Redirect to the web UI with a session cookie set.' } },
  },
  'GET /api/auth/logout': {
    operationId: 'logout',
    summary: 'End the browser session',
    tags: ['Authentication'],
    responses: { 302: { description: 'Redirect to the login page.' } },
  },

  'GET /api/desktop/discovery': {
    operationId: 'getDesktopDiscovery',
    summary: 'Get public desktop discovery metadata',
    description: `Unauthenticated and credential-free. ${PAIRING_GUIDE}`,
    tags: ['Desktop'],
    responses: {
      200: { description: 'Discovery metadata.', schema: DesktopDiscovery },
      503: { description: 'The public instance identity is unavailable.' },
    },
  },
  'POST /api/desktop/pairings': {
    operationId: 'startDesktopPairing',
    summary: 'Start a desktop or CLI pairing',
    description: PAIRING_GUIDE,
    tags: ['Desktop'],
    requestBody: { schema: JsonObject, description: '`clientName` and the client binding.' },
    responses: { 201: { description: 'Pairing started; open `browserUrl` to approve it.', schema: JsonObject } },
  },
  'POST /api/desktop/pairings/:pairingId/poll': {
    operationId: 'pollDesktopPairing',
    summary: 'Poll a pairing for approval',
    description: PAIRING_GUIDE,
    tags: ['Desktop'],
    pathParams: { pairingId: PAIRING_ID },
    requestBody: { schema: JsonObject },
    responses: { 200: { description: 'Pairing state; carries the activation ticket once approved.', schema: JsonObject } },
  },
  'POST /api/desktop/pairings/:pairingId/activate': {
    operationId: 'activateDesktopPairing',
    summary: 'Activate an approved pairing',
    description: PAIRING_GUIDE,
    tags: ['Desktop'],
    pathParams: { pairingId: PAIRING_ID },
    requestBody: { schema: JsonObject },
    responses: { 200: { description: 'Activation receipt.', schema: JsonObject } },
  },
  'POST /api/desktop/pairings/:pairingId/cancel': {
    operationId: 'cancelDesktopPairing',
    summary: 'Cancel a pending pairing',
    description: PAIRING_GUIDE,
    tags: ['Desktop'],
    pathParams: { pairingId: PAIRING_ID },
    requestBody: { schema: JsonObject },
    responses: { 200: { description: 'Cancellation receipt.', schema: JsonObject } },
  },
  'GET /api/desktop/tokens': {
    operationId: 'listInstanceTokens',
    summary: 'List your desktop and CLI instance tokens',
    tags: ['Desktop'],
    responses: { 200: { description: '`{ tokens: [...] }`: your instance tokens, never the secret values.', schema: JsonObject } },
  },
  'DELETE /api/desktop/tokens/:tokenId': {
    operationId: 'revokeInstanceToken',
    summary: 'Revoke one of your instance tokens',
    tags: ['Desktop'],
    pathParams: { tokenId: 'Token identifier from `listInstanceTokens`.' },
    responses: { 204: { description: 'Revoked.' } },
  },
  'DELETE /api/desktop/tokens/current': {
    operationId: 'revokeCurrentInstanceToken',
    summary: 'Revoke the instance token used for this request',
    tags: ['Desktop'],
    responses: {
      204: { description: 'Revoked.' },
      404: { description: 'The token does not exist.' },
    },
  },

  'POST /api/mcp': {
    operationId: 'mcpRequest',
    summary: 'MCP Streamable HTTP endpoint',
    description: 'JSON-RPC requests of the Model Context Protocol. Each tool checks the token\'s scopes. Returns `404` while MCP is disabled. See the MCP guide (docs/features/mcp) for the tool catalogue.',
    tags: ['MCP'],
    requestBody: { schema: JsonObject, description: 'A JSON-RPC 2.0 request or notification.' },
    responses: {
      200: { description: 'JSON-RPC response.', schema: JsonObject },
      202: { description: 'Notification accepted.' },
      404: { description: 'MCP is disabled on this instance.' },
    },
  },
  'GET /.well-known/oauth-authorization-server': {
    operationId: 'getOAuthAuthorizationServerMetadata',
    summary: 'OAuth authorization server metadata for MCP clients',
    tags: ['MCP'],
    responses: {
      200: { description: 'RFC 8414 metadata.', schema: JsonObject },
      404: { description: 'MCP is disabled on this instance.' },
    },
  },

  'POST /webhook': {
    operationId: 'receiveGitHubWebhook',
    summary: 'Receive a GitHub webhook delivery',
    description: 'Registered only when `GITHUB_EVENT_INTAKE_MODE=direct_webhook`. Deliveries must be signed with `GH_WEBHOOK_SECRET`.',
    tags: ['Webhooks'],
    headers: [
      { name: 'X-GitHub-Event', required: true, description: 'GitHub event name.' },
      { name: 'X-GitHub-Delivery', required: true, description: 'GitHub delivery identifier.' },
    ],
    requestBody: { schema: JsonObject, description: 'The GitHub event payload.' },
    responses: {
      200: { description: 'Accepted.', contentType: 'text/plain' },
      401: { description: 'Missing or invalid signature.' },
    },
  },
};
