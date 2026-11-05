import { after, afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

process.env.NODE_ENV = 'test';

// Route-level coverage for the default-path branch of OpenCode model discovery:
// the saved agent keeps `~/.config/opencode` and only the launcher mapping varies.
const actualCore = await import('@propr/core');
mock.module('@propr/core', {
    namedExports: {
        ...actualCore,
        loadAgents: async () => [{
            id: 'opencode-1', type: 'opencode', alias: 'opencode', enabled: true,
            dockerImage: 'propr/agent:test', configPath: '~/.config/opencode', supportedModels: [],
        }],
    },
});
const dockerCalls: string[][] = [];
mock.module('child_process', {
    namedExports: {
        execFile: (_command: string, args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
            dockerCalls.push(args);
            callback(null, { stdout: 'openai/gpt-5.5\n', stderr: '' });
        },
    },
});
const { createAgentRoutes } = await import('../packages/api/routes/agentRoutes.ts');

after(async () => {
    await actualCore.closeConnection();
});

const ENV_KEYS = [
    'HOME', 'PROPR_CONTAINERIZED', 'AGENT_DOCKER_IMAGE', 'OPENCODE_CONFIG_PATH', 'HOST_OPENCODE_XDG_DIR',
    'HOST_OPENCODE_DATA_DIR', 'OPENCODE_DATA_PATH',
] as const;
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
    previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.HOME = '/root';
    process.env.PROPR_CONTAINERIZED = '1';
    process.env.AGENT_DOCKER_IMAGE = 'propr/agent:test';
    dockerCalls.length = 0;
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
    }
});

type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }> } };

async function discover(): Promise<{ statusCode: number; body: Record<string, unknown> | undefined }> {
    const { router } = createAgentRoutes() as unknown as { router: { stack: RouteLayer[] } };
    const route = router.stack.find(layer => layer.route?.path === '/opencode/models' && layer.route.methods.get)!.route!;
    const handler = route.stack[route.stack.length - 1].handle; // after the permission guard
    const res = {
        statusCode: 200,
        body: undefined as Record<string, unknown> | undefined,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: Record<string, unknown>) { this.body = payload; return this; },
    };
    await handler({ query: { agentId: 'opencode-1' } } as unknown as Request, res as unknown as Response);
    return res;
}

function mountSource(args: string[], target: string): string | undefined {
    return args.find((arg, index) => args[index - 1] === '-v' && arg.endsWith(`:${target}:rw`))?.split(':')[0];
}

describe('GET /api/agents/opencode/models default credential path', () => {
    test('HOST_OPENCODE_XDG_DIR alone maps the default config and its sibling data directory', async () => {
        process.env.HOST_OPENCODE_XDG_DIR = '/home/desktop-user/.config/opencode';

        const res = await discover();

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body?.models, ['opencode-openai/gpt-5.5']);
        assert.equal(dockerCalls.length, 1);
        assert.equal(mountSource(dockerCalls[0], '/home/node/.config/opencode'), '/home/desktop-user/.config/opencode');
        assert.equal(mountSource(dockerCalls[0], '/home/node/.local/share/opencode'), '/home/desktop-user/.local/share/opencode');
    });

    test('an unmapped containerized default fails closed without mounting backend HOME', async () => {
        const res = await discover();

        assert.equal(res.statusCode, 502);
        assert.match(String(res.body?.details), /no host mapping.*HOST_OPENCODE_XDG_DIR/);
        assert.equal(dockerCalls.length, 0);
    });
});
