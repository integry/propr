import { JsonObject } from './schemas.js';
import { ExtensionOAuthCheckRequest, ExtensionOAuthCheckResponse, ExtensionOAuthItemRequest, ExtensionOAuthStartResponse } from './schemasExtensionOAuth.js';
import type { RouteDoc } from './types.js';

/** OAuth sign-in routes of the extension library (docs/features/agent-extensions#oauth-servers). */
export const EXTENSION_OAUTH_ROUTE_DOCS: Record<string, RouteDoc> = {
  'POST /api/instance/extensions/v1/oauth/check': {
    operationId: 'checkAgentExtensionOAuth', summary: 'Run OAuth discovery for an MCP server URL (401 challenge or well-known protected resource metadata, then authorization server metadata) and report which registration method a sign-in would use. Stores nothing and sends no credential.', tags: ['Configuration'],
    headers: [{ name: 'X-ProPR-Extensions', description: 'Must be 1. JSON requests only.', required: true }],
    requestBody: { schema: ExtensionOAuthCheckRequest }, responses: { 200: { description: 'Discovery result.', schema: ExtensionOAuthCheckResponse } },
  },
  'POST /api/instance/extensions/v1/oauth/start': {
    operationId: 'startAgentExtensionOAuth', summary: 'Start the OAuth sign-in of an `oauth` library server for this administrator session. Requires a public HTTPS base URL.', tags: ['Configuration'],
    headers: [{ name: 'X-ProPR-Extensions', description: 'Must be 1. JSON requests only.', required: true }],
    requestBody: { schema: ExtensionOAuthItemRequest }, responses: { 200: { description: 'Authorization URL to open in a new tab.', schema: ExtensionOAuthStartResponse } },
  },
  'POST /api/instance/extensions/v1/oauth/disconnect': {
    operationId: 'disconnectAgentExtensionOAuth', summary: 'Revoke the connection at the provider when it advertises revocation, then delete the stored tokens. Recorded in the OAuth audit trail; creates no library revision.', tags: ['Configuration'],
    headers: [{ name: 'X-ProPR-Extensions', description: 'Must be 1. JSON requests only.', required: true }],
    requestBody: { schema: ExtensionOAuthItemRequest }, responses: { 200: { description: 'Whether the provider confirmed revocation.', schema: JsonObject } },
  },
  'GET /api/instance/extensions/v1/oauth/audit': {
    operationId: 'getAgentExtensionOAuthAudit', summary: 'Read the OAuth audit trail: connect, disconnect, discarded and Needs sign-in events with the actor and time, newest first.', tags: ['Configuration'],
    responses: { 200: { description: 'Audit events; never tokens.', schema: JsonObject } },
  },
  'GET /api/instance/extensions/v1/oauth/callback': {
    operationId: 'completeAgentExtensionOAuth', summary: 'OAuth redirect URI. Validates the single-use state (bound to the session, item and endpoint), the issuer, exchanges the code with the PKCE verifier and stores the tokens. Returns a small HTML page.', tags: ['Configuration'],
    responses: { 200: { description: 'HTML result page that tells the Settings tab to refresh.' } },
  },
  'GET /api/instance/extensions/v1/oauth/client-metadata.json': {
    operationId: 'getAgentExtensionOAuthClientMetadata', summary: 'ProPR\'s public OAuth Client ID Metadata Document; its URL is the client id. Not found without a public HTTPS base URL.', tags: ['Configuration'],
    responses: { 200: { description: 'Client metadata: ProPR\'s name and this instance\'s redirect URI.', schema: JsonObject } },
  },
};
