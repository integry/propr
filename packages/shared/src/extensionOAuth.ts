/**
 * Public projection of OAuth sign-in for library MCP servers. A connection is
 * credential state of one library item: it is never part of a library
 * revision, and tokens never appear in any projection.
 */
export const EXTENSION_OAUTH_STATES = ['not_connected', 'connected', 'needs_sign_in'] as const;
export type ExtensionOAuthConnectionState = (typeof EXTENSION_OAUTH_STATES)[number];
/** How ProPR identifies itself to the authorization server, in the order tried. */
export const EXTENSION_OAUTH_REGISTRATIONS = ['metadata_document', 'dynamic', 'preregistered'] as const;
export type ExtensionOAuthRegistration = (typeof EXTENSION_OAUTH_REGISTRATIONS)[number];

/** Connection status of one OAuth library server, safe for administrators. */
export interface ExtensionOAuthConnectionStatus {
  state: ExtensionOAuthConnectionState;
  /** Actor id of the administrator who signed in. */
  connectedBy?: string;
  /** Epoch milliseconds of the sign-in. */
  connectedAt?: number;
  /** Scopes the authorization server granted. */
  scopes?: string[];
  registration?: ExtensionOAuthRegistration;
}

/** OAuth facts of this instance shown in the server form. */
export interface ExtensionOAuthInstanceInfo {
  /** The redirect URI to register with a provider; null without a public base URL. */
  redirectUri: string | null;
  /** The client id ProPR uses with Client ID Metadata Document support; null without a public base URL. */
  clientMetadataUrl: string | null;
  /** Connection status by server name, for every `oauth` server in the library. */
  connections: Record<string, ExtensionOAuthConnectionStatus>;
}

/** What the server form's Check action found; nothing is stored. */
export interface ExtensionOAuthCheckResult {
  /** The MCP server answered without requiring authorization. */
  authorizationRequired: boolean;
  /** Where the protected resource metadata came from. */
  discoveredFrom?: 'challenge' | 'well_known';
  resource?: string;
  issuer?: string;
  scopes?: string[];
  /** The registration method a sign-in would use, or null when none is possible. */
  registration: ExtensionOAuthRegistration | null;
  /** Plain-language explanation of the result. */
  message: string;
  redirectUri: string | null;
}

export const EXTENSION_OAUTH_PATHS = {
  callback: '/api/instance/extensions/v1/oauth/callback',
  clientMetadata: '/api/instance/extensions/v1/oauth/client-metadata.json',
} as const;
