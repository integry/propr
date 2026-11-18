/**
 * The publication steps an issue run goes through after the agent finishes.
 * A run that fails in one of them has not opened a pull request, so it must end
 * failed with a comment that names the step, never with a success notice.
 */
export type PostProcessingStep = 'commit' | 'push' | 'pull_request';

const STEP_NAMES: Record<PostProcessingStep, string> = {
    commit: 'Committing the changes',
    push: 'Pushing the branch',
    pull_request: 'Opening the pull request',
};

export function postProcessingStepName(step: PostProcessingStep): string {
    return STEP_NAMES[step];
}

/** One line for the task's failure reason, e.g. "Opening the pull request failed: Validation Failed". */
export function describePostProcessingStepFailure(step: PostProcessingStep, error: string | undefined): string {
    const detail = error?.trim();
    return `${postProcessingStepName(step)} failed${detail ? `: ${detail}` : ''}`;
}

/** The heading of the issue comment that reports a failed publication step. */
export function formatPostProcessingStepHeading(step: PostProcessingStep, context: { commitHash?: string; branchName?: string }): string {
    const commit = context.commitHash ? ` (\`${context.commitHash.substring(0, 7)}\`)` : '';
    const branch = context.branchName ? ` to \`${context.branchName}\`` : '';
    const state = step === 'commit'
        ? 'The changes were not committed'
        : step === 'push'
            ? `The changes were committed${commit} but not pushed`
            : `The changes were committed${commit} and pushed${branch}`;
    return `❌ **${postProcessingStepName(step)} failed.** ${state}, so no pull request was opened.`;
}
