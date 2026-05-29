import { parseVibeOutput } from './vibeOutputParser.js';

const VALID_ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getAnalysisSandboxArgs(mode?: 'execute' | 'analysis'): string[] {
    return mode === 'analysis'
        ? [
            '--read-only',
            '--tmpfs', '/tmp:rw,nosuid,size=512m',
            '--tmpfs', '/home/node/bin:rw,nosuid,size=16m',
            '--tmpfs', '/home/node/.cache:rw,nosuid,size=256m',
            '--tmpfs', '/home/node/.config:rw,nosuid,size=64m',
            '--tmpfs', '/home/node/.local:rw,nosuid,size=128m'
        ]
        : [];
}

export function getParsedVibeError(parsedOutput: ReturnType<typeof parseVibeOutput>): string | undefined {
    if (parsedOutput.error) {
        return parsedOutput.error;
    }
    return parsedOutput.incomplete ? 'Vibe output did not include a final response event' : undefined;
}

export function isSuccessfulVibeResult(exitCode: number | null, parsedOutput: ReturnType<typeof parseVibeOutput>): boolean {
    return exitCode === 0 && !getParsedVibeError(parsedOutput);
}

export function sanitizeDockerNamePart(value: string | undefined, fallback: string): string {
    const sanitized = value?.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '');
    return sanitized || fallback;
}

export function getForwardedVibeEnvVars(envVars: Record<string, string> | undefined): {
    dockerArgs: string[];
    skipped: string[];
} {
    const dockerArgs: string[] = [];
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(envVars || {})) {
        if (key === 'MISTRAL_API_KEY') {
            continue;
        }
        if (!VALID_ENV_VAR_NAME.test(key) || /[\0\r\n]/.test(value)) {
            skipped.push(key);
            continue;
        }
        dockerArgs.push('-e', `${key}=${value}`);
    }
    return { dockerArgs, skipped };
}
