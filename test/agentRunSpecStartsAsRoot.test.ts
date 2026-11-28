import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { AGENT_TYPES } from '../packages/core/src/agents/constants.ts';
import { buildClaudeRunSpec } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { buildCodexRunSpec } from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts';
import { buildOpenCodeRunSpec } from '../packages/core/src/agents/impl/openCodeUtils.ts';
import { AntigravityAgent } from '../packages/core/src/agents/impl/AntigravityAgent.ts';
import { VibeAgent } from '../packages/core/src/agents/impl/VibeAgent.ts';
import { assembleVibeRunSpec } from '../packages/core/src/agents/impl/utils/vibeRunSpec.ts';
import { buildClaudeServiceRunSpec } from '../packages/core/src/claude/claudeServiceRunSpec.ts';
import { applyAgentRunLaunchWrapper } from '../packages/core/src/claude/docker/repoSetupWrapper.ts';
import { CloneWorkspaceTransport, defaultCloneWorkspaceTransportDependencies } from '../packages/core/src/git/workspaceCloneTransport.ts';
import { cloneRunStartsAsRoot } from '../packages/core/src/git/workspaceTransportScript.ts';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { SpritesRuntime } from '../packages/core/src/agents/runtime/spritesRuntime.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import type { MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
import type { AgentRunSpec } from '../packages/core/src/agents/runtime/types.ts';
import type { AgentConfig, AgentType } from '../packages/core/src/agents/types.ts';
import { closeConnection } from '../packages/core/src/db/connection.ts';
import { FakeSprites } from './helpers/fakeSprites.ts';

// Fly Machines and Sprites refused a Vibe run in the clone workspace transport because its
// spec, unlike every other agent's, did not start as root (#3853). Docker's bind transport
// never checked, so the local tests passed. Every agent type's task spec is checked here.

let root: string;
const savedEnvironment = { ...process.env };

before(() => {
    root = mkdtempSync(join(tmpdir(), 'propr-starts-as-root-'));
    for (const type of AGENT_TYPES) mkdirSync(join(root, `${type}-config`));
    writeFileSync(join(root, 'vibe-config', 'config.toml'), 'active_model = "m"');
    process.env.CLAUDE_JSON_PATH = join(root, 'claude.json');
    writeFileSync(process.env.CLAUDE_JSON_PATH, '{}');
});

after(async () => {
    process.env = savedEnvironment;
    rmSync(root, { recursive: true, force: true });
    await closeConnection();
});

const config = (type: AgentType): AgentConfig => ({
    id: `${type}-id`, type, alias: `${type}-root`, enabled: true, dockerImage: 'propr/agent',
    configPath: join(root, `${type}-config`), supportedModels: [type === 'antigravity' ? 'antigravity-gemini-3.8-flash' : 'model'],
} as AgentConfig);

const base = { worktreePath: '/tmp/starts-as-root-worktree', githubToken: 'gh-token', issueNumber: 7, taskId: 'repo-7-task-abcdef12' };

/** The task (execute) spec each agent type builds; keyed by AgentType so a new agent fails to typecheck and to run here. */
const taskSpecs: Record<AgentType, () => AgentRunSpec[]> = {
    claude: () => [buildClaudeRunSpec(config('claude'), 30, base), buildClaudeServiceRunSpec({
        ...base, prompt: 'p', CLAUDE_DOCKER_IMAGE: 'propr/agent', CLAUDE_CONFIG_PATH: join(root, 'claude-config'), CLAUDE_MAX_TURNS: 5, agentAlias: 'claude',
    } as Parameters<typeof buildClaudeServiceRunSpec>[0])],
    codex: () => [buildCodexRunSpec(config('codex'), base)],
    opencode: () => [buildOpenCodeRunSpec({ ...base, config: config('opencode'), ensureConfigPath: () => {} } as Parameters<typeof buildOpenCodeRunSpec>[0])],
    antigravity: () => [(new AntigravityAgent(config('antigravity')) as unknown as { buildRunSpec(input: unknown): AgentRunSpec }).buildRunSpec(base)],
    vibe: () => [(new VibeAgent(config('vibe')) as unknown as { buildRunSpec(input: unknown): AgentRunSpec }).buildRunSpec({
        ...base, mistralApiKey: 'mistral-key', promptFilePath: join(root, 'prompt.txt'), runtimeHomePath: join(root, 'vibe-home'),
    })],
};

