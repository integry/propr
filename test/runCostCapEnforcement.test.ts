import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection, getActiveRunCostGuard, RepositoryWorkflowPolicyError, runCostCapTerminalReason } from '@propr/core';
import type { RunCostSnapshot } from '@propr/core';
import { budgetExceededEvent, issueRunCostCapTarget, postCostCapNotice, pullRequestRunCostCapTarget, withRunCostCap, type RunCostCapDeps, type RunCostCapTarget } from '../src/jobs/runCostCap.js';
import { applyReviewWorkflowCostCap } from '../src/jobs/prCommentReviewJob.js';
import type { CommentJobData, IssueJobData } from '@propr/core';

after(async () => { await closeConnection(); });

const target: RunCostCapTarget = { taskId: 'task-cap', repoOwner: 'acme', repoName: 'app', number: 7, kind: 'issue', modelName: 'test-model' };

function harness(options: { recorded?: number; instanceDefault?: unknown } = {}) {
    const timeline: Array<ReturnType<typeof budgetExceededEvent>> = [];
    const stored: unknown[] = [];
    const deps: RunCostCapDeps = {
        loadInstanceDefault: async () => options.instanceDefault ?? 2,
        readRecordedSpend: async taskIds => { assert.ok(taskIds.includes('task-cap')); return options.recorded ?? 0; },
        storeCap: async (_taskId, cap) => { stored.push(cap); },
        recordExceeded: async (exceededTarget, snapshot) => { timeline.push(budgetExceededEvent(snapshot, exceededTarget.budgetTaskIds)); },
        // $1 per 1000 output tokens.
        priceUsage: async (_model, totals) => totals.outputTokens / 1000,
        checkIntervalMs: 60_000,
    };
    return { deps, timeline, stored };
}

const usageLine = (id: string, outputTokens: number) => JSON.stringify({ type: 'assistant', message: { id, usage: { output_tokens: outputTokens } } });

test('a run past its cap is stopped once, records budget.exceeded and ends as cost_cap_exceeded', async () => {
    const { deps, timeline, stored } = harness({ recorded: 0.5 });
    const stops: string[] = [];
    let terminalReason: string | undefined;
    await withRunCostCap(target, async guard => {
        // Stands in for the Docker executor, which registers every agent container it starts.
        const execution = getActiveRunCostGuard()!.beginExecution(message => stops.push(message))!;
        execution.observeLine(usageLine('m1', 1000));
        await guard.check();
        assert.equal(stops.length, 0, '$0.50 recorded + $1.00 live is under the $2 cap');
        execution.observeLine(usageLine('m2', 800));
        await guard.check();
        await guard.check();
        execution.finish();
        terminalReason = runCostCapTerminalReason(target.taskId, 'completed');
    }, deps);

    assert.equal(stops.length, 1, 'the stop path is invoked once');
    assert.match(stops[0], /run spend cap of \$2\.00 exceeded/);
    assert.equal(terminalReason, 'cost_cap_exceeded');
    assert.deepEqual(stored, [{ capUsd: 2, source: 'instance_default' }]);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].metadata.event, 'budget.exceeded');
    assert.deepEqual(timeline[0].metadata.budget, { capUsd: 2, spentUsd: 2.3, priorSpentUsd: 0.5, percent: 115, source: 'instance_default' });
    assert.match(timeline[0].reason, /Spend cap reached: estimated \$2\.30 of \$2\.00 \(cap from instance default\)/);
});

test('a PR job on the configured default model is priced with the model its agent execution resolved', async () => {
    const { deps, timeline } = harness();
    const priced: string[] = [];
    deps.priceUsage = async (model, totals) => { priced.push(model); return totals.outputTokens / 1000; };
    // No explicit `llm`: the agent runs its configured default model.
    const job = { id: 'pr-job-1', data: { repoOwner: 'acme', repoName: 'app', pullRequestNumber: 12 } as CommentJobData };
    const prTarget = { ...pullRequestRunCostCapTarget(job), taskId: 'task-cap', getOctokit: undefined };
    assert.equal(prTarget.modelName, undefined);
    let message: string | null = null;
    await withRunCostCap(prTarget, async () => {
        const execution = getActiveRunCostGuard()!.beginExecution(() => undefined, 'gpt-5-codex')!;
        // Codex usage records name no model.
        for (let turn = 0; turn < 3; turn++) execution.observeLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 1000 } }));
        message = await execution.finish();
    }, deps);
    assert.match(message ?? '', /run spend cap of \$2\.00 exceeded/);
    assert.ok(priced.length > 0 && priced.every(model => model === 'gpt-5-codex'));
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].metadata.budget.spentUsd, 3);
});

