import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_LOGIN_DESCRIPTORS, getManagedAgentConfigPath, isAgentLoginSupported, type AgentType } from '@propr/shared';
import {
    DEFAULT_CONFIG_PATHS,
    DEFAULT_CONFIG_PATH_MAPPINGS,
    resolveConfigPath,
    resolveDefaultConfigPath,
} from '../packages/core/src/config/agentConfigPaths.ts';
import { buildDockerArgs as buildClaudeDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { buildOpenCodeDockerArgs } from '../packages/core/src/agents/impl/openCodeUtils.ts';
import type { AgentConfig } from '../packages/core/src/agents/types.ts';
import { buildAgentLoginCreateArgs, resolveAgentLoginConfigPath } from '../packages/api/services/agentLoginDocker.ts';
import { closeConnection } from '../packages/core/src/db/connection.ts';

after(async () => {
    await closeConnection();
});

const HOST = '/home/desktop-user';
const PROVIDERS = Object.keys(DEFAULT_CONFIG_PATHS) as AgentType[];
const HOST_DIRS: Record<AgentType, string> = {
    claude: `${HOST}/.claude`,
    codex: `${HOST}/.codex`,
    antigravity: `${HOST}/.gemini`,
    opencode: `${HOST}/.config/opencode`,
    vibe: `${HOST}/.vibe`,
};
const ENV_KEYS = [
    'HOME', 'PROPR_CONTAINERIZED', 'PROPR_MANAGED_CREDENTIALS_DIR', 'HOST_OPENCODE_DATA_DIR',
    ...Object.values(DEFAULT_CONFIG_PATH_MAPPINGS).flat(),
];

/** Run with exactly the given deployment environment (all mappings cleared first). */
function withEnv(env: Record<string, string>, run: () => void): void {
    const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    try {
        for (const key of ENV_KEYS) delete process.env[key];
        Object.assign(process.env, env);
        run();
    } finally {
        for (const key of ENV_KEYS) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    }
}

function agent(type: AgentType, overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
        id: `${type}-1`, type, alias: type, enabled: true, dockerImage: 'propr/agent:test',
        configPath: DEFAULT_CONFIG_PATHS[type], supportedModels: [], ...overrides,
    };
}

function mountSources(args: string[], target: string): string[] {
    return args.filter((arg, index) => args[index - 1] === '-v' && arg.split(':')[1] === target)
        .map(arg => arg.split(':')[0]);
}

const containerized = { HOME: '/root', PROPR_CONTAINERIZED: '1' };

describe('provider default credential paths', () => {
    for (const type of PROVIDERS) {
        const [configVariable, hostVariable] = DEFAULT_CONFIG_PATH_MAPPINGS[type];
        const defaultPath = DEFAULT_CONFIG_PATHS[type];

        test(`${type}: a containerized default uses the launcher mapping, never the backend HOME`, () => {
            const env = { ...containerized, [configVariable]: HOST_DIRS[type] };
            assert.equal(resolveConfigPath(defaultPath, env), HOST_DIRS[type]);
            assert.equal(resolveConfigPath(defaultPath, { ...containerized, [hostVariable]: `${HOST_DIRS[type]}/` }), HOST_DIRS[type]);
            // The normalized backend variable wins over the raw launcher setting.
            assert.equal(resolveConfigPath(defaultPath, { ...env, [hostVariable]: '/elsewhere/dir' }), HOST_DIRS[type]);
        });

        test(`${type}: a containerized default without a mapping fails closed`, () => {
            assert.throws(() => resolveConfigPath(defaultPath, containerized), new RegExp(`no host mapping.*${hostVariable}`));
            assert.throws(() => resolveConfigPath(defaultPath, { ...containerized, [configVariable]: '  ' }), /no host mapping/);
        });

        test(`${type}: an invalid mapping fails closed`, () => {
            for (const invalid of ['relative/dir', '/', '/host/a:b', 'C:\\Users\\me']) {
                assert.throws(() => resolveConfigPath(defaultPath, { ...containerized, [configVariable]: invalid }),
                    new RegExp(configVariable), invalid);
            }
        });

        test(`${type}: a native default expands against HOME, explicit and managed paths keep their identity`, () => {
            const native = { HOME: '/home/operator', PROPR_CONTAINERIZED: '0' };
            assert.equal(resolveDefaultConfigPath(type, native), `/home/operator/${defaultPath.slice(2)}`);
            const mapped = { ...containerized, [configVariable]: HOST_DIRS[type], PROPR_MANAGED_CREDENTIALS_DIR: '/srv/managed' };
            assert.equal(resolveConfigPath(`/srv/custom-${type}`, mapped), `/srv/custom-${type}`);
            if (!isAgentLoginSupported(type)) return;
            const managed = getManagedAgentConfigPath(`${type}-1`, type);
            assert.ok(resolveConfigPath(managed, mapped).startsWith(`/srv/managed/${type}-1/`));
        });
    }
});

