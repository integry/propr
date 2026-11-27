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
 * Checks the Antigravity credential directory for the file token the
 * container runtime copies. Only file presence is checked: token and keyring
 * contents are never read. A directory the worker cannot see is `unknown`,
 * because the container may still receive it through a host bind mount.
 */
export function inspectAntigravityCredentials(configDir: string): AntigravityCredentialState {
    if (!configDir || !isDirectory(configDir)) return { status: 'unknown', keyringMarkerDetected: false };
    if (isFile(path.join(configDir, ANTIGRAVITY_TOKEN_FILE))) return { status: 'present', keyringMarkerDetected: false };
    const home = visibleHostHome(configDir);
    const keyringMarkerDetected = !!home && fs.existsSync(path.join(home, ANTIGRAVITY_KEYRING_MARKER_FILE));
    return { status: 'missing', keyringMarkerDetected, reason: antigravityMissingLoginReason({ keyringMarkerDetected }) };
}

/** Maps container output from a failed run to the actionable login reason, if it shows a missing login. */
export function resolveAntigravityLoginFailure(output: string | undefined, configDir: string): string | undefined {
    if (!output) return undefined;
    return antigravityLoginFailureReason(output, { keyringMarkerDetected: inspectAntigravityCredentials(configDir).keyringMarkerDetected });
}

/** {@link resolveAntigravityLoginFailure} over a finished container run's stdout and stderr. */
export function antigravityRunLoginFailure(result: { stdout: string; stderr: string }, configDir: string): string | undefined {
    return resolveAntigravityLoginFailure(`${result.stdout}\n${result.stderr}`, configDir);
}
