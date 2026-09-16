import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { MuseAgent, buildMuseDockerArgs, parseMuseJsonl } from '../src/agents/impl/MuseAgent.js';
import { cleanupMuseAnalysisWorkspace, ensureMuseAnalysisWorkspace } from '../src/agents/impl/museUtils.js';
import { createAgentFromConfig } from '../src/agents/createAgentFromConfig.js';
import { db } from '../src/db/connection.js';
import type { AgentConfig } from '../src/agents/types.js';

after(async () => {
    await db.destroy();
});

const config: AgentConfig = {
    id: 'muse-test',
    type: 'muse',
    alias: 'muse-test',
    enabled: true,
    dockerImage: 'propr/agent:test',
    configPath: '/tmp/muse-test-config',
    supportedModels: ['muse-spark-1.3'],
    defaultModel: 'muse-spark-1.3',
};

test('Muse JSONL parser extracts the terminal response, model, and session', () => {
    const output = [
        JSON.stringify({ stream: { kind: 'session', id: 'session-1' }, payload_type: 'runtime.command.accepted', payload: {} }),
        JSON.stringify({ payload_type: 'run.model.configured', payload: { model_id: 'muse-spark-1.3' } }),
        JSON.stringify({ payload_type: 'run.terminal.completed', payload: { terminal: 'completed', text: 'Reviewed successfully', reason: null } }),
    ].join('\n');

    const parsed = parseMuseJsonl(output, 'Review this change');
    assert.equal(parsed.completed, true);
    assert.equal(parsed.text, 'Reviewed successfully');
    assert.equal(parsed.model, 'muse-spark-1.3');
    assert.equal(parsed.sessionId, 'session-1');
    assert.equal(parsed.conversationLog.length, 2);
});

test('Muse JSONL parser treats a failed terminal event as failure', () => {
    const output = JSON.stringify({
        payload_type: 'run.terminal.failed',
        payload: { terminal: 'failed', reason: 'authentication required' },
    });
    const parsed = parseMuseJsonl(output);
    assert.equal(parsed.completed, false);
    assert.equal(parsed.error, 'authentication required');
});

test('Muse Docker args mount credentials and pass prompts over stdin wrapper', () => {
    const args = buildMuseDockerArgs(config, {
        worktreePath: '/tmp/muse-test-workspace',
        githubToken: 'token-value',
        modelName: 'muse-spark-1.3',
        issueNumber: 12,
        maxModelSteps: 50,
        reasoningLevel: 'high',
    });

    assert.ok(args.includes('/tmp/muse-test-config:/home/node/.config/muse:rw'));
    assert.ok(args.includes('muse-run'));
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('muse-spark-1.3'));
    assert.ok(!args.includes('Review this change'));
});

test('Muse analysis workspace is readable by the node runtime user', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-analysis-root-'));
    const previousRoot = process.env.MUSE_ANALYSIS_ROOT;
    process.env.MUSE_ANALYSIS_ROOT = root;
    try {
        const workspace = ensureMuseAnalysisWorkspace();
        try {
            assert.equal(fs.statSync(workspace).mode & 0o777, 0o755);
        } finally {
            cleanupMuseAnalysisWorkspace(workspace);
        }
    } finally {
        if (previousRoot === undefined) delete process.env.MUSE_ANALYSIS_ROOT;
        else process.env.MUSE_ANALYSIS_ROOT = previousRoot;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('agent factory constructs Muse with goal mode disabled', () => {
    const agent = createAgentFromConfig(config);
    assert.equal(agent.config.type, 'muse');
    assert.equal(agent.goalCapable, false);
});

test('Muse omits reasoning levels its CLI does not support', async () => {
    const agent = new MuseAgent(config) as unknown as {
        resolveEffectiveReasoningLevel(
            reasoningLevel: 'none' | 'high' | 'auto' | 'ultracode' | 'ultra' | undefined,
            model: string,
            useConfiguredReasoningLevel?: boolean
        ): Promise<string>;
    };

    assert.equal(await agent.resolveEffectiveReasoningLevel('none', 'muse-spark-1.3'), '');
    assert.equal(await agent.resolveEffectiveReasoningLevel('high', 'muse-spark-1.3'), 'high');
    assert.equal(await agent.resolveEffectiveReasoningLevel('auto', 'muse-spark-1.3'), '');
    assert.equal(await agent.resolveEffectiveReasoningLevel('ultracode', 'muse-spark-1.3'), '');
    assert.equal(await agent.resolveEffectiveReasoningLevel('ultra', 'muse-spark-1.3'), '');
    assert.equal(await agent.resolveEffectiveReasoningLevel(undefined, 'muse-spark-1.3', false), '');
});