test('every agent type has a task spec case', () => {
    assert.deepEqual(Object.keys(taskSpecs).sort(), [...AGENT_TYPES].sort());
});

for (const type of AGENT_TYPES) {
    test(`${type}: the task spec starts as root and passes the clone workspace transport's root gate`, async () => {
        for (const spec of taskSpecs[type]()) {
            assert.ok(cloneRunStartsAsRoot(spec.user), `${spec.name} starts as ${spec.user ?? 'the image user'}`);
            assert.ok(spec.security.capAdd.includes('CHOWN'), `${spec.name} cannot hand stores to the agent user`);
            // The transport's own refusal comes before any git or token work; a worktree that is
            // not a repository proves the spec got past it (the root gate would have thrown first).
            const transport = new CloneWorkspaceTransport({ ...defaultCloneWorkspaceTransportDependencies, mintToken: () => assert.fail('no token is minted') });
            await assert.rejects(transport.prepare({ ...spec, workspace: { ...spec.workspace, hostPath: root } }), (error: Error) => {
                assert.doesNotMatch(error.message, /start as root/);
                assert.match(error.message, /needs a git worktree/);
                return true;
            });
        }
    });
}

test('Vibe: the task spec runs on Fly Machines and Sprites, which only offer the clone transport', () => {
    const [spec] = taskSpecs.vibe();
    const fly = new FlyMachinesRuntime({} as MachinesApi, { PROPR_FLY_APP: 'agents', PROPR_FLY_API_TOKEN: 'FlyV1 synthetic', PROPR_FLY_IMAGE: 'registry.fly.io/agents@sha256:test' }, async () => []);
    const sprites = new SpritesRuntime(new FakeSprites(), { PROPR_SPRITES_TOKEN: 'test-org-secret' }, undefined, async () => []);
    for (const runtime of [fly, sprites]) {
        assert.deepEqual(runtime.capabilities.workspaceTransports, ['clone']);
        assert.equal(runtime.unsupportedAgentConfig({ type: 'vibe' }, spec), undefined);
    }
    assert.equal(spec.user, '0:0');
    assert.ok(spec.repoSetup, 'the task spec carries the setup wrapper that drops the hook to node');
});

test('Vibe analysis keeps the image user in its capability-free, read-only sandbox', () => {
    const spec = assembleVibeRunSpec({
        config: config('vibe'), name: 'vibe-analysis', mode: 'analysis', worktreePath: root, repositoryInspection: false, gitMountArgs: [],
        configMountArgs: [], promptMountArgs: [], runtimeHomeMountArgs: [], envVars: [], cliArgs: ['--prompt-file', '/p'],
    });
    assert.equal(spec.user, undefined);
    assert.deepEqual(spec.security.capAdd, []);
    assert.deepEqual(spec.security.capDrop, ['ALL']);
    assert.equal(spec.workspace.readOnly, true, 'analysis stays on the read-only bind transport');
});

test('the setup wrapper refuses a provider spec that does not start as root, so local Docker catches it too', () => {
    const build = (user?: string) => new AgentRunSpecBuilder({
        agentType: 'vibe', image: 'propr/agent', name: 'no-user', stdin: false, network: agentRunNetwork('bridge'), ...(user ? { user } : {}),
        workspace: { hostPath: root, containerPath: '/home/node/workspace', readOnly: false },
    }).command('vibe').build();
    assert.throws(() => applyAgentRunLaunchWrapper(build(), 'vibe'), /no-user \(vibe\).*starts as the image user/);
    assert.throws(() => applyAgentRunLaunchWrapper(build('1000:1000'), 'vibe'), /starts as "1000:1000"/);
    assert.equal(applyAgentRunLaunchWrapper(build('0:0'), 'vibe').repoSetup?.providerEntrypoint, '/home/node/vibe-entrypoint.sh');
});
