import fs from 'fs';
import path from 'path';
import {
    ANTIGRAVITY_KEYRING_MARKER_FILE,
    ANTIGRAVITY_TOKEN_FILE,
    antigravityLoginFailureReason,
    antigravityMissingLoginReason,
    isManagedAgentConfigPath,
} from '@propr/shared';

export interface AntigravityCredentialState {
    /** `missing` only when the directory is visible and has no file token. */
    status: 'present' | 'missing' | 'unknown';
    keyringMarkerDetected: boolean;
    /** Actionable not-ready reason when `status` is `missing`. */
    reason?: string;
}

function isFile(filePath: string): boolean {
    try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function isDirectory(dirPath: string): boolean {
    try { return fs.statSync(dirPath).isDirectory(); } catch { return false; }
}

/**
 * The host home that owns an unmanaged `<home>/.gemini`, when the worker can
 * see it (desktop/local runtime). Managed logins have no host keyring.
 */
function visibleHostHome(configDir: string): string | undefined {
    if (isManagedAgentConfigPath(configDir) || path.basename(configDir) !== '.gemini') return undefined;
    return path.dirname(configDir);
}

/**
 * Agent environment variables that select an Antigravity sign-in other than
 * the `agy login` file token: a Gemini API key, Application Default
 * Credentials, or a service-account key file. With one of them configured the
 * file token is optional, so readiness is left to the provider probe.
 */
export const ANTIGRAVITY_ALTERNATIVE_AUTH_ENV_VARS = [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'AGY_ADC_AUTH',
    'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

/** Whether the environment passed to the Antigravity container configures a non-OAuth sign-in. */
export function hasAntigravityAlternativeAuth(environment: Record<string, string> | undefined): boolean {
    return !!environment && ANTIGRAVITY_ALTERNATIVE_AUTH_ENV_VARS.some(name => (environment[name] ?? '').trim() !== '');
}

/**
 * Checks the Antigravity credential directory for the file token the
 * container runtime copies. Only file presence is checked: token and keyring
 * contents are never read. A directory the worker cannot see is `unknown`,
 * because the container may still receive it through a host bind mount.
 * When `environment` (the agent's configured container environment) selects
 * an alternative sign-in, a missing file token is not a problem: `unknown`.
 */
export function inspectAntigravityCredentials(configDir: string, environment?: Record<string, string>): AntigravityCredentialState {
    if (!configDir || !isDirectory(configDir)) return { status: 'unknown', keyringMarkerDetected: false };
    if (isFile(path.join(configDir, ANTIGRAVITY_TOKEN_FILE))) return { status: 'present', keyringMarkerDetected: false };
    const home = visibleHostHome(configDir);
    const keyringMarkerDetected = !!home && fs.existsSync(path.join(home, ANTIGRAVITY_KEYRING_MARKER_FILE));
    if (hasAntigravityAlternativeAuth(environment)) return { status: 'unknown', keyringMarkerDetected };
    return { status: 'missing', keyringMarkerDetected, reason: antigravityMissingLoginReason({ keyringMarkerDetected }) };
}

/**
 * Maps container output from a failed run to the actionable login reason, if
 * it shows a missing login. An alternative sign-in configured in
 * `environment` keeps the CLI's own error: the file-token guidance would not apply.
 */
export function resolveAntigravityLoginFailure(output: string | undefined, configDir: string, environment?: Record<string, string>): string | undefined {
    if (!output || hasAntigravityAlternativeAuth(environment)) return undefined;
    return antigravityLoginFailureReason(output, { keyringMarkerDetected: inspectAntigravityCredentials(configDir).keyringMarkerDetected });
}

/** {@link resolveAntigravityLoginFailure} over a finished container run's stdout and stderr. */
export function antigravityRunLoginFailure(result: { stdout: string; stderr: string }, configDir: string, environment?: Record<string, string>): string | undefined {
    return resolveAntigravityLoginFailure(`${result.stdout}\n${result.stderr}`, configDir, environment);
}
