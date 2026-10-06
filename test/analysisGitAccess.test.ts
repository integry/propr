import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AnalyzeOptions, AgentConfig, AgentTaskOptions } from '../packages/core/src/agents/types.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-analysis-access-'));
const previousAnalysisRoot = process.env.OPENCODE_ANALYSIS_ROOT;
process.env.OPENCODE_ANALYSIS_ROOT = root;
const previousToken = process.env.GITHUB_TOKEN;
const previousKey = process.env.MISTRAL_API_KEY;
process.env.GITHUB_TOKEN = 'worker-write-token';
process.env.MISTRAL_API_KEY = 'test-mistral-key';
const access = { githubToken: 'scoped-read-token', gitMountArgs: ['-v', `${root}/allowed:${root}/allowed:ro`] };
let prepareTask: (options: AgentTaskOptions) => Promise<AgentTaskOptions> = async () => { throw new Error('Unexpected task launch'); };
let prepare: (options: AnalyzeOptions | undefined, workspace: string) => Promise<typeof access>;
await mock.module('../packages/core/src/agents/agentGitAccess.js', {
    namedExports: {
        prepareAnalysisGitAccess: (options: AnalyzeOptions | undefined, workspace: string) => prepare(options, workspace),
        prepareAgentGitAccess: (options: AgentTaskOptions) => prepareTask(options),
        agentOwnsGit: () => false,
        buildAgentGitCredentialArgs: () => [],
        buildAgentGitMountArgs: () => { throw new Error('Analysis must use prepared mounts'); },
    },
});
let launches: Array<{ args: string[]; envFile: string; model?: string }> = [];
await mock.module('../packages/core/src/claude/worktreeOwnership.js', { namedExports: { setWorktreeOwnership: async () => {} } });
const dockerExecutor = await import('../packages/core/src/claude/docker/dockerExecutor.js');
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: { ...dockerExecutor,
        executeDockerCommand: async (_command: string, args: string[], options: { model?: string } = {}) => {
        const envFileIndex = args.indexOf('--env-file');
        launches.push({ args, envFile: envFileIndex < 0 ? '' : await fs.readFile(args[envFileIndex + 1], 'utf8'), model: options.model });
        throw new Error('Stop after capturing launch');
    } },
});
await mock.module('../packages/core/src/agents/impl/utils/usageTrackingWrapper.js', {
    namedExports: {
        executeWithUsageTracking: async (_agent: string, run: () => Promise<unknown>) => ({ result: await run(), usageMetrics: null }),
        extractMetricRecords: () => [], isAgentTankEnabled: () => false,
    },
});
const { ClaudeAgent } = await import('../packages/core/src/agents/impl/ClaudeAgent.js');
const { CodexAgent } = await import('../packages/core/src/agents/impl/CodexAgent.js');
const { AntigravityAgent } = await import('../packages/core/src/agents/impl/AntigravityAgent.js');
const { OpenCodeAgent } = await import('../packages/core/src/agents/impl/OpenCodeAgent.js');
const { VibeAgent } = await import('../packages/core/src/agents/impl/VibeAgent.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
after(async () => {
    await closeConnection();
    if (previousAnalysisRoot === undefined) delete process.env.OPENCODE_ANALYSIS_ROOT; else process.env.OPENCODE_ANALYSIS_ROOT = previousAnalysisRoot;
    await fs.rm(root, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
    if (previousKey === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = previousKey;
});

for (const [type, Adapter] of [['claude', ClaudeAgent], ['codex', CodexAgent], ['antigravity', AntigravityAgent], ['opencode', OpenCodeAgent], ['vibe', VibeAgent]] as const) {
    const model = type === 'antigravity' ? 'antigravity-gemini-3.8-flash' : 'test-model';
    test(`${type} analysis waits for scoped access and passes only the prepared credentials and mounts`, async () => {
        launches = [];
        const configPath = path.join(root, type);
        await fs.mkdir(configPath, { recursive: true });
        const config: AgentConfig = { id: type, type, alias: type, enabled: true, dockerImage: 'test-agent', configPath, supportedModels: [model], defaultModel: model };
        const agent = new Adapter(config);
        const options: AnalyzeOptions = { repository: 'owner/task', readOnlyWorkspacePath: root, suppressLlmLog: true };
        let release!: (value: typeof access) => void;
        let started!: () => void;
        const pending = new Promise<void>(resolve => { started = resolve; });
        prepare = async (received, workspace) => {
            assert.equal(received, options);
            assert.equal(workspace, root);
            started();
            return new Promise(resolve => { release = resolve; });
        };
        const result = agent.analyze('Analyze repository', options);
        await pending;
        assert.equal(launches.length, 0);
        release(access);
        await result;
        assert.equal(launches.length, 1);
        const { args, envFile } = launches[0];
        assert.ok(args.includes(access.gitMountArgs[1]));
        assert.match(args.join('\n') + envFile, /GH_TOKEN=scoped-read-token/);
        assert.doesNotMatch(args.join('\n') + envFile, /worker-write-token|\/tmp\/git-processor:\/tmp\/git-processor/);
        assert.equal(launches[0].model, model, 'the configured default model prices the spend cap of an analysis that names none');
        prepare = async () => { throw new Error('Scope unavailable'); };
        const failed = await agent.analyze('Analyze repository', options);
        assert.equal(failed.success, false);
        assert.equal(launches.length, 1, 'Failed preparation must not launch or fall back');
    });

    test(`${type} task launches each receive new prepared access and reject failed refreshes`, async () => {
        launches = [];
        const configPath = path.join(root, type);
        await fs.mkdir(configPath, { recursive: true });
        const config: AgentConfig = { id: type, type, alias: type, enabled: true, dockerImage: 'test-agent', configPath, supportedModels: [model], defaultModel: model };
        const agent = new Adapter(config);
        const task: AgentTaskOptions = { worktreePath: root, prompt: 'Implement', githubToken: 'worker-write-token', issueRef: { repoOwner: 'owner', repoName: 'task', number: 1 } };
        for (let attempt = 1; attempt <= 2; attempt++) {
            prepareTask = async received => {
                assert.equal(received, task);
                return { ...received, githubToken: `fresh-task-${attempt}`, gitMountArgs: access.gitMountArgs };
            };
            await agent.executeTask(task);
            assert.equal(launches.length, attempt);
            const { args, envFile } = launches[attempt - 1];
            assert.ok(args.includes(access.gitMountArgs[1]));
            assert.ok((args.join('\n') + envFile).includes(`GH_TOKEN=fresh-task-${attempt}`));
            assert.doesNotMatch(args.join('\n') + envFile, /worker-write-token/);
            assert.equal(launches[attempt - 1].model, model, 'a task without an explicit model registers the configured default for spend-cap pricing');
        }
        prepareTask = async () => { throw new Error('Scope unavailable'); };
        const failed = await agent.executeTask(task);
        assert.equal(failed.success, false);
        assert.match(failed.error!, /Scope unavailable/);
        assert.equal(launches.length, 2);
    });

}
