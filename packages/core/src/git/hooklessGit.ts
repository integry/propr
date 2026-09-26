import { simpleGit, type SimpleGit } from 'simple-git';

/**
 * Repository hooks are untrusted code and must never execute in the host-side
 * worker. Validation belongs in the sandboxed agent and in CI.
 *
 * Per-command configuration overrides both `.git/hooks` and any repository
 * `core.hooksPath` setting without mutating the repository's configuration.
 */
export const DISABLED_GIT_HOOKS_PATH = '/dev/null';

export function createHooklessGit(baseDir?: string): SimpleGit {
    return simpleGit({
        ...(baseDir ? { baseDir } : {}),
        config: [`core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`],
        // simple-git treats every hooksPath override as potentially dangerous.
        // This one is a fixed, non-executable sink rather than caller input.
        unsafe: { allowUnsafeHooksPath: true },
    });
}
