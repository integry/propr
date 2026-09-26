export const DESKTOP_TOKEN_REVOCATION_ENDPOINT = '/api/desktop/tokens/current';
export const DESKTOP_REVOCATION_BINDING_HEADER = 'X-ProPR-Desktop-Revocation-Binding';
export const DESKTOP_TOKEN_REVOCATION_SCHEMA = 'propr.desktop-token-revocation';
export const DESKTOP_TOKEN_REVOCATION_VERSION = 1;

export const DESKTOP_TOKEN_TERMINAL_CODES = [
  'TOKEN_NOT_FOUND',
  'INSTANCE_TOKEN_REVOKED',
  'INSTANCE_TOKEN_EXPIRED',
] as const;

export type DesktopTokenTerminalCode = typeof DESKTOP_TOKEN_TERMINAL_CODES[number];

export interface DesktopTokenTerminalRevocation {
  schema: typeof DESKTOP_TOKEN_REVOCATION_SCHEMA;
  version: typeof DESKTOP_TOKEN_REVOCATION_VERSION;
  endpoint: typeof DESKTOP_TOKEN_REVOCATION_ENDPOINT;
  terminal: true;
  code: DesktopTokenTerminalCode;
  credentialGeneration: string;
}
