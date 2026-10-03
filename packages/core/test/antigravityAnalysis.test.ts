import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import type { AgentConfig } from '../src/agents/types.js';
import { db } from '../src/db/connection.js';

const configManager = await import('../src/config/configManagerReasoning.js');
const dockerExecutor = await import('../src/claude/docker/dockerExecutor.js');
let globalLoads = 0;
let launchedArgs: string[] = [];
let reportedModel = 'gemini-3.8-flash-medium';
await mock.module('../src/config/configManagerReasoning.js', { namedExports: {
    ...configManager,
    loadModelReasoningLevel: async () => { globalLoads++; return 'high'; },
} });
await mock.module('../src/claude/docker/dockerExecutor.js', { namedExports: {
    ...dockerExecutor,
    executeDockerCommand: async (_command: string, args: string[]) => {
        launchedArgs = args;
        return {
            stdout: [
                JSON.stringify({ event: 'init', conversation_id: 'analysis', init: { model: reportedModel, cwd: '/tmp', tools: [] } }),
                JSON.stringify({ event: 'result', result: { conversation_id: 'analysis', status: 'SUCCESS', response: 'analysis' } }),
            ].join('\n'), stderr: '', exitCode: 0,
        };
    },
} });
const { AntigravityAgent } = await import('../src/agents/impl/AntigravityAgent.js');
after(async () => { mock.restoreAll(); await db.destroy(); });

const model = 'antigravity-gemini-3.8-flash';
function agent(modelReasoningLevels?: AgentConfig['modelReasoningLevels']) {
    return new AntigravityAgent({ id: 'analysis', alias: 'antigravity', type: 'antigravity', enabled: true,
        configPath: '~/.gemini', dockerImage: 'propr/agent:latest', supportedModels: [model], modelReasoningLevels });
}

test('analysis ignores global and model reasoning unless inheritance is enabled', async () => {
    for (const overrides of [undefined, { [model]: 'high' } as const]) {
        for (const inherit of [undefined, false, true]) {
            globalLoads = 0;
            reportedModel = `gemini-3.8-flash-${inherit ? 'high' : 'medium'}`;
            const result = await agent(overrides).analyze('test', { model, useConfiguredReasoningLevel: inherit, suppressLlmLog: true });
            assert.equal(result.success, true);
            assert.equal(globalLoads, inherit && !overrides ? 1 : 0);
        }
    }
});

test('analysis detects a reported effort mismatch and preserves explicit overrides', async () => {
    for (const inherit of [undefined, false, true]) {
        globalLoads = 0;
        reportedModel = 'gemini-3.8-flash-low';
        const result = await agent({ [model]: 'low' }).analyze('test', {
            model, reasoningLevel: 'high', useConfiguredReasoningLevel: inherit, suppressLlmLog: true,
        });
        assert.equal(result.success, false);
        assert.match(result.error!, /requested CLI model "gemini-3.8-flash-high"/);
        assert.equal(globalLoads, 0);
    }
});

test('analysis launches configured custom models and requires their exact provider identity', async () => {
    const custom = 'antigravity-custom-preview-model';
    const customAgent = new AntigravityAgent({ id: 'custom', alias: 'custom', type: 'antigravity', enabled: true,
        configPath: '~/.gemini', dockerImage: 'propr/agent:latest', supportedModels: [custom], defaultModel: custom });
    for (const identity of ['custom-preview-model', 'another-custom-model']) {
        reportedModel = identity;
        const result = await customAgent.analyze('test', { model: custom, suppressLlmLog: true });
        assert.equal(launchedArgs[launchedArgs.indexOf('--model') + 1], 'custom-preview-model');
        assert.equal(result.success, identity === 'custom-preview-model');
    }
});


test('analysis executes retained Flash defaults with their saved effort', async () => {
    for (const version of ['3.6', '3.7']) {
        for (const effort of ['low', 'medium', 'high']) {
            const saved = `antigravity-gemini-${version}-flash-${effort}`;
            const display = `Gemini ${version} Flash (${effort[0].toUpperCase()}${effort.slice(1)})`;
            const retained = new AntigravityAgent({ id: 'retained', alias: 'antigravity', type: 'antigravity', enabled: true,
                configPath: '~/.gemini', dockerImage: 'propr/agent:latest', supportedModels: [saved], defaultModel: saved });
            for (const identity of [display, `Gemini ${version} Flash (${effort === 'low' ? 'High' : 'Low'})`]) {
                reportedModel = identity;
                const result = await retained.analyze('test', { model: saved, suppressLlmLog: true });
                assert.equal(launchedArgs[launchedArgs.indexOf('--model') + 1], version === '3.6' ? display : `gemini-${version}-flash-${effort}`);
                assert.equal(result.success, identity === display);
            }
        }
    }
});
