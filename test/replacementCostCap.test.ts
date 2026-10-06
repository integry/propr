import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { processDockerResult } from '../packages/core/src/agents/impl/utils/dockerResultProcessor.ts';
import { ClaudeAgent } from '../packages/core/src/agents/impl/ClaudeAgent.ts';
import type { AgentConfig } from '../packages/core/src/agents/types.ts';
import { resolveAgentTerminationReason } from '../packages/core/src/agents/termination.ts';
import { costCapExecutionOptions } from '../src/jobs/issueJob/costCap.ts';
import { taskTerminalReasonForAgentTermination } from '../src/jobs/agentTerminalReason.ts';

after(async () => {
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
});

const config = (type: AgentConfig['type']): AgentConfig => ({
    id: `${type}-id`, type, alias: `${type}-test`, enabled: true, dockerImage: 'propr/agent:test',
    configPath: `/tmp/${type}-config`, supportedModels: ['test-model'], defaultModel: 'test-model',
});

const common = { worktreePath: '/tmp/worktree', githubToken: 'token', modelName: 'test-model', issueNumber: 2739, taskId: 'replacement-1' };

test('a replacement\'s remaining budget reaches the Claude run as its spend limit', () => {
    // The queue payload of a replacement whose lineage already spent $2 of a $5 cap.
    const replacementJob = { costCapUsd: 3 };
    const options = costCapExecutionOptions(new ClaudeAgent(config('claude')), replacementJob);
    assert.deepEqual(options, { costCapUsd: 3 });

    const args = buildDockerArgs(config('claude'), 100, { ...common, maxBudgetUsd: options.costCapUsd });
    assert.deepEqual(args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd') + 2), ['--max-budget-usd', '3']);
    assert.equal(buildDockerArgs(config('claude'), 100, common).includes('--max-budget-usd'), false, 'uncapped runs are unlimited');
});

test('a capped run never starts unenforced', () => {
    assert.deepEqual(costCapExecutionOptions({ config: config('codex') }, {}), {}, 'uncapped runs need no enforcement');
    assert.throws(() => costCapExecutionOptions({ config: config('codex') }, { costCapUsd: 3 }), /cannot enforce the 3 USD cost cap/);
    assert.throws(() => costCapExecutionOptions({ config: config('claude'), enforcesCostCap: true }, { costCapUsd: 0 }), /no budget remains/);
    assert.throws(() => costCapExecutionOptions({ config: config('claude'), enforcesCostCap: true }, { costCapUsd: Number.NaN }), /no budget remains/);
});

test('a run stopped at its cost cap ends with the cost_cap_exceeded terminal reason', () => {
    const stdout = [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Implemented the parser.' }] } }),
        JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 3.02 }),
    ].join('\n');
    const { response } = processDockerResult({ stdout, stderr: '', exitCode: 1, messageTimestamps: new Map() }, 'prompt', 'test-model', 1_000);
    assert.equal(response.success, false);
    assert.equal(response.terminationReason, 'cost_cap');
    assert.equal(resolveAgentTerminationReason({ subtype: 'error_max_budget_usd' }), 'cost_cap');
    // Recorded on the task, so the stop is excluded from automatic replacement (`cost_cap_stop`).
    assert.equal(taskTerminalReasonForAgentTermination('cost_cap'), 'cost_cap_exceeded');
});
