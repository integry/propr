import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiAgent } from '../packages/core/src/agents/impl/PiAgent.js';
import { buildPiAuthCheckDockerArgs, parsePiAuthCheckOutput, runPiAuthCheck } from '../packages/core/src/agents/impl/utils/piAuthCheck.js';
import type { AgentConfig } from '../packages/core/src/agents/types.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => {
    await closeConnection();
});

function piConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
        id: 'pi-test', type: 'pi', alias: 'pi-test', enabled: true, dockerImage: 'propr/agent:latest',
        configPath: '/nonexistent/pi/agent', supportedModels: ['pi-anthropic/claude-sonnet-5-5'], defaultModel: 'pi-anthropic/claude-sonnet-5-5',
        ...overrides,
    };
}

describe('parsePiAuthCheckOutput', () => {
    // Recorded from Pi 1.6.1 `pi auth check --provider <p> --json --no-refresh`.
    test('reads ready, not_ready and invalid results', () => {
        assert.deepEqual(parsePiAuthCheckOutput('{"status":"ready","provider":"anthropic","authType":"oauth"}\n', 0, 'anthropic'),
            { status: 'ready', provider: 'anthropic', authType: 'oauth' });
        assert.deepEqual(parsePiAuthCheckOutput('{"status":"ready","provider":"openrouter","authType":"api_key"}\n', 0, 'openrouter'),
            { status: 'ready', provider: 'openrouter', authType: 'api_key' });

        const notReady = parsePiAuthCheckOutput('{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}\n', 1, 'anthropic');
        assert.equal(notReady.status, 'not_ready');
        assert.equal(notReady.reason, 'credentials_not_configured');
        assert.match(notReady.message ?? '', /pi auth login anthropic/);

        const invalid = parsePiAuthCheckOutput('{"status":"invalid","provider":"anthropic","reason":"invalid_state"}\n', 2, 'anthropic');
        assert.equal(invalid.status, 'invalid');
        assert.match(invalid.message ?? '', /invalid \(invalid_state\)/);

        const unknown = parsePiAuthCheckOutput('{"status":"not_ready","provider":"nosuch","reason":"provider_not_found"}\n', 1, 'nosuch');
        assert.match(unknown.message ?? '', /does not know the provider "nosuch"/);
    });

    test('skips entrypoint noise and falls back to the exit code when there is no JSON', () => {
        const noisy = 'Pi CLI version: 1.6.1\n{"status":"ready","provider":"google","authType":"api_key"}\n';
        assert.equal(parsePiAuthCheckOutput(noisy, 0, 'google').status, 'ready');
        assert.equal(parsePiAuthCheckOutput('ready\n', 0, 'google').status, 'ready');
        assert.equal(parsePiAuthCheckOutput('', 1, 'google').status, 'not_ready');
        assert.equal(parsePiAuthCheckOutput('', 2, 'google').status, 'invalid');
        assert.throws(() => parsePiAuthCheckOutput('', 125, 'google'), /exit code 125/);
        assert.throws(() => parsePiAuthCheckOutput('', null, 'google'), /without a result/);
    });

    test('ignores provider-supplied strings that are not plain codes', () => {
        const result = parsePiAuthCheckOutput('{"status":"invalid","provider":"anthropic","reason":"<script>"}', 2, 'anthropic');
        assert.equal(result.reason, undefined);
    });
});

describe('buildPiAuthCheckDockerArgs', () => {
    test('runs pi auth check without refreshing, with no network, keys through the client env and a read-only mount', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auth-check-'));
        try {
            const invocation = buildPiAuthCheckDockerArgs({
                config: piConfig({ envVars: { OPENROUTER_API_KEY: 'sk-or-secret', PI_CODING_AGENT_DIR: '/elsewhere' } }),
                configPath: dir, provider: 'openrouter',
            });
            assert.deepEqual(invocation.args.slice(-7), ['pi', 'auth', 'check', '--provider', 'openrouter', '--json', '--no-refresh']);
            assert.ok(invocation.args.includes(`${dir}:/home/node/.pi/agent:ro`));
            assert.equal(invocation.args[invocation.args.indexOf('--network') + 1], 'none');
            assert.ok(invocation.args.includes('PROPR_AGENT_TYPE=pi'));
            assert.deepEqual(invocation.secretEnv, { OPENROUTER_API_KEY: 'sk-or-secret' }, 'reserved Pi variables are not forwarded');
            assert.ok(invocation.args.includes('OPENROUTER_API_KEY'));
            assert.ok(!invocation.args.join(' ').includes('sk-or-secret'), 'secrets never reach argv');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('does not mount a missing host dir and refuses unsafe providers', () => {
        const invocation = buildPiAuthCheckDockerArgs({ config: piConfig(), configPath: '/nonexistent/pi/agent', provider: 'anthropic' });
        assert.ok(!invocation.args.includes('-v'));
        assert.throws(() => buildPiAuthCheckDockerArgs({ config: piConfig(), provider: '--json' }), /Invalid Pi provider/);
    });
});

describe('PiAgent.checkCredentials', () => {
    test('checks the model provider and reports runner failures as errors', async () => {
        const agent = new PiAgent(piConfig());
        let seen: string[] = [];
        const result = await agent.checkCredentials('pi-openrouter/mistralai/devstral-2512', async args => {
            seen = args;
            return { stdout: '{"status":"not_ready","provider":"openrouter","reason":"credentials_not_configured"}\n', stderr: '', exitCode: 1 };
        });
        assert.equal(result.status, 'not_ready');
        assert.equal(seen[seen.indexOf('--provider') + 1], 'openrouter');

        await assert.rejects(
            runPiAuthCheck({ args: [], secretEnv: {}, configEnv: {} }, 'anthropic', { run: async () => ({ stdout: '', stderr: 'docker: Error response from daemon', exitCode: 125 }) }),
            /could not run \(exit code 125\): docker: Error response/,
        );
    });
});