test('the budget.exceeded event keeps the earlier attempts whose spend the run continues', async () => {
    const { deps, timeline } = harness({ recorded: 1.5 });
    await withRunCostCap({ ...target, budgetTaskIds: ['attempt-1', 'task-cap', 'attempt-1', ''] }, async () => {
        const execution = getActiveRunCostGuard()!.beginExecution(() => undefined)!;
        execution.observeLine(usageLine('m1', 1000));
        await execution.finish();
    }, deps);
    assert.equal(timeline.length, 1);
    assert.deepEqual(timeline[0].metadata.budget.budgetTaskIds, ['attempt-1']);
});

test('the per-task override wins over the workflow and instance caps', async () => {
    const { deps, stored } = harness();
    await withRunCostCap({ ...target, override: 9, workflowCap: 4 }, async guard => {
        assert.deepEqual(guard.cap, { capUsd: 9, source: 'override' });
    }, deps);
    assert.deepEqual(stored, [{ capUsd: 9, source: 'override' }]);
});

test('a malformed instance default leaves runs uncapped instead of stopping them at $0', async () => {
    const { deps, timeline } = harness({ instanceDefault: 'ten dollars' });
    await withRunCostCap(target, async guard => {
        assert.equal(guard.cap, null);
        assert.equal(getActiveRunCostGuard()!.beginExecution(() => assert.fail('uncapped runs are never stopped')), null);
    }, deps);
    assert.equal(timeline.length, 0);
});

test('an uncapped retry clears the cap its earlier attempt stored under the same task ID', async () => {
    // Stands in for the Redis record task details read the cap from.
    const records = new Map<string, unknown>();
    const store = (deps: RunCostCapDeps): RunCostCapDeps => ({
        ...deps,
        storeCap: async (taskId, cap) => { if (cap) records.set(taskId, cap); else records.delete(taskId); },
    });
    await withRunCostCap({ ...target, workflowCap: 4 }, async guard => {
        assert.deepEqual(guard.cap, { capUsd: 4, source: 'workflow' });
    }, store(harness({ instanceDefault: 'none' }).deps));
    assert.deepEqual(records.get(target.taskId), { capUsd: 4, source: 'workflow' });

    // The retry runs after the configured cap was removed.
    await withRunCostCap(target, async guard => {
        assert.equal(guard.cap, null);
        assert.equal(records.has(target.taskId), false, 'the stale cap is cleared before the retry runs');
        await guard.setWorkflowCap(undefined);
    }, store(harness({ instanceDefault: 'none' }).deps));
    assert.equal(records.has(target.taskId), false);
});

test('a default cap that cannot be read fails the run before any agent starts', async () => {
    const { deps, stored } = harness();
    deps.loadInstanceDefault = async () => { throw new Error('settings database unavailable'); };
    let ran = false;
    await assert.rejects(withRunCostCap(target, async () => { ran = true; }, deps), /settings database unavailable/);
    assert.equal(ran, false, 'no chargeable work runs without the configured default');
    assert.deepEqual(stored, []);
});

test('a task override that sets the cap lets the run proceed when the default cannot be read', async () => {
    const { deps } = harness();
    deps.loadInstanceDefault = async () => { throw new Error('settings database unavailable'); };
    await withRunCostCap({ ...target, override: 3 }, async guard => {
        assert.deepEqual(guard.cap, { capUsd: 3, source: 'override' });
    }, deps);
    // A malformed override sets no cap, so the unread default still matters.
    await assert.rejects(withRunCostCap({ ...target, override: 'lots' }, async () => assert.fail('must not run'), deps), /settings database unavailable/);
});

