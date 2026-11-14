import { z } from 'zod';
import { component, ExtensionLibraryRevisionSchema } from './schemas.js';

/** OpenAPI schemas of the extension library read and its OAuth sign-in routes. Tokens never appear in any of them. */
const ExtensionOAuthConnectionStatusSchema = z.object({
  state: z.enum(['not_connected', 'connected', 'needs_sign_in']),
  connectedBy: z.string().optional().describe('Actor id of the administrator who signed in.'), connectedAt: z.number().optional(),
  scopes: z.array(z.string()).optional().describe('Scopes the authorization server granted.'),
  registration: z.enum(['metadata_document', 'dynamic', 'preregistered']).optional(),
});
export const ExtensionOAuthInstanceInfo = component('ExtensionOAuthInstanceInfo', z.object({
  redirectUri: z.string().nullable().describe('Redirect URI to register with a provider; null without a public HTTPS base URL, which disables Connect.'),
  clientMetadataUrl: z.string().nullable().describe('ProPR\'s Client ID Metadata Document URL, used as the client id where supported.'),
  connections: z.record(z.string(), ExtensionOAuthConnectionStatusSchema).describe('Connection state by OAuth server name. Tokens are never returned.'),
}), 'OAuth sign-in facts of this instance and the connection state of its OAuth library servers.');
export const ExtensionOAuthCheckRequest = component('ExtensionOAuthCheckRequest', z.strictObject({ url: z.string(), clientId: z.string().optional(), scopes: z.array(z.string()).max(32).optional() }));
export const ExtensionOAuthCheckResponse = component('ExtensionOAuthCheckResponse', z.object({ check: z.object({
  authorizationRequired: z.boolean(), discoveredFrom: z.enum(['challenge', 'well_known']).optional(), resource: z.string().optional(), issuer: z.string().optional(),
  scopes: z.array(z.string()).optional(), registration: z.enum(['metadata_document', 'dynamic', 'preregistered']).nullable(), message: z.string(), redirectUri: z.string().nullable(),
}) }));
export const ExtensionOAuthItemRequest = component('ExtensionOAuthItemRequest', z.strictObject({ name: z.string() }));
export const ExtensionOAuthStartResponse = component('ExtensionOAuthStartResponse', z.object({ authorizationUrl: z.string().describe('Provider authorization page to open in a new tab; carries a single-use state bound to this session, PKCE S256 and the resource indicator.') }));
export const ExtensionLibraryRead = component('ExtensionLibraryRead', z.object({
  contract: z.object({}).loose(), instanceId: z.string(), library: ExtensionLibraryRevisionSchema, oauth: ExtensionOAuthInstanceInfo,
  bundles: z.array(z.object({}).loose()), catalog: z.array(z.object({}).loose()), usage: z.object({ automations: z.array(z.object({ id: z.string(), name: z.string(), servers: z.array(z.string()), skills: z.array(z.string()) })), importedFrom: z.object({ servers: z.record(z.string(), z.array(z.string())), skills: z.record(z.string(), z.array(z.string())) }) }).describe('Automations that add library items explicitly (server names and skill bundle ids), and the names of the extension profiles that migrated items came from.'),
}));
