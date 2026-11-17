import type { PullRequestStatusPull } from './pullRequestStatusFacts.js';

function mergeability(pull: PullRequestStatusPull): boolean | null {
    return typeof pull.mergeable === 'boolean' ? pull.mergeable : null;
}

/**
 * The facts read for `read` still describe `latest`: same state, head, base
 * and mergeability. A push to the base branch changes neither the head nor
 * the state, but can make the pull request conflict: GitHub then reports a
 * different mergeability (or base tip), and a status computed from the old
 * value, such as ready, must not be written.
 */
export function sameStatusSubject(read: PullRequestStatusPull, latest: PullRequestStatusPull): boolean {
    return read.state === latest.state && (read.merged === true) === (latest.merged === true) && read.head.sha === latest.head.sha
        && mergeability(read) === mergeability(latest)
        && read.base?.ref === latest.base?.ref && read.base?.sha === latest.base?.sha;
}
