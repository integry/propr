// Release Rollout (.github/workflows/release-rollout.yml) calls the Linux
// preview, signing and publication workflows as reusable workflows inside one
// run. A step that needs an earlier step's run (the unsigned stage run, the
// signing run) then receives this same run's id instead of a separate
// successful dispatch of desktop-linux-preview.yml or
// desktop-linux-signed-preview.yml.
//
// That run is accepted only when it is the run currently executing, the run's
// own workflow_ref (set by Actions, not by an input) is the reviewed main copy
// of release-rollout.yml, and the GitHub API agrees on the run's identity. The
// earlier step's success is then guaranteed by the caller's `needs` chain, and
// its artifacts are read from this run by their run-specific names.

export const RELEASE_ROLLOUT_WORKFLOW = '.github/workflows/release-rollout.yml';
const ROLLOUT_EVENTS = new Set(['workflow_dispatch', 'workflow_run']);

export const releaseRolloutWorkflowRef = repository => `${repository}/${RELEASE_ROLLOUT_WORKFLOW}@refs/heads/main`;

export function isCurrentReleaseRolloutRun(run, { runId, currentRunId, workflowRef, repository }) {
  return typeof runId === 'string' && /^[1-9]\d*$/.test(runId)
    && runId === currentRunId
    && workflowRef === releaseRolloutWorkflowRef(repository)
    && String(run?.id) === runId
    && run.path === RELEASE_ROLLOUT_WORKFLOW
    && ROLLOUT_EVENTS.has(run.event)
    && run.status === 'in_progress'
    && run.repository?.full_name === repository;
}
