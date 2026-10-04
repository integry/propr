import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { AntigravityAgent } from '../packages/core/src/agents/impl/AntigravityAgent.js';
import { antigravityModelIdsMatch, toAntigravityCliModelId } from '../packages/core/src/agents/impl/antigravityModelIds.js';
import { getManagedAgentConfigPath } from '@propr/shared';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

process.env.NODE_ENV = 'test';

after(async () => {
    await closeConnection();
});

function createAgent(configPath: string): AntigravityAgent {
    const config: AgentConfig = {
        id: 'antigravity-test',
        type: 'antigravity',
        alias: 'antigravity',
        enabled: true,
        dockerImage: 'propr/agent:latest',
        configPath,
        supportedModels: ['antigravity-gemini-3.8-flash'],
        defaultModel: 'antigravity-gemini-3.8-flash'
    };
    return new AntigravityAgent(config);
}

describe('AntigravityAgent Docker args', () => {
    test('legacy paths and environment overrides fall back to sibling credentials while managed paths win', () => {
        const previous = process.env.ANTIGRAVITY_CONFIG_PATH;
        const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-legacy-'));
        const legacy = path.join(tempHome, '.antigravity');
        const sibling = path.join(tempHome, '.gemini');
        const hostPath = (configPath: string) => (createAgent(configPath) as unknown as { getHostConfigPath(): string }).getHostConfigPath();
        try {
            delete process.env.ANTIGRAVITY_CONFIG_PATH;
            assert.equal(hostPath(legacy), legacy);
            fs.mkdirSync(sibling);
            assert.equal(hostPath(legacy), sibling);
            process.env.ANTIGRAVITY_CONFIG_PATH = legacy;
            assert.equal(hostPath('/srv/stored'), sibling);
            const managed = getManagedAgentConfigPath('antigravity-test', 'antigravity');
            assert.equal(hostPath(managed), path.join(os.homedir(), managed.replace(/^~\//, '')));
            process.env.ANTIGRAVITY_CONFIG_PATH = '/srv/override';
            assert.equal(hostPath(legacy), '/srv/override');
        } finally {
            if (previous === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
            else process.env.ANTIGRAVITY_CONFIG_PATH = previous;
            fs.rmSync(tempHome, { recursive: true, force: true });
        }
    });

    test('mounts the configured Gemini credentials directory', () => {
        const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-home-'));
        const geminiPath = path.join(tempHome, '.gemini');
        fs.mkdirSync(geminiPath, { recursive: true });

        try {
            const agent = createAgent(geminiPath);
            const args = (agent as unknown as {
                buildDockerArgs(params: {
                    worktreePath: string;
                    githubToken: string;
                    modelName?: string;
                    issueNumber: number;
                }): string[];
            }).buildDockerArgs({
                worktreePath: '/tmp/worktree',
                githubToken: '',
                modelName: 'antigravity-gemini-3.8-flash',
                issueNumber: 42
            });

            assert.ok(args.includes(`${geminiPath}:/home/node/.gemini-source:rw`));
            assert.ok(args.includes('PROPR_EPHEMERAL_STATE=1'));
            assert.ok(args.includes('PROPR_ANTIGRAVITY_SOURCE_CONFIG=/home/node/.gemini-source'));
        } finally {
            fs.rmSync(tempHome, { recursive: true, force: true });
        }
    });

    test('lets agy auto-read non-TTY stdin and passes the exact Gemini 3.8 external ID', () => {
        const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-model-agy-'));
        fs.mkdirSync(path.join(tempHome, '.gemini'), { recursive: true });

        try {
            const agent = createAgent(path.join(tempHome, '.gemini'));
            const args = (agent as unknown as {
                buildDockerArgs(params: {
                    worktreePath: string;
                    githubToken: string;
                    modelName?: string;
                    issueNumber: number;
                    printTimeoutMs?: number;
                    reasoningLevel?: 'high';
                }): string[];
            }).buildDockerArgs({
                worktreePath: '/tmp/worktree',
                githubToken: '',
                modelName: 'antigravity-gemini-3.8-flash',
                reasoningLevel: 'high',
                issueNumber: 0,
                printTimeoutMs: 1_800_000
            });

            // Omitting a prompt flag makes agy read non-TTY stdin. `--print -`
            // would send a literal dash, while an argv prompt can hit E2BIG.
            // A generated container name can also contain 'agy'; match the command.
            const shellCmd = args.find(a => /(?:^|\n)exec agy\s/.test(a));
            assert.ok(shellCmd, 'shell command should invoke agy');
            assert.doesNotMatch(shellCmd, /--print|\s-p(?:\s|$)/, 'shell command must leave the prompt unset so agy reads stdin');
            assert.match(shellCmd, /--dangerously-skip-permissions "\$@"/);
            assert.strictEqual(args[args.indexOf('--print-timeout') + 1], '1800s');

            // Model must be the canonical external ID, never the namespaced id.
            const modelIdx = args.indexOf('--model');
            assert.ok(modelIdx >= 0, '--model flag should be present');
            assert.strictEqual(args[modelIdx + 1], 'gemini-3.8-flash-high');
            assert.ok(!args.includes('antigravity-gemini-3.8-flash'), 'prefixed id must not be passed to the CLI');
        } finally {
            fs.rmSync(tempHome, { recursive: true, force: true });
        }
    });

    test('entrypoint copies only durable auth into disposable runtime state and exports the transcript', () => {
        const script = fs.readFileSync(path.join(process.cwd(), 'scripts/antigravity-entrypoint.sh'), 'utf8');

        assert.match(script, /antigravity-oauth-token/);
        assert.match(script, /Using disposable Antigravity runtime state/);
        assert.match(script, /PROPR_ANTIGRAVITY_TRANSCRIPT_PATH/);
        assert.match(script, /transcript\.jsonl/);
    });

    test('entrypoint makes runtime directories writable after creating them', () => {
        const script = fs.readFileSync(path.join(process.cwd(), 'scripts/antigravity-entrypoint.sh'), 'utf8');
        const prepareFunction = script.slice(
            script.indexOf('prepare_antigravity_config_dir()'),
            script.indexOf('prepare_antigravity_config_dir "$antigravity_config_dir"')
        );

        const createDirectoriesAt = prepareFunction.indexOf('for dir in tmp antigravity-cli/log antigravity-cli/cache config/projects');
        const fixOwnershipAt = prepareFunction.indexOf('chown -R node:node "$config_dir"');
        assert.ok(createDirectoriesAt >= 0, 'runtime directory creation should be present');
        assert.ok(fixOwnershipAt > createDirectoriesAt, 'ownership must be fixed after root creates runtime directories');
    });
});

describe('toAntigravityCliModelId', () => {
    test('passes through custom IDs and accepts only their exact converted provider identity', () => {
        for (const id of ['antigravity-custom-preview-model', 'antigravity:antigravity-custom-preview-model', 'custom-preview-model']) {
            assert.equal(toAntigravityCliModelId(id, 'high'), 'custom-preview-model');
            assert.equal(antigravityModelIdsMatch(id, 'custom-preview-model'), true);
            assert.equal(antigravityModelIdsMatch(id, 'custom-preview-model-high'), false);
            assert.equal(antigravityModelIdsMatch(id, 'other-preview-model'), false);
        }
    });

    test('converts base models and separate efforts to exact CLI arguments', () => {
        for (const effort of ['low', 'medium', 'high'] as const) {
            assert.equal(toAntigravityCliModelId('antigravity-gemini-3.8-flash', effort), `gemini-3.8-flash-${effort}`);
        }
        for (const [id, name] of [
            ['antigravity-claude-opus-5.5', 'Claude Opus 5.5'],
            ['antigravity-claude-sonnet-5.5', 'Claude Sonnet 5.5'],
        ]) {
            for (const effort of ['low', 'medium', 'high'] as const) {
                const expected = `${name} (${effort[0].toUpperCase()}${effort.slice(1)})`;
                assert.equal(toAntigravityCliModelId(id, effort), expected);
                assert.equal(toAntigravityCliModelId(`antigravity:${id}`, effort), expected);
            }
        }
    });

    test('selects the closest supported effort going down for Pro and GPT-OSS', () => {
        assert.equal(toAntigravityCliModelId('antigravity-gemini-3.1-pro', 'low'), 'Gemini 3.1 Pro (Low)');
        assert.equal(toAntigravityCliModelId('antigravity-gemini-3.1-pro', 'medium'), 'Gemini 3.1 Pro (Low)');
        assert.equal(toAntigravityCliModelId('antigravity-gpt-oss-120b', 'high'), 'GPT-OSS 120B (Medium)');
        assert.equal(toAntigravityCliModelId('antigravity-gemini-3.8-flash'), 'gemini-3.8-flash-medium');
        for (const effort of [undefined, '', 'auto'] as const) {
            assert.equal(toAntigravityCliModelId('antigravity-gemini-3.1-pro', effort), 'Gemini 3.1 Pro (Low)');
        }
        for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode', 'auto', '', undefined] as const) {
            assert.equal(toAntigravityCliModelId('antigravity-gpt-oss-120b', effort), 'GPT-OSS 120B (Medium)');
        }
    });

    test('lowers unsupported higher efforts to high across Antigravity model families', () => {
        for (const [id, expected] of [
            ['antigravity-claude-opus-5.5', 'Claude Opus 5.5 (High)'],
            ['antigravity-claude-sonnet-5.5', 'Claude Sonnet 5.5 (High)'],
            ['antigravity-gemini-3.8-flash', 'gemini-3.8-flash-high'],
            ['antigravity-gemini-3.1-pro', 'Gemini 3.1 Pro (High)'],
        ]) {
            for (const effort of ['high', 'xhigh', 'max', 'ultra', 'ultracode'] as const) {
                assert.equal(toAntigravityCliModelId(id, effort), expected);
                assert.equal(toAntigravityCliModelId(`antigravity:${id}`, effort), expected);
            }
        }
    });
});

describe('AntigravityAgent token estimation', () => {
    type Estimate = { input_tokens?: number; output_tokens?: number } | undefined;
    interface TokenAgent {
        resolveTokenUsage(
            reported: { input_tokens?: number; output_tokens?: number },
            prompt: string,
            summary: string | undefined,
            conversationLog: unknown[]
        ): Estimate;
    }
    const agent = createAgent('/tmp/nonexistent') as unknown as TokenAgent;

    test('reported counts always win', () => {
        const usage = agent.resolveTokenUsage({ input_tokens: 1000, output_tokens: 200 }, 'p', 's', []);
        assert.deepStrictEqual(usage, { input_tokens: 1000, output_tokens: 200 });
    });

    test('estimates from the full transcript (file views/searches as input, planner/code as output)', () => {
        const events = [
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'x'.repeat(400) },   // input
            { source: 'MODEL', type: 'VIEW_FILE', content: 'y'.repeat(8000) },           // input (bulk)
            { source: 'MODEL', type: 'GREP_SEARCH', content: 'z'.repeat(4000) },         // input
            { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'a'.repeat(800) },     // output
            { source: 'MODEL', type: 'CODE_ACTION', content: 'b'.repeat(1200) },         // output
        ];
        const usage = agent.resolveTokenUsage({}, 'prompt', 'summary', events)!;
        assert.ok(usage, 'should produce an estimate');
        // Input dominates (file view + grep ~12.4K chars) and far exceeds the old
        // prompt-only estimate; output reflects planner + code (~2K chars).
        assert.ok(usage.input_tokens! > 2000, `input should reflect file context, got ${usage.input_tokens}`);
        assert.ok(usage.output_tokens! > 300, `output should reflect planner+code, got ${usage.output_tokens}`);
        assert.ok(usage.input_tokens! > usage.output_tokens!, 'agentic runs are input-heavy');
    });

    test('falls back to prompt + summary when no transcript content (plain-text output)', () => {
        const usage = agent.resolveTokenUsage({}, 'p'.repeat(4000), 's'.repeat(800), [])!;
        assert.ok(usage.input_tokens! > usage.output_tokens!, 'prompt is input, summary is output');
        assert.ok(usage.output_tokens! > 0);
    });
});

test('Antigravity maps model reasoning choices to supported CLI efforts', () => {
    const flash = 'antigravity-gemini-3.8-flash';
    assert.equal(toAntigravityCliModelId(flash, 'low'), 'gemini-3.8-flash-low');
    assert.equal(toAntigravityCliModelId(flash, 'medium'), 'gemini-3.8-flash-medium');
    for (const level of ['high', 'xhigh', 'max', 'ultra', 'ultracode'] as const) {
        assert.equal(toAntigravityCliModelId(flash, level), 'gemini-3.8-flash-high');
    }
    assert.equal(toAntigravityCliModelId(flash, ''), 'gemini-3.8-flash-medium');
    assert.equal(toAntigravityCliModelId('antigravity-gemini-3.1-pro', 'medium'), 'Gemini 3.1 Pro (Low)');
    assert.equal(toAntigravityCliModelId('antigravity-gpt-oss-120b', 'low'), 'GPT-OSS 120B (Medium)');
    assert.equal(toAntigravityCliModelId('antigravity:antigravity-claude-opus-5.5', 'high'), 'Claude Opus 5.5 (High)');
});

test('Antigravity reasoning resolves task choices before model overrides', async () => {
    const model = 'antigravity-gemini-3.8-flash';
    const agent = new AntigravityAgent({
        id: 'reasoning-test', type: 'antigravity', alias: 'antigravity', enabled: true,
        dockerImage: 'propr/agent:latest', configPath: '~/.gemini', supportedModels: [model],
        modelReasoningLevels: { [model]: 'low' }
    });
    const resolver = agent as unknown as { resolveReasoningLevel(level: 'high' | undefined, model: string): Promise<string> };
    assert.equal(await resolver.resolveReasoningLevel('high', model), 'high');
    assert.equal(await resolver.resolveReasoningLevel(undefined, `antigravity:${model}`), 'low');
});
