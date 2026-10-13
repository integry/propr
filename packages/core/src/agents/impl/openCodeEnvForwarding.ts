// Hardening for user-configured agent env vars forwarded into the OpenCode
// container: enforce POSIX-valid names, never forward GitHub credentials or
// wrapper-managed vars, and reject values that could break the `-e KEY=VALUE`
// contract (newlines/NUL). Dependency-free so diagnostics can mirror the
// launcher's mount decisions without importing the launcher.
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCKED_ENV_NAMES = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_ACCESS_TOKEN']);
const RESERVED_ENV_NAMES = new Set([
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT',
    'PROPR_MANAGED_CREDENTIALS',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME'
]);
const GITHUB_CREDENTIAL_NAME_PATTERN = /^(?:GH|GITHUB)_.*(?:TOKEN|KEY|SECRET|PASSWORD|PAT|PRIVATE_KEY)$/;

export type OpenCodeEnvVarRejection = 'invalid-name' | 'github-credential' | 'reserved' | 'unsafe-value';

/** Why an agent env var is not forwarded into the OpenCode container, or null when it is. */
export function openCodeEnvVarRejection(key: string, value: string): OpenCodeEnvVarRejection | null {
    if (!ENV_NAME_PATTERN.test(key)) return 'invalid-name';
    if (BLOCKED_ENV_NAMES.has(key) || GITHUB_CREDENTIAL_NAME_PATTERN.test(key)) return 'github-credential';
    if (RESERVED_ENV_NAMES.has(key)) return 'reserved';
    if (value.includes('\n') || value.includes('\r') || value.includes('\0')) return 'unsafe-value';
    return null;
}
