/**
 * Trusts ProPR's clone and worktree folders for Git at process start, so a
 * restart never leaves older (agent-owned) worktrees unreadable.
 * Lazy import: test suites replace @propr/core with enumerated mocks.
 */
export async function trustManagedGitDirectoriesAtStartup(): Promise<void> {
    const core = await import('@propr/core');
    if (typeof core.trustManagedGitDirectories !== 'function') return;
    await core.trustManagedGitDirectories(core.createHooklessGit());
}

/** Worker startup: probes Docker for worktree reclamation in the background and trusts the Git folders before any recovery runs. */
export async function prepareWorktreeHost(): Promise<void> {
    const core = await import('@propr/core');
    if (typeof core.probeWorktreeReclamationDocker === 'function') void core.probeWorktreeReclamationDocker();
    await trustManagedGitDirectoriesAtStartup();
}
