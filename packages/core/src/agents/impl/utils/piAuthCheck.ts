import { execFile } from 'child_process';
import fs from 'fs';
import type { AgentConfig, AgentCredentialCheckResult } from '../../types.js';
import { forwardablePiEnvVars, PI_CONTAINER_RUNTIME_HOME, PI_CONTAINER_SOURCE_DIR, type PiDockerInvocation } from './piDockerArgsBuilder.js';
import { createContainerExecutionId } from './containerExecutionId.js';

const STATUSES = new Set<AgentCredentialCheckResult['status']>(['ready', 'not_ready', 'invalid']);
/** `pi auth check` exit codes. */
const STATUS_BY_EXIT_CODE: Record<number, AgentCredentialCheckResult['status']> = { 0: 'ready', 1: 'not_ready', 2: 'invalid' };
const REASON_CODE = /^[a-z0-9_.-]{1,64}$/i;

/**
 * `docker run` arguments for `pi auth check --provider <p> --json --no-refresh`.
 * The host Pi dir is mounted read-only: the check never refreshes a token, so
 * the entrypoint's write-back has nothing to write. It reads local state only,
 * so it runs with no network and no workspace.
 */
export function buildPiAuthCheckDockerArgs(params: { config: AgentConfig; configPath?: string; provider: string; taskId?: string }): PiDockerInvocation {
    const { config, configPath, provider } = params;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) throw new Error(`Invalid Pi provider "${provider}"`);
    const secretEnv = forwardablePiEnvVars(config.envVars);
    const configMountArgs = configPath && fs.existsSync(configPath) ? ['-v', `${configPath}:${PI_CONTAINER_SOURCE_DIR}:ro`] : [];
    const containerName = `${(config.alias || 'pi').replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 64) || 'pi'}-auth-check-${createContainerExecutionId(params.taskId)}`;
    return {
        args: [
            'run', '--rm', '-i', '--name', containerName.slice(0, 128), '--security-opt', 'no-new-privileges', '--network', 'none', '--user', '0:0',
            ...configMountArgs,
            '-e', 'PROPR_AGENT_TYPE=pi',
            '-e', `PROPR_PI_SOURCE_DIR=${PI_CONTAINER_SOURCE_DIR}`,
            '-e', `PROPR_PI_RUNTIME_HOME=${PI_CONTAINER_RUNTIME_HOME}`,
            ...Object.keys(secretEnv).flatMap(name => ['-e', name]),
            config.dockerImage,
            'pi', 'auth', 'check', '--provider', provider, '--json', '--no-refresh',
        ],
        secretEnv,
    };
}

function describe(status: AgentCredentialCheckResult['status'], provider: string, reason?: string): string | undefined {
    if (status === 'ready') return undefined;
    if (reason === 'provider_not_found') return `Pi does not know the provider "${provider}". Check the agent's Pi models.`;
    if (status === 'not_ready') {
        return `Pi has no credentials for ${provider}. Log in with \`pi auth login ${provider}\`, or set the provider's API key in the agent's environment variables.`;
    }
    return `Pi's ${provider} credentials are invalid${reason ? ` (${reason})` : ''}. Log in to ${provider} again.`;
}

type PiAuthCheckJson = { status: AgentCredentialCheckResult['status']; provider?: unknown; reason?: unknown; authType?: unknown };

/** The last stdout line that is a check result object. */
function findResultLine(stdout: string): PiAuthCheckJson | undefined {
    for (const line of stdout.split(/\r?\n/).reverse()) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const value = JSON.parse(trimmed) as { status?: unknown } | null;
            if (value && typeof value === 'object' && STATUSES.has(value.status as never)) return value as PiAuthCheckJson;
        } catch { /* not the result line */ }
    }
    return undefined;
}

/** A provider-reported code, dropped unless it is a plain identifier. */
function code(value: unknown): string | undefined {
    return typeof value === 'string' && REASON_CODE.test(value) ? value : undefined;
}

/**
 * Reads `pi auth check --json` output: one JSON object such as
 * `{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}`.
 * The exit code (0 ready, 1 not_ready, 2 invalid) decides when the JSON is
 * missing or unreadable; any other exit code is not a check result.
 */
export function parsePiAuthCheckOutput(stdout: string, exitCode: number | null, provider: string): AgentCredentialCheckResult {
    const parsed = findResultLine(stdout);
    const status = parsed?.status ?? (exitCode === null ? undefined : STATUS_BY_EXIT_CODE[exitCode]);
    if (!status) throw new Error(`pi auth check failed${exitCode === null ? '' : ` with exit code ${exitCode}`} without a result`);
    const reportedProvider = code(parsed?.provider) ?? provider;
    const reason = code(parsed?.reason);
    const authType = code(parsed?.authType);
    const message = describe(status, reportedProvider, reason);
    return { status, provider: reportedProvider, ...(reason && { reason }), ...(authType && { authType }), ...(message && { message }) };
}

export interface PiAuthCheckCommandResult { stdout: string; stderr: string; exitCode: number | null }
export type PiAuthCheckRunner = (args: string[], env: Record<string, string>, timeoutMs: number) => Promise<PiAuthCheckCommandResult>;

/** Runs docker with the secrets in its client environment only, never in argv. */
export const runDockerForPiAuthCheck: PiAuthCheckRunner = (args, env, timeoutMs) => new Promise((resolve, reject) => {
    execFile('docker', args, { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (error && typeof code !== 'number') {
            reject(new Error((error as { killed?: boolean }).killed ? 'pi auth check timed out' : String(stderr || error.message).trim()));
            return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: error ? (code as number) : 0 });
    });
});

/** Runs the check; a docker or entrypoint failure (exit code above 2) is an error, not a result. */
export async function runPiAuthCheck(invocation: PiDockerInvocation, provider: string, options: { timeoutMs?: number; run?: PiAuthCheckRunner } = {}): Promise<AgentCredentialCheckResult> {
    const { stdout, stderr, exitCode } = await (options.run ?? runDockerForPiAuthCheck)(invocation.args, invocation.secretEnv, options.timeoutMs ?? 60_000);
    if (exitCode !== null && exitCode > 2 && !/^\s*\{/m.test(stdout)) {
        throw new Error(`pi auth check could not run (exit code ${exitCode}): ${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500)}`);
    }
    return parsePiAuthCheckOutput(stdout, exitCode, provider);
}
