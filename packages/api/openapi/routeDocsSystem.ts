import {
  InstanceStorageCapabilities, InstanceRepositoryInventory, InstanceDatabaseExportRequest, InstanceDatabaseExportQuery, InstanceDatabaseExport,
  InstanceStorageUsage, InstanceStoragePolicy, InstanceStoragePolicyRequest, InstanceStoragePreviewRequest, InstanceStorageExecuteRequest, InstanceStoragePreview, InstanceStorageResult, InstanceStorageResultQuery,
  AuthenticatedUser,
  Compatibility,
  DemoModeStatus,
  DesktopDiscovery,
  DesktopPairingActivationReceipt,
  DesktopPairingCancellation,
  DesktopPairingPoll,
  DesktopPairingPollRequest,
  DesktopPairingStart,
  DesktopPairingStartRequest,
  DesktopPairingTicket,
  Health,
  ExtensionProfileSave,
  JsonObject,
} from './schemas.js';
import type { RouteDoc } from './types.js';

const PAIRING_ID = 'Pairing identifier returned when the pairing started.';
const PAIRING_GUIDE = 'See the desktop pairing guide (docs/operations/desktop-pairing) for the protocol.';
const MCP_OAUTH = 'Served by the MCP SDK\'s OAuth router at the API origin root, and only while MCP is enabled. See the MCP guide (docs/features/mcp).';