describe('login and execution bind the same host credential store', () => {
    test('Claude login, task launch and the shared resolver agree under container HOME=/root', () => {
        withEnv({ ...containerized, CLAUDE_CONFIG_PATH: HOST_DIRS.claude }, () => {
            const claude = agent('claude');
            const loginPath = resolveAgentLoginConfigPath(claude);
            assert.equal(loginPath, HOST_DIRS.claude);
            assert.equal(resolveConfigPath(claude.configPath), loginPath);

            const loginArgs = buildAgentLoginCreateArgs(claude, AGENT_LOGIN_DESCRIPTORS.claude, loginPath, 'login-1');
            const taskArgs = buildClaudeDockerArgs(claude, 10, { worktreePath: '/tmp/worktree', githubToken: '', issueNumber: 42 });
            assert.deepEqual(mountSources(loginArgs, '/home/node/.claude'), [HOST_DIRS.claude]);
            assert.deepEqual(mountSources(taskArgs, '/home/node/.claude'), [HOST_DIRS.claude]);
            assert.ok(!taskArgs.some(arg => arg.startsWith('/root/.claude')));
        });
    });

    test('a Claude task refuses to launch when the containerized default is unmapped', () => {
        withEnv(containerized, () => {
            assert.throws(() => buildClaudeDockerArgs(agent('claude'), 10, { worktreePath: '/tmp/worktree', githubToken: '', issueNumber: 42 }),
                /no host mapping.*HOST_CLAUDE_DIR/);
            assert.throws(() => resolveAgentLoginConfigPath(agent('claude')), /no host mapping.*HOST_CLAUDE_DIR/);
        });
    });

    test('OpenCode login and task launch mount the mapped config directory', () => {
        withEnv({ ...containerized, HOST_OPENCODE_XDG_DIR: HOST_DIRS.opencode }, () => {
            const opencode = agent('opencode');
            const loginPath = resolveAgentLoginConfigPath(opencode);
            assert.equal(loginPath, HOST_DIRS.opencode);
            const taskArgs = buildOpenCodeDockerArgs({
                config: opencode, worktreePath: '/tmp/worktree', githubToken: '', issueNumber: 42,
                gitMountArgs: [], ensureConfigPath: () => {},
            });
            assert.deepEqual(mountSources(taskArgs, '/home/node/.config/opencode'), [loginPath]);
        });
    });

    test('login and execution agree for every loginable default, explicit and managed path', () => {
        const env = {
            ...containerized, PROPR_MANAGED_CREDENTIALS_DIR: '/srv/managed',
            CLAUDE_CONFIG_PATH: HOST_DIRS.claude, ANTIGRAVITY_CONFIG_PATH: HOST_DIRS.antigravity,
            OPENCODE_CONFIG_PATH: HOST_DIRS.opencode,
        };
        withEnv(env, () => {
            for (const type of ['claude', 'antigravity', 'opencode'] as const) {
                for (const configPath of [DEFAULT_CONFIG_PATHS[type], `/srv/custom-${type}`, getManagedAgentConfigPath(`${type}-1`, type)]) {
                    const configured = agent(type, { configPath });
                    assert.equal(resolveAgentLoginConfigPath(configured), resolveConfigPath(configPath), `${type} ${configPath}`);
                }
            }
        });
    });

    test('a native default keeps normal home expansion for login and execution', () => {
        withEnv({ HOME: '/home/operator', PROPR_CONTAINERIZED: '0' }, () => {
            const claude = agent('claude');
            assert.equal(resolveConfigPath(claude.configPath), '/home/operator/.claude');
            assert.equal(resolveAgentLoginConfigPath(claude), '/home/operator/.claude');
        });
    });
});
