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

test('measured diagnostics capacity warns without blocking a provider launch', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { managedDiagnostics } = await import('../packages/core/src/diagnostics/managedLogRuntime.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-admission-'));
    const previous = { PROPR_MANAGED_LOGS: process.env.PROPR_MANAGED_LOGS, PROPR_INSTANCE_ID: process.env.PROPR_INSTANCE_ID, PROPR_DIAGNOSTIC_ROOT: process.env.PROPR_DIAGNOSTIC_ROOT };
    Object.assign(process.env, { PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'test-instance', PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool') });
    try {
        const db = managedDiagnostics()!;
        db.report({ provider: 'codex', agent: 'full', source: 'native-state' }, 'protected-native-state', db.limits.protectedBytes);
        const result = await executeDockerCommand(process.execPath, ['-e', `process.stdout.write('INFO launch succeeded\\n')`], {
            timeout: 10000, diagnostics: { provider: 'codex', agent: 'running', authenticationRoot: root },
        });
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /launch succeeded/);
        assert.ok((db.status() as { sources: Array<{ capacityWarning: boolean }> }).sources.some(source => source.capacityWarning));
        db.close();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});


test('non-enumerable stdio launch environments reach the Docker subprocess for both runtimes', async t => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { claudeToolPolicyArgs, codexToolPolicyArgs } = await import('../packages/core/src/agents/agentToolPolicy.js');
    const key = 'PROPR_EXTENSION_STDIO_0_0_SECRET';
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stdio-docker-env-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    // Stand in for the Docker executable at the process boundary, without requiring a daemon.
    await fs.writeFile(path.join(directory, 'docker'), `#!${process.execPath}
const args = process.argv.slice(2);
const name = '${key}';
const forwarded = args.some((arg, index) => arg === '-e' && args[index + 1] === name);
process.stdout.write(JSON.stringify({ forwarded, value: process.env[name], args }));
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = directory + path.delimiter + previousPath;
    t.after(() => { process.env.PATH = previousPath; });
    for (const build of [claudeToolPolicyArgs, codexToolPolicyArgs]) {
        const launch = build({ allowWeb: false, exclusiveMcp: true, localMcpServers: [{ name: 'docs', bridgeConfig: 'synthetic', env: { [key]: TOKEN } }] });
        assert.ok(!Object.keys(launch).includes('env'));
        const result = await executeDockerCommand('docker', ['run', '-e', key, 'synthetic-image'], {
            taskId: 'stdio-env', timeout: 10_000, costCapExempt: true, networkPolicyExempt: 'Synthetic Docker environment fixture', extraEnvVars: launch.env,
        });
        assert.equal(result.exitCode, 0);
        const captured = JSON.parse(result.stdout);
        assert.equal(captured.forwarded, true);
        assert.equal(captured.value, TOKEN);
        assert.ok(!JSON.stringify(captured.args).includes(TOKEN));
    }
});
