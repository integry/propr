/**
 * A repository workflow file that cannot be used as written. Retrying the same
 * attempt reads the same base commit, so the failure is deterministic until a
 * new commit changes the policy.
 */
export class RepositoryWorkflowPolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RepositoryWorkflowPolicyError';
    }
}
