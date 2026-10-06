import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

class FakeRedis {
    status = 'ready';
    on() { return this; }
    async eval() { return 0; }
    async get() { return null; }
    async quit() { return 'OK'; }
    disconnect() {}
}
mock.module('ioredis', { namedExports: { Redis: FakeRedis, default: FakeRedis } });
const { executeDockerCommand } = await import('../packages/core/src/claude/docker/dockerExecutor.js');
const { PROPR_MCP_BEARER_TOKEN_ENV } = await import('../packages/core/src/agents/agentToolPolicy.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');

after(async () => { await closeConnection(); });

const TOKEN = 'propr_mcp_run_token_abcdef0123456789';
const printEnv = `process.stdout.write(JSON.stringify({ token: process.env.${PROPR_MCP_BEARER_TOKEN_ENV}, path: process.env.PATH }))`;

/** Runs `printEnv` with an inherited token value, restoring the parent environment afterwards. */
async function runWithInheritedToken(extraEnvVars?: Record<string, string>) {
    const previous = process.env[PROPR_MCP_BEARER_TOKEN_ENV];
    process.env[PROPR_MCP_BEARER_TOKEN_ENV] = 'inherited-value';
    try {
        const result = await executeDockerCommand(process.execPath, ['-e', printEnv], {
            taskId: 'extra-env', timeout: 10_000, ...(extraEnvVars && { extraEnvVars }),
        });
        assert.equal(result.exitCode, 0);
        assert.equal(process.env[PROPR_MCP_BEARER_TOKEN_ENV], 'inherited-value', 'process.env is not modified');
        return JSON.parse(result.stdout) as { token?: string; path?: string };
    } finally {
        if (previous === undefined) delete process.env[PROPR_MCP_BEARER_TOKEN_ENV];
        else process.env[PROPR_MCP_BEARER_TOKEN_ENV] = previous;
    }
}

test('extraEnvVars reach the spawned process, override the inherited value and leave process.env alone', async () => {
    assert.deepEqual(await runWithInheritedToken({ [PROPR_MCP_BEARER_TOKEN_ENV]: TOKEN }), { token: TOKEN, path: process.env.PATH });
});

test('without extraEnvVars the process inherits the parent environment unchanged', async () => {
    assert.deepEqual(await runWithInheritedToken(), { token: 'inherited-value', path: process.env.PATH });
    assert.deepEqual(await runWithInheritedToken({}), { token: 'inherited-value', path: process.env.PATH });
});

test('extraEnvVars stay out of the argument list', async () => {
    const result = await executeDockerCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv))'], {
        taskId: 'extra-env', timeout: 10_000, extraEnvVars: { [PROPR_MCP_BEARER_TOKEN_ENV]: TOKEN },
    });
    assert.ok(!result.stdout.includes(TOKEN));
});