describe('review workflow spend cap', () => {
    const prData = { data: { base: { ref: 'main' } } };
    const reviewContext = { repoOwner: 'acme', repoName: 'app', correlationId: 'corr', correlatedLogger: { warn: () => undefined } as never };
    const noOctokit = {} as Parameters<typeof applyReviewWorkflowCostCap>[0];
    const none = harness({ instanceDefault: 'none' }).deps;

    test('a workflow that cannot be read fails the review instead of running it uncapped', async () => {
        await withRunCostCap(target, async guard => {
            await assert.rejects(applyReviewWorkflowCostCap(noOctokit, prData, reviewContext, async () => { throw Object.assign(new Error('GitHub 502'), { status: 502 }); }), /GitHub 502/);
            assert.equal(guard.cap, null);
        }, none);
    });

    test('the workflow cap applies when the workflow is read', async () => {
        await withRunCostCap(target, async guard => {
            await applyReviewWorkflowCostCap(noOctokit, prData, reviewContext, async () => ({ config: { limits: { max_cost_usd: 5 } } }) as never);
            assert.deepEqual(guard.cap, { capUsd: 5, source: 'workflow' });
        }, none);
    });

    test('an invalid workflow file leaves the other caps in force', async () => {
        await withRunCostCap(target, async guard => {
            await applyReviewWorkflowCostCap(noOctokit, prData, reviewContext, async () => { throw new RepositoryWorkflowPolicyError('Invalid .propr/workflow.yml: bad'); });
            assert.equal(guard.cap, null);
        }, none);
    });

    test('a task override skips the workflow read it outranks', async () => {
        await withRunCostCap({ ...target, override: 2 }, async guard => {
            await applyReviewWorkflowCostCap(noOctokit, prData, reviewContext, async () => assert.fail('the workflow is not read'));
            assert.deepEqual(guard.cap, { capUsd: 2, source: 'override' });
        }, none);
    });
});

describe('issue spend cap override lookup', () => {
    const issueRef = { repoOwner: 'acme', repoName: 'app', number: 7 } as IssueJobData;
    const issueContext = { taskId: 'task-cap', modelName: 'test-model', correlatedLogger: { warn: () => undefined } as never };
    const job = (data: Partial<IssueJobData> = {}) => ({ ...issueRef, ...data }) as IssueJobData;

    test('a failed submission lookup fails the attempt', async () => {
        await assert.rejects(issueRunCostCapTarget(job(), issueContext, undefined, {
            findSubmission: async () => { throw new Error('database unavailable'); },
            readOverride: async () => assert.fail('not reached'),
        }), /database unavailable/);
    });

    test('a failed label-start override lookup fails the attempt', async () => {
        await assert.rejects(issueRunCostCapTarget(job(), issueContext, undefined, {
            findSubmission: async () => undefined,
            readOverride: async () => { throw new Error('redis unavailable'); },
        }), /redis unavailable/);
    });

    test('the job override needs no lookup', async () => {
        const resolved = await issueRunCostCapTarget(job({ maxCostUsd: 4 }), issueContext, undefined, {
            findSubmission: async () => assert.fail('not read'),
            readOverride: async () => assert.fail('not read'),
        });
        assert.equal(resolved.override, 4);
    });

    test('a malformed submission payload is treated as setting no override', async () => {
        const resolved = await issueRunCostCapTarget(job(), issueContext, undefined, {
            findSubmission: async () => ({ payload: '{not json' }) as never,
            readOverride: async () => '6',
        });
        assert.equal(resolved.override, '6');
    });
});

test('the GitHub notice names the cap, the spend and where the cap came from', async () => {
    const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
    const octokit = { request: async <T>(endpoint: string, options: Record<string, unknown>) => { requests.push({ endpoint, options }); return {} as T; } };
    const snapshot = { cap: { capUsd: 5, source: 'workflow' }, spentUsd: 5.123 } as Pick<RunCostSnapshot, 'cap' | 'spentUsd'>;
    await postCostCapNotice({ repoOwner: 'acme', repoName: 'app', number: 7 }, octokit, snapshot, { warn: () => undefined });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.issue_number, 7);
    const body = String(requests[0].options.body);
    assert.match(body, /Spend cap reached/);
    assert.match(body, /\$5\.12, reaching its \$5\.00 spend cap \(from \.propr\/workflow\.yml\)/);
    assert.ok(body.split('\n').length <= 5, 'the notice stays short');
});
