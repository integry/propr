import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunSpecBuilder, agentRunNetwork } from '../../packages/core/src/agents/runtime/agentRunSpec.ts';
import { SpritesRuntime, type SpritesRuntimeDependencies } from '../../packages/core/src/agents/runtime/spritesRuntime.ts';
import type { SpritesSetupBundle } from '../../packages/core/src/agents/runtime/sprites/spritesSetup.ts';
import type { AgentRunSpec } from '../../packages/core/src/agents/runtime/types.ts';
import type { AgentType } from '../../packages/core/src/agents/types.ts';
import { FakeSpritesClient } from './fakeSprites.ts';

export const ORG_TOKEN = 'sprites-org-token-0123456789abcdef';

export const TEST_BUNDLE: SpritesSetupBundle = {
    files: ['sprites-agent-setup.sh', 'sprites-launcher.sh', 'claude-entrypoint.sh', 'codex-entrypoint.sh', 'antigravity-entrypoint.sh', 'gh-wrapper.sh']
        .map(name => ({ name, content: Buffer.from(`# ${name}\n`) })),
    pins: {
        CLAUDE_CLI_VERSION: '2.1.330', CODEX_CLI_VERSION: '0.171.0', ANTIGRAVITY_CLI_VERSION: '1.5.15',
        ANTIGRAVITY_CLI_RELEASE_ID: '5514532022517760', ANTIGRAVITY_CLI_SHA512: 'a'.repeat(128),
    },
    hash: 'setuphash0000001',
};

export interface Harness {
    client: FakeSpritesClient;
    runtime: SpritesRuntime;
    /** Worker-side directory holding the state directory, HOME and credential stores of this harness. */
    root: string;
    stateDir: string;
    /** A second runtime over the same Sprites and worker state, as a restarted worker process would be. */
    restart(): SpritesRuntime;
}

export function createHarness(options: { maxSprites?: number; bundle?: SpritesSetupBundle; root?: string; client?: FakeSpritesClient } & SpritesRuntimeDependencies = {}): Harness {
    const { maxSprites = 1, bundle = TEST_BUNDLE, root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-sprites-test-')), client = new FakeSpritesClient(), ...dependencies } = options;
    const stateDir = path.join(root, 'state');
    const create = (): SpritesRuntime => new SpritesRuntime({
        createClient: async () => client as never,
        config: () => ({ token: ORG_TOKEN, namePrefix: 'propr', workerId: 'w1', maxSprites, stateDir }),
        setupBundle: () => bundle,
        environment: { HOME: path.join(root, 'home') },
        reconnectDelayMs: 2, stopGraceMs: 20, lockPollMs: 5,
        ...dependencies,
    });
    return { client, runtime: create(), root, stateDir, restart: create };
}

const CREDENTIAL_TARGETS: Record<string, { target: string; file: string }> = {
    claude: { target: '/home/node/.claude', file: '.credentials.json' },
    codex: { target: '/home/node/.codex', file: 'auth.json' },
    antigravity: { target: '/home/node/.gemini-source', file: 'antigravity-cli/antigravity-oauth-token' },
};

/** A canonical credential store on the worker holding one token file. */
export function createCredentialStore(root: string, agent: 'claude' | 'codex' | 'antigravity', token = `${agent}-token-v1`): { directory: string; tokenFile: string } {
    const directory = fs.mkdtempSync(path.join(root, `${agent}-store-`));
    const tokenFile = path.join(directory, CREDENTIAL_TARGETS[agent].file);
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    return { directory, tokenFile };
}

/** The live path of the provider's refreshable token on the Sprite. */
export function liveTokenPath(agent: 'claude' | 'codex' | 'antigravity'): string {
    if (agent === 'antigravity') return '/var/lib/propr/run/antigravity-home/.gemini/antigravity-cli/antigravity-oauth-token';
    return `${CREDENTIAL_TARGETS[agent].target}/${CREDENTIAL_TARGETS[agent].file}`;
}

/** A clone-mode spec shaped like the provider builders' (root start, setup wrapper, credential bind, log bind). */
export function cloneSpec(name: string, options: { agent?: 'claude' | 'codex' | 'antigravity'; credentialStore?: string; customize?(builder: AgentRunSpecBuilder): void } = {}): AgentRunSpec {
    const agent = options.agent ?? 'claude';
    const builder = new AgentRunSpecBuilder({
        agentType: agent as AgentType, image: 'propr/agent:test', name, stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/unused-worktree', containerPath: '/home/node/workspace', readOnly: false },
    }).bind('/tmp/claude-logs', '/tmp/claude-logs', false, 'logs');
    if (options.credentialStore) {
        builder.credentialBind(options.credentialStore, CREDENTIAL_TARGETS[agent].target, false, { provider: agent as AgentType, store: 'config', perRun: true });
    }
    if (agent === 'antigravity') builder.env('PROPR_EPHEMERAL_STATE', '1').env('PROPR_ANTIGRAVITY_SOURCE_CONFIG', CREDENTIAL_TARGETS.antigravity.target);
    builder.tmpfs('/home/node/.cache-scratch', 'rw,size=16m')
        .env('GH_TOKEN', 'gh-token-value').env('PROPR_TEST_RUN', name)
        .env('PROPR_WORKSPACE_CLONE_RESULT_DIR', '/tmp/propr-workspace-result');
    options.customize?.(builder);
    const spec = builder.command(agent, '-p', '-').build();
    spec.repoSetup = { agentType: agent as AgentType, shell: '/bin/bash', script: 'SETUP_WRAPPER', providerEntrypoint: `/home/node/${agent}-entrypoint.sh`, env: [{ name: 'PROPR_AGENT_TYPE', value: agent }] };
    spec.workspace = {
        ...spec.workspace, mode: 'clone',
        clone: { remote: 'https://github.com/example/repo.git', baseRef: 'refs/propr/runs/r/base', baseCommit: 'a'.repeat(40), branch: 'task', resultRef: 'refs/propr/runs/r/result', resultDir: '/tmp/propr-workspace-result', script: 'CLONE_WRAPPER' },
    };
    return spec;
}
