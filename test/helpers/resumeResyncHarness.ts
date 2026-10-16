import assert from 'node:assert';
import { RoutingResumeResyncCoordinator } from '../../packages/core/src/intake/routingResumeResyncCoordinator.js';
import { InMemoryResumeResyncStore } from '../../packages/core/src/intake/routingResumeResyncStore.js';
import type {
    ResumeResyncReconciler,
    ResyncRepositoryStep,
    ResyncRepositoryStepContext,
} from '../../packages/core/src/intake/routingResumeResyncRun.js';

/**
 * Drives one resume-resync generation through the real coordinator and store
 * with a reconciler whose families are no-ops except the ones a test supplies,
 * so a test can prove that a strict family failure never emits
 * `resync_complete`. The coordinator reaches the webhook handler (and through
 * it the task-intent modules), so a test that mocks those modules imports this
 * harness after registering its mocks.
 */

const FAMILIES = ['repository_access', 'task_intents', 'labelled_issues', 'pull_request_comments', 'pull_request_heads', 'merge_conflicts'] as const;

export interface HarnessOptions {
    repositories?: string[];
    referenced?: string[];
    steps: Partial<Record<(typeof FAMILIES)[number], ResyncRepositoryStep['run']>>;
}

export interface HarnessResult {
    state: string;
    completions: Record<string, unknown>[];
    contexts: Array<{ family: string } & Pick<ResyncRepositoryStepContext, 'repository' | 'access' | 'configured'>>;
    lastError: string | null;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

/** Runs a single attempt (no retries) and reports whether it completed. */
export async function runResyncGeneration(options: HarnessOptions): Promise<HarnessResult> {
    const contexts: HarnessResult['contexts'] = [];
    const reconciler: ResumeResyncReconciler = {
        listRepositories: () => options.repositories ?? ['acme/widgets'],
        listReferencedRepositories: () => options.referenced ?? [],
        repositorySteps: FAMILIES.map(family => ({
            family,
            run: async (ctx: ResyncRepositoryStepContext) => {
                contexts.push({ family, repository: ctx.repository, access: ctx.access, configured: ctx.configured });
                return options.steps[family]?.(ctx);
            },
        })),
        installationSteps: [{ family: 'ultrafix_continuations', run: async () => undefined }],
    };
    const coordinator = new RoutingResumeResyncCoordinator({
        installationId: 42, store: new InMemoryResumeResyncStore(), reconciler, maxConsecutiveFailures: 1,
    });
    const completions: Record<string, unknown>[] = [];
    await coordinator.start();
    coordinator.attach(frame => { if (frame.type === 'resync_complete') completions.push(frame); return true; });
    const frame = {
        type: 'resync_required', version: 1, installationId: 42, routingGeneration: 1, resumeGeneration: 1,
        gapStartedAt: '2026-10-10T00:00:00.000Z', gapEndedAt: '2026-10-12T00:00:00.000Z',
    };
    await coordinator.handleFrame(frame, Buffer.byteLength(JSON.stringify(frame)));
    await waitFor(() => ['failed', 'completed'].includes(coordinator.getStatus().state), 'the attempt to settle');
    const status = coordinator.getStatus();
    await coordinator.stop();
    return { state: status.state, completions, contexts, lastError: status.lastError };
}
