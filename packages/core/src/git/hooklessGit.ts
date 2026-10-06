import { simpleGit, type SimpleGit } from 'simple-git';

/**
 * Repository hooks are untrusted code and must never execute in the host-side
 * worker. Validation belongs in the sandboxed agent and in CI.
 *
 * Per-command configuration overrides both `.git/hooks` and any repository
 * `core.hooksPath` setting without mutating the repository's configuration.
 */
export const DISABLED_GIT_HOOKS_PATH = '/dev/null';

/**
 * Process-local configuration used by configureGitAuthentication. simple-git
 * rejects every other guarded variable supplied through `.env()`.
 */
export const GIT_AUTHENTICATION_ENVIRONMENT = [
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_KEY_1',
    'GIT_CONFIG_VALUE_1',
] as const;

export function createHooklessGit(baseDir?: string): SimpleGit {
    return simpleGit({
        ...(baseDir ? { baseDir } : {}),
        config: [`core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`],
        allowEnvironment: GIT_AUTHENTICATION_ENVIRONMENT,
        // simple-git treats every hooksPath override as potentially dangerous.
        // This one is a fixed, non-executable sink rather than caller input.
        unsafe: {
            allowUnsafeHooksPath: true,
            // configureGitAuthentication supplies credentials only through
            // process-local config and clears (rather than runs) helpers.
            allowUnsafeConfigEnvCount: true,
            allowUnsafeCredentialHelper: true,
        },
    });
}