export const SYSTEM_ROUTE_DOCS: Record<string, RouteDoc> = {
  'GET /api/instance/extensions/v1': {
    operationId: 'listAgentExtensionProfiles', summary: 'List secret-free current extension revisions, the versioned contract and operator catalog identity/digest, tools/capability and opaque secret count/configuration status.', tags: ['Configuration'],
    responses: { 200: { description: 'Current durable instance administrators only; works without Connect.', schema: JsonObject } },
  },
  'POST /api/instance/extensions/v1/profiles': {
    operationId: 'saveAgentExtensionProfile', summary: 'Create an immutable revision with optional write-only secret replacements.', tags: ['Configuration'],
    headers: [{ name: 'X-ProPR-Extensions', description: 'Must be 1. JSON requests only.', required: true }],
    requestBody: { schema: ExtensionProfileSave, description: 'input follows ExtensionProfileInput v1; expected is the exact instance/profile/revision selection for updates. secrets maps server names to replacement tokens or null; values are never returned.' },
    responses: { 200: { description: 'Secret-free revision.', schema: JsonObject } },
  },
  'GET /api/instance/extensions/v1/profiles/:profileId/history': {
    operationId: 'getAgentExtensionProfileHistory', summary: 'Read immutable, secret-free revision history.', tags: ['Configuration'], responses: { 200: { description: 'Revision history.', schema: JsonObject } },
  },
  'POST /api/instance/extensions/v1/delete': {
    operationId: 'deleteAgentExtensionProfile', summary: 'Disable new launches without changing active snapshots.', tags: ['Configuration'], requestBody: { schema: JsonObject, description: 'selection: exact instanceId, profileId and revision.' }, responses: { 200: { description: 'Profile tombstoned.', schema: JsonObject } },
  },
  'POST /api/instance/extensions/v1/validate': {
    operationId: 'validateAgentExtensionMcp', summary: 'Validate connectivity without disclosing any upstream response content.', tags: ['Configuration'], requestBody: { schema: JsonObject, description: 'selection: exact instanceId, profileId and revision.' }, responses: { 200: { description: 'Server names and reachable booleans only.', schema: JsonObject } },
  },
  'POST /api/instance/extensions/v1/skills/archive': {
    operationId: 'importAgentExtensionSkillArchive', summary: 'Import a bounded strict tar or tar.gz skill bundle.', tags: ['Configuration'], requestBody: { schema: JsonObject, description: 'filename and base64 archive, at most 5 MiB compressed and 4 MiB expanded. Requires SKILL.md.' }, responses: { 200: { description: 'Immutable digest and provenance.', schema: JsonObject } },
  },
  'POST /api/instance/extensions/v1/skills/github': {
    operationId: 'importAgentExtensionGitSkill', summary: 'Import an authorized GitHub skill at an exact commit and relative directory.', tags: ['Configuration'], requestBody: { schema: JsonObject, description: 'repository, 40-character commit SHA, directory. Caller repository authorization is required.' }, responses: { 200: { description: 'Immutable digest and exact source commit.', schema: JsonObject } },
  },
  'POST /api/instance/extensions/v1/tools/discover': {
    operationId: 'discoverAgentExtensionTools', summary: 'Probe a public HTTPS MCP endpoint without credentials; return valid tool names only.', tags: ['Configuration'], requestBody: { schema: JsonObject, description: 'url only. Requires the extension preflight JSON header.' }, responses: { 200: { description: 'Tool names only.', schema: JsonObject } },
  },
  'POST /api/instance/extensions/v1/skills/github-source': {
    operationId: 'resolveAgentExtensionGitSource', summary: 'List branches and tags or resolve a selected ref to an immutable commit.', tags: ['Configuration'], requestBody: { schema: JsonObject, description: 'Authorized repository and optional ref. Lists at most 100 branches and 100 tags.' }, responses: { 200: { description: 'Ref choices or exact commit for confirmation.', schema: JsonObject } },
  },
  'POST /api/extensions/mcp/:serverName': {
    operationId: 'callAgentExtensionMcp', summary: 'Run-scoped bounded MCP gateway; no browser or OAuth authority.', tags: ['MCP'], requestBody: { schema: JsonObject, description: 'JSON-RPC initialize, ping, initialized notification, tools/list or explicitly authorized tools/call.' }, responses: { 200: { description: 'Sanitized MCP response.', schema: JsonObject }, 202: { description: 'Notification accepted.' } },
  },
  'GET /api/instance/storage/v1/capabilities': {
    operationId: 'getInstanceStorageCapabilities', summary: 'Negotiate native instance storage capabilities and process generation.', tags: ['System'],
    responses: { 200: { description: 'Instance administrator capabilities; no Connect subscription required.', schema: InstanceStorageCapabilities } },
  },
  'GET /api/instance/storage/v1/repositories': {
    operationId: 'getInstanceRepositoryInventory', summary: 'Read a bounded partial repository storage inventory with protection reasons.', tags: ['System'],
    responses: { 200: { description: 'Safe identifiers and sizes; no host paths or contents.', schema: InstanceRepositoryInventory } },
  },
  'POST /api/instance/storage/v1/exports': {
    operationId: 'startInstanceDatabaseExport', summary: 'Start a private asynchronous customer database snapshot.', tags: ['System'],
    requestBody: { schema: InstanceDatabaseExportRequest },
    headers: [{ name: 'X-ProPR-Storage', description: 'Must equal 1.', required: true }],
    responses: { 202: { description: 'Actor-bound expiring export job.', schema: InstanceDatabaseExport } },
  },
  'GET /api/instance/storage/v1/exports/:operationId': {
    operationId: 'getInstanceDatabaseExport', summary: 'Read the initiating administrator’s export status.', tags: ['System'],
    query: InstanceDatabaseExportQuery,
    responses: { 200: { description: 'Export state, digest, size and schema version.', schema: InstanceDatabaseExport } },
  },
  'POST /api/instance/storage/v1/exports/:operationId/download': {
    operationId: 'downloadInstanceDatabaseExport', summary: 'Redeem an export once using current instance-admin authority.', tags: ['System'],
    requestBody: { schema: InstanceDatabaseExportRequest },
    headers: [{ name: 'X-ProPR-Storage', description: 'Must equal 1.', required: true }],
    responses: { 200: { description: 'Integrity-checked SQLite snapshot; attachment, no-store.', contentType: 'application/vnd.sqlite3' } },
  },
  'POST /api/instance/storage/v1/exports/:operationId/cancel': {
    operationId: 'cancelInstanceDatabaseExport', summary: 'Abort and discard an administrator’s private export.', tags: ['System'],
    requestBody: { schema: InstanceDatabaseExportRequest },
    headers: [{ name: 'X-ProPR-Storage', description: 'Must equal 1.', required: true }],
    responses: { 200: { description: 'Export discarded.', schema: JsonObject } },
  },
  'GET /api/instance/storage/v1/usage': {
    operationId: 'getInstanceStorageUsage',
    summary: 'Get bounded asynchronous per-instance storage observations.',
    description: 'Version 1 contract: docs/architecture/instance-storage-v1. Instance administrator required. Mutations require application/json and X-ProPR-Storage: 1. Offline/unknown usage is never zero.',
    tags: ['System'],
    responses: { 200: { description: 'Versioned instance storage response.', schema: InstanceStorageUsage } },
  },
  'GET /api/instance/storage/v1/policy': {
    operationId: 'getInstanceStoragePolicy',
    summary: 'Get opt-in repository cleanup policy (disabled, 24 idle hours by default).',
    description: 'Version 1 contract: docs/architecture/instance-storage-v1. Instance administrator required. Mutations require application/json and X-ProPR-Storage: 1. Offline/unknown usage is never zero.',
    tags: ['System'],
    responses: { 200: { description: 'Versioned instance storage response.', schema: InstanceStoragePolicy } },
  },
  'PUT /api/instance/storage/v1/policy': {
    operationId: 'updateInstanceStoragePolicy',
    summary: 'Persist the explicitly selected instance cleanup policy.',
    description: 'Version 1 contract: docs/architecture/instance-storage-v1. Instance administrator required. Mutations require application/json and X-ProPR-Storage: 1. Offline/unknown usage is never zero.',
    tags: ['System'],
    requestBody: { schema: InstanceStoragePolicyRequest },
    headers: [{ name: 'X-ProPR-Storage', description: 'Must equal 1; browser calls require an authorized CORS preflight.', required: true }],
    responses: { 200: { description: 'Versioned instance storage response.', schema: InstanceStoragePolicy } },
  },
  'POST /api/instance/storage/v1/cleanup/preview': {
    operationId: 'previewInstanceStorageCleanup',
    summary: 'Preview an explicit instance/category selection; worktrees includes only proven generated payloads; terminal task history requires explicit taskIds.',
    description: 'Version 1 contract: docs/architecture/instance-storage-v1. Instance administrator required. Mutations require application/json and X-ProPR-Storage: 1. Offline/unknown usage is never zero.',
    tags: ['System'],
    requestBody: { schema: InstanceStoragePreviewRequest },
    headers: [{ name: 'X-ProPR-Storage', description: 'Must equal 1; browser calls require an authorized CORS preflight.', required: true }],
    responses: { 200: { description: 'Versioned instance storage response.', schema: InstanceStoragePreview } },
  },
  'POST /api/instance/storage/v1/cleanup/execute': {
    operationId: 'executeInstanceStorageCleanup',
    summary: 'Consume a principal-bound confirmation and revalidate before deleting any candidate.',
    description: 'Version 1 contract: docs/architecture/instance-storage-v1. Instance administrator required. Mutations require application/json and X-ProPR-Storage: 1. Offline/unknown usage is never zero.',
    tags: ['System'],
    requestBody: { schema: InstanceStorageExecuteRequest },
    headers: [{ name: 'X-ProPR-Storage', description: 'Must equal 1; browser calls require an authorized CORS preflight.', required: true }],
    responses: { 200: { description: 'Versioned instance storage response.', schema: InstanceStorageResult } },
  },
  'GET /api/instance/storage/v1/cleanup/operations/:operationId': {
    operationId: 'getInstanceStorageCleanupResult',
    summary: 'Read the initiating principal’s durable cleanup result.',
    description: 'Version 1 contract: docs/architecture/instance-storage-v1. Instance administrator required. Mutations require application/json and X-ProPR-Storage: 1. Offline/unknown usage is never zero.',
    tags: ['System'],
    query: InstanceStorageResultQuery,
    responses: { 200: { description: 'Versioned instance storage response.', schema: InstanceStorageResult } },
  },
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
    requestBody: { schema: DesktopPairingStartRequest },
    responses: {
      201: { description: 'Pairing started; the user opens `approvalUrl` to approve it.', schema: DesktopPairingStart },
      400: { description: '`INVALID_CLIENT_NAME` or `INVALID_PAIRING_BINDING`.' },
    },
  },
  'POST /api/desktop/pairings/:pairingId/poll': {
    operationId: 'pollDesktopPairing',
    summary: 'Poll a pairing for approval',
    description: PAIRING_GUIDE,
    tags: ['Desktop'],
    pathParams: { pairingId: PAIRING_ID },
    requestBody: { schema: DesktopPairingPollRequest },
    responses: {
      200: { description: 'Approved: a provisional token and the activation ticket.', schema: DesktopPairingPoll },
      202: { description: 'Not approved yet; poll again after `interval` seconds.', schema: DesktopPairingPoll },
      404: { description: 'Unknown pairing or wrong device secret (`PAIRING_NOT_FOUND`).' },
    },
  },
  'POST /api/desktop/pairings/:pairingId/activate': {
    operationId: 'activateDesktopPairing',
    summary: 'Activate an approved pairing',
    description: PAIRING_GUIDE,
    tags: ['Desktop'],
    pathParams: { pairingId: PAIRING_ID },
    requestBody: { schema: DesktopPairingTicket },
    responses: {
      200: { description: 'Activation receipt.', schema: DesktopPairingActivationReceipt },
      404: { description: 'Unknown pairing, or the secret, ticket or binding does not match (`PAIRING_NOT_FOUND`).' },
    },
  },
  'POST /api/desktop/pairings/:pairingId/cancel': {
    operationId: 'cancelDesktopPairing',
    summary: 'Cancel a pending pairing',
    description: PAIRING_GUIDE,
    tags: ['Desktop'],
    pathParams: { pairingId: PAIRING_ID },
    requestBody: { schema: DesktopPairingTicket },
    responses: {
      200: { description: 'Cancellation receipt; repeating the request returns the first one.', schema: DesktopPairingCancellation },
      404: { description: 'Unknown pairing, or the secret, ticket or binding does not match (`PAIRING_NOT_FOUND`).' },
    },
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
  'GET /.well-known/oauth-protected-resource/api/mcp': {
    operationId: 'getOAuthProtectedResourceMetadata',
    summary: 'OAuth protected resource metadata of the MCP endpoint',
    description: `RFC 9728 metadata naming this instance as the authorization server of \`/api/mcp\`. ${MCP_OAUTH}`,
    tags: ['MCP'],
    responses: {
      200: { description: 'RFC 9728 metadata.', schema: JsonObject },
      404: { description: 'MCP is disabled on this instance.' },
    },
  },
  'GET /authorize': {
    operationId: 'authorizeMcpClient',
    summary: 'Start an MCP OAuth authorization',
    description: `OAuth 2.1 authorization endpoint with PKCE (\`S256\`). Takes \`response_type=code\`, \`client_id\`, \`redirect_uri\` (must match a registered URI exactly), \`code_challenge\`, \`code_challenge_method\`, and optionally \`scope\`, \`state\` and \`resource\` as query parameters, then redirects the browser to the consent page. ${MCP_OAUTH}`,
    tags: ['MCP'],
    responses: {
      302: { description: 'Redirect to the consent page, or to `redirect_uri` with an OAuth error.' },
      400: { description: 'Unknown client or a `redirect_uri` that is not registered.' },
      404: { description: 'MCP is disabled on this instance.' },
    },
  },
  'POST /authorize': {
    operationId: 'authorizeMcpClientForm',
    summary: 'Start an MCP OAuth authorization (form post)',
    description: `Same as \`GET /authorize\`, with the parameters in an \`application/x-www-form-urlencoded\` body. ${MCP_OAUTH}`,
    tags: ['MCP'],
    responses: {
      302: { description: 'Redirect to the consent page, or to `redirect_uri` with an OAuth error.' },
      400: { description: 'Unknown client or a `redirect_uri` that is not registered.' },
      404: { description: 'MCP is disabled on this instance.' },
    },
  },
  'POST /token': {
    operationId: 'issueMcpToken',
    summary: 'Exchange an authorization code or refresh token',
    description: `OAuth 2.1 token endpoint for public clients (\`token_endpoint_auth_method: none\`). The \`application/x-www-form-urlencoded\` body carries \`grant_type\` (\`authorization_code\` with \`code\`, \`code_verifier\` and \`redirect_uri\`, or \`refresh_token\` with \`refresh_token\`), \`client_id\` and optionally \`resource\`. ${MCP_OAUTH}`,
    tags: ['MCP'],
    responses: {
      200: { description: 'RFC 6749 token response: `access_token`, `token_type`, `expires_in`, `scope` and `refresh_token`.', schema: JsonObject },
      400: { description: 'RFC 6749 error, for example `invalid_grant`.' },
      404: { description: 'MCP is disabled on this instance.' },
    },
  },
  'POST /register': {
    operationId: 'registerMcpClient',
    summary: 'Register an MCP OAuth client',
    description: `RFC 7591 dynamic client registration. Clients register as public clients (\`token_endpoint_auth_method: none\`). ${MCP_OAUTH}`,
    tags: ['MCP'],
    requestBody: { schema: JsonObject, description: 'RFC 7591 client metadata, for example `client_name` and `redirect_uris`.' },
    responses: {
      201: { description: 'The registered client, including its `client_id`.', schema: JsonObject },
      400: { description: 'RFC 7591 error, for example `invalid_client_metadata`.' },
      404: { description: 'MCP is disabled on this instance.' },
    },
  },
  'POST /revoke': {
    operationId: 'revokeMcpToken',
    summary: 'Revoke an MCP access or refresh token',
    description: `RFC 7009 revocation. The \`application/x-www-form-urlencoded\` body carries \`token\`, optionally \`token_type_hint\`, and \`client_id\`. ${MCP_OAUTH}`,
    tags: ['MCP'],
    responses: {
      200: { description: 'The token is revoked, or was not valid. The body is `{}`.', schema: JsonObject },
      400: { description: 'RFC 7009 error.' },
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
