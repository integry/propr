import { after, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { createAgentsRoutes } = await import('../packages/api/routes/configRoutesAgents.ts');
const { createAgentVersionRoutes } = await import('../packages/api/routes/agentVersionRoutes.ts');
const { closeConnection } = await import('@propr/core');

after(async () => {
    await closeConnection();
});

type MockResponse<T = Record<string, unknown>> = {
    statusCode: number;
    body: T | undefined;
    status: (code: number) => MockResponse<T>;
    json: (payload: T) => MockResponse<T>;
};

function createMockResponse<T = Record<string, unknown>>(): MockResponse<T> {
    return {
        statusCode: 200,
        body: undefined,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: T) {
            this.body = payload;
            return this;
        }
    };
}

describe('OpenCode API routes', () => {
    test('POST /api/config/agents accepts a valid OpenCode agent config', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
            eval: mock.fn(async () => 1)
        };
        const applyAgentsUpdateFn = mock.fn(async (params: {
            processedAgents?: Array<Record<string, unknown>>;
        }) => {
            const [agent] = params.processedAgents ?? [];
            assert.equal(agent?.type, 'opencode');
            assert.equal(agent?.cliVersionType, 'default');
            assert.equal(agent?.cliVersionResolved, '1.18.2');
            return { status: 200, body: { success: true, agents: params.processedAgents } };
        });
        const routes = createAgentsRoutes({
            redisClient: redisClient as never,
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            applyAgentsUpdateFn: applyAgentsUpdateFn as never
        });
        const res = createMockResponse();

        await routes.postAgents({
            body: {
                agents: [{
                    id: 'opencode-1',
                    type: 'opencode',
                    alias: 'opencode',
                    enabled: true,
                    dockerImage: 'propr/agent:latest',
                    configPath: '~/.config/opencode',
                    supportedModels: ['opencode-minimax-m3-free', 'openai/gpt-5.5'],
                    defaultModel: 'openai/gpt-5.5'
                }]
            }
        } as never, res as never);

        assert.equal(res.statusCode, 200);
        assert.equal(applyAgentsUpdateFn.mock.calls.length, 1);
        assert.equal(redisClient.set.mock.calls.length, 1);
        const appliedAgent = (res.body?.agents as Array<Record<string, unknown>>)[0];
        assert.equal(appliedAgent?.type, 'opencode');
        assert.deepEqual(appliedAgent?.supportedModels, ['opencode-minimax-m3-free', 'opencode-openai/gpt-5.5']);
        assert.equal(appliedAgent?.defaultModel, 'opencode-openai/gpt-5.5');
    });

    test('POST /api/config/agents normalizes stale default OpenCode CLI version payloads before applying config', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK')
        };
        const applyAgentsUpdateFn = mock.fn(async () => ({ status: 200, body: { success: true } }));
        const routes = createAgentsRoutes({
            redisClient: redisClient as never,
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            applyAgentsUpdateFn: applyAgentsUpdateFn as never
        });
        const res = createMockResponse();

        await routes.postAgents({
            body: {
                agents: [{
                    id: 'opencode-1',
                    type: 'opencode',
                    alias: 'opencode',
                    enabled: true,
                    dockerImage: 'propr/agent:latest',
                    configPath: '~/.config/opencode',
                    supportedModels: ['opencode-minimax-m3-free'],
                    defaultModel: 'opencode-minimax-m3-free',
                    cliVersionType: 'default',
                    cliVersion: 'latest'
                }]
            }
        } as never, res as never);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { success: true });
        assert.equal(applyAgentsUpdateFn.mock.calls.length, 1);
        const appliedAgents = applyAgentsUpdateFn.mock.calls[0].arguments[0].processedAgents;
        assert.strictEqual(appliedAgents[0].cliVersion, undefined);
    });

    test('GET /api/agents/versions/opencode returns OpenCode version metadata', async () => {
        const routes = createAgentVersionRoutes({
            getAvailableVersions: async agentType => ({
                agentType,
                packageName: 'opencode-ai',
                defaultVersion: '1.17.10',
                availableTags: [{ tag: 'latest', version: '1.17.10' }],
                recentVersions: [{ version: '1.17.10', publishedAt: '2026-06-25T00:00:00.000Z' }]
            })
        });
        const res = createMockResponse();

        await routes.getVersions({ params: { agentType: 'opencode' } } as never, res as never);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, {
            agentType: 'opencode',
            packageName: 'opencode-ai',
            defaultVersion: '1.17.10',
            availableTags: [{ tag: 'latest', version: '1.17.10' }],
            recentVersions: [{ version: '1.17.10', publishedAt: '2026-06-25T00:00:00.000Z' }]
        });
    });

    test('GET /api/agents/opencode/images uses the unified image name', async () => {
        const routes = createAgentVersionRoutes({
            listAgentImages: async agentType => {
                assert.equal(agentType, 'opencode');
                return ['1.17.10-abc123'];
            }
        });
        const res = createMockResponse();

        await routes.listImages({ params: { agentType: 'opencode' } } as never, res as never);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, {
            agentType: 'opencode',
            images: [{
                tag: '1.17.10-abc123',
                fullName: 'propr/agent:1.17.10-abc123'
            }]
        });
    });

    test('agent version routes reject invalid agent types with a deterministic 400', async () => {
        const routes = createAgentVersionRoutes();
        const res = createMockResponse();

        await routes.getVersions({ params: { agentType: 'llama' } } as never, res as never);

        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, {
            error: "Invalid agent type 'llama'. Must be one of: antigravity, claude, codex, opencode, vibe"
        });
    });
});
