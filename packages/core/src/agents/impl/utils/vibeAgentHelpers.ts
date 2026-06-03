import fs from 'fs';
import { parseVibeOutput } from './vibeOutputParser.js';

const VALID_ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_LLM_LOG_METADATA_TEXT_CHARS = 20000;

export function getAnalysisSandboxArgs(mode?: 'execute' | 'analysis'): string[] {
    return mode === 'analysis'
        ? [
            '--read-only',
            '--cap-drop=ALL',
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
    if (parsedOutput.incomplete) {
        return 'Vibe output was incomplete: no final response event was emitted';
    }
    return undefined;
}

export function isSuccessfulVibeResult(exitCode: number | null, parsedOutput: ReturnType<typeof parseVibeOutput>): boolean {
    if (exitCode !== 0) return false;
    if (parsedOutput.error) return false;
    if (parsedOutput.incomplete) return false;
    return !!parsedOutput.summary;
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
        if (key === 'MISTRAL_API_KEY' || key === 'VIBE_CLI_ARGS') {
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

export function splitVibeCliArgs(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let escaping = false;
    let hasToken = false;

    for (const char of input) {
        if (escaping) {
            current += char;
            escaping = false;
            hasToken = true;
            continue;
        }

        if (char === '\\') {
            escaping = true;
            hasToken = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            hasToken = true;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            hasToken = true;
            continue;
        }

        if (/\s/.test(char)) {
            if (hasToken) {
                args.push(current);
                current = '';
                hasToken = false;
            }
            continue;
        }

        current += char;
        hasToken = true;
    }

    if (escaping) {
        current += '\\';
    }

    if (quote) {
        throw new Error('unmatched quote');
    }

    if (hasToken) {
        args.push(current);
    }

    return args;
}

// Tied to the pinned mistral-vibe version in Dockerfile.vibe; override via VIBE_CLI_ARGS if flags change.
export function getDefaultVibeCliArgs(): string[] {
    return ['--output', 'json'];
}

export function buildPromptWithRetryContext(prompt: string, isRetry: boolean, retryReason?: string): string {
    if (isRetry && retryReason) {
        return `${prompt}\n\n---\n\nRETRY CONTEXT: This is a retry attempt. Previous attempt failed with: ${retryReason}\n\nPlease address the issues from the previous attempt.`;
    }
    return prompt;
}

export function truncateLogMetadataText(value: string): string {
    if (value.length <= MAX_LLM_LOG_METADATA_TEXT_CHARS) {
        return value;
    }
    const omitted = value.length - MAX_LLM_LOG_METADATA_TEXT_CHARS;
    return `${value.slice(0, MAX_LLM_LOG_METADATA_TEXT_CHARS)}\n...[truncated ${omitted} chars]`;
}

export function buildLogMetadata(
    baseMetadata: Record<string, unknown>,
    result: { stdout: string; stderr: string },
    includeRawOutput: boolean
): Record<string, unknown> {
    if (!includeRawOutput) {
        return { ...baseMetadata };
    }
    return {
        ...baseMetadata,
        rawOutput: truncateLogMetadataText(result.stdout),
        stderr: truncateLogMetadataText(result.stderr),
        rawOutputLength: result.stdout.length,
        stderrLength: result.stderr.length,
        rawOutputTruncated: result.stdout.length > MAX_LLM_LOG_METADATA_TEXT_CHARS,
        stderrTruncated: result.stderr.length > MAX_LLM_LOG_METADATA_TEXT_CHARS
    };
}

export function buildVibeFailureMessage(
    result: { stdout: string; stderr: string; exitCode: number | null },
    parsedOutput: ReturnType<typeof parseVibeOutput>
): string {
    const parsedError = getParsedVibeError(parsedOutput);
    const exitContext = result.exitCode === 0
        ? undefined
        : result.exitCode === null
            ? 'Vibe CLI exited without an exit code'
            : `Vibe CLI exited with code ${result.exitCode}`;
    const parts = [
        parsedError,
        exitContext,
        result.stderr.trim() ? `stderr: ${result.stderr.trim().slice(0, 4000)}` : undefined,
        result.stdout.trim() ? `stdout: ${result.stdout.trim().slice(0, 4000)}` : undefined
    ].filter((part): part is string => Boolean(part));

    return parts.join('\n') || 'Vibe execution failed without diagnostic output';
}

export function writeVibePromptFile(prompt: string): string {
    const baseDir = process.env.VIBE_PROMPT_CACHE_DIR || '/tmp/propr-vibe-prompts';
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o755 });
    const promptDir = fs.mkdtempSync(`${baseDir}/vibe-prompt-`);
    fs.chmodSync(promptDir, 0o755);
    const promptPath = `${promptDir}/prompt.txt`;
    fs.writeFileSync(promptPath, prompt, { encoding: 'utf8', mode: 0o644 });
    return promptPath;
}

/**
 * Translate a container-local path to its host-visible equivalent for Docker
 * bind mounts. In Docker-outside-Docker (launcher), the host daemon resolves
 * -v paths against the host filesystem, not the worker container's filesystem.
 * The launcher sets VIBE_PROMPT_CACHE_HOST_MOUNTED=1 and provides
 * HOST_VIBE_PROMPT_CACHE_DIR so we can translate back.
 */
export function resolveHostBindPath(containerPath: string): string {
    if (process.env.VIBE_PROMPT_CACHE_HOST_MOUNTED !== '1') return containerPath;
    const hostDir = process.env.HOST_VIBE_PROMPT_CACHE_DIR;
    const containerDir = process.env.VIBE_PROMPT_CACHE_DIR || '/tmp/propr-vibe-prompts';
    if (!hostDir) {
        throw new Error(
            'VIBE_PROMPT_CACHE_HOST_MOUNTED=1 is set but HOST_VIBE_PROMPT_CACHE_DIR is missing. ' +
            'The launcher must set HOST_VIBE_PROMPT_CACHE_DIR so prompt files can be bind-mounted ' +
            'into spawned agent containers via the host Docker daemon.'
        );
    }
    if (containerPath.startsWith(containerDir)) {
        return hostDir + containerPath.slice(containerDir.length);
    }
    return containerPath;
}

export function writeMistralEnvFile(apiKey: string | undefined): string | undefined {
    if (!apiKey) return undefined;
    const envDir = fs.mkdtempSync('/tmp/vibe-env-');
    const envPath = `${envDir}/mistral.env`;
    fs.writeFileSync(envPath, `MISTRAL_API_KEY=${apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
    return envPath;
}

export function writeVibeSecretEnvFile(secrets: { mistralApiKey?: string; githubToken?: string }): string | undefined {
    const lines: string[] = [];
    if (secrets.mistralApiKey) lines.push(`MISTRAL_API_KEY=${secrets.mistralApiKey}`);
    if (secrets.githubToken) {
        lines.push(`GH_TOKEN=${secrets.githubToken}`);
        lines.push(`GITHUB_TOKEN=${secrets.githubToken}`);
    }
    if (lines.length === 0) return undefined;
    const envDir = fs.mkdtempSync('/tmp/vibe-env-');
    const envPath = `${envDir}/agent.env`;
    fs.writeFileSync(envPath, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    return envPath;
}

export function cleanupTempFile(filePath: string | undefined): void {
    if (!filePath) return;
    try {
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
}

export function buildVibeContainerName(alias: string, taskType: string, taskId: string | undefined): string {
    const uniqueSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const shortTaskId = sanitizeDockerNamePart(taskId?.slice(-8), uniqueSuffix);
    const sanitizedAlias = sanitizeDockerNamePart(alias, 'vibe');
    const sanitizedType = sanitizeDockerNamePart(taskType, 'task');
    return `${sanitizedAlias}-${sanitizedType}-${shortTaskId}`.slice(0, 128);
}
