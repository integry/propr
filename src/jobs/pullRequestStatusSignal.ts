/**
 * Signals a pull request status update from worker code. Core is imported
 * lazily so suites that mock `@propr/core` with an enumerated export list keep
 * linking; when the signal is missing (mocked) or status maintenance is off,
 * this is a no-op. Never throws and never waits.
 */
type StatusSignal = (repository: string, prNumber: number) => void;

let signal: Promise<StatusSignal | null> | null = null;
/** Set by the worker and daemon entry points; until then signals do nothing and load nothing. */
let maintenanceEnabled = false;

function loadSignal(): Promise<StatusSignal | null> {
    signal ??= import('@propr/core')
        .then(core => (core as { requestPullRequestStatusSync?: StatusSignal }).requestPullRequestStatusSync ?? null)
        .catch(() => null);
    return signal;
}

export function signalPullRequestStatus(repository: string | null | undefined, prNumber: number | null | undefined): void {
    if (!maintenanceEnabled || !repository || typeof prNumber !== 'number') return;
    void loadSignal().then(request => request?.(repository, prNumber)).catch(() => undefined);
}

/**
 * Turns on pull request status maintenance in this process (worker, daemon):
 * transitions then update the status block of ProPR pull requests whose
 * repository shows it. `backfill` also brings every open ProPR pull request
 * up to date once; the worker asks for it, since it runs in every deployment
 * that does ProPR work, and the webhook processes would only repeat it.
 * Failures are logged; startup never fails on it.
 */
export async function enablePullRequestStatusMaintenance(options: { backfill?: boolean } = {}): Promise<void> {
    try {
        const core = await import('@propr/core') as { enablePullRequestStatusSync?: (deps?: object, options?: { backfill?: boolean }) => void };
        core.enablePullRequestStatusSync?.({}, options);
        maintenanceEnabled = true;
    } catch {
        // Status maintenance is optional; the process keeps running without it.
    }
}
