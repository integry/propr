import type { McpStatus } from '../../api/adminMcpApi';
import type { SettingsStatusTone } from './SettingsLayout';

/** Hosted UI tunnel mode reports MCP through ProPR Connect instead of the direct server switch. */
export function tunnelStatusLabel(status: McpStatus): string {
  if (status.operatorForced === 'off') return 'Disabled by operator';
  if (status.connectTrustDisabled) return 'Disabled by configuration';
  if (!status.enabled && status.setupError) return 'Setup required';
  if (!status.enabled) return 'Disabled';
  if (status.connectMcp === 'registered') return 'Connected';
  if (status.connectMcp?.startsWith('failed:')) return 'Registration failed';
  return 'Registering';
}

export function tunnelStatusTone(status: McpStatus): SettingsStatusTone {
  if (status.connectTrustDisabled) return 'pending';
  if (status.setupError || status.connectMcp?.startsWith('failed:')) return 'error';
  return status.enabled && status.connectMcp === 'registered' ? 'ok' : 'pending';
}

export function tunnelStatusDescription(status: McpStatus): string {
  if (status.operatorForced === 'off') return ' MCP is disabled by operator configuration.';
  if (status.connectTrustDisabled) {
    return ' MCP_CONNECT_TRUST=false turns off MCP through ProPR Connect, and this setting cannot override it. Remove MCP_CONNECT_TRUST to use Connect.';
  }
  if (status.setupError === 'KEY_MISSING' || status.setupError === 'KEY_CHANGED') {
    return ' The persisted MCP encryption key is missing or changed. Restore it from backup, or set MCP_ENCRYPTION_KEY to the original value.';
  }
  if (status.setupError) return ` MCP through ProPR Connect could not start (${status.setupError}). Check the API log for details.`;
  if (status.enabled && status.connectMcp?.startsWith('failed:')) {
    return ` Registration with ProPR Connect failed (${status.connectMcp.slice('failed:'.length)}). It is retried automatically.`;
  }
  return ' This instance uses the hosted UI tunnel, so clients connect through ProPR Connect with no extra setup.';
}
