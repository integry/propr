import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { wrapDockerRunArgsWithRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.js';
import { executeDockerCommand } from '../packages/core/src/claude/docker/dockerExecutor.js';
import { buildCodexStreamConfigArgs, resolveCodexStreamConfig } from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.js';
import { AGENT_EGRESS_PROXY_SUPPORT } from '../packages/core/src/network/egressAllowlist.js';
import { executeWithNetworkPolicy } from '../packages/core/src/network/egressExecution.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import type { AgentType } from '../packages/core/src/agents/types.js';

// Runs each agent CLI marked supported in AGENT_EGRESS_PROXY_SUPPORT inside a
// restricted container, with only its built-in allowlist and a deliberately
// invalid credential. The provider's authentication error proves its real
// transport (HTTPS, and Codex's WebSocket stream) went through the proxy: the
// container has no DNS and no route, so a client that ignored the proxy
// variables would fail to resolve the host instead. It needs Docker, the
// internet and PROPR_TEST_AGENT_IMAGE (the unified agent image); with
// PROPR_TEST_REQUIRE_DOCKER=1 a missing prerequisite fails instead of skipping.
const image = process.env.PROPR_TEST_AGENT_IMAGE;
const missing = !image ? 'set PROPR_TEST_AGENT_IMAGE to the unified agent image'
    : spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0 ? 'docker is needed for the provider egress test' : undefined;
const skip = missing && process.env.PROPR_TEST_REQUIRE_DOCKER !== '1' ? missing : false;

after(closeConnection);

const PROMPT = 'Reply with the single word OK.';
const codexTransport = (transport: 'websocket' | 'sse') => buildCodexStreamConfigArgs({ ...resolveCodexStreamConfig({}), transport, maxRetries: 0 })
    .map(arg => `'${arg.replaceAll("'", `'\\''`)}'`).join(' ');

/** One invocation per supported transport, each with a credential the provider rejects. */
const CASES: Array<{ name: string; agent: AgentType; env: string[]; command: string }> = [
    { name: 'Claude Code', agent: 'claude', env: ['ANTHROPIC_API_KEY=sk-ant-propr-egress-invalid'], command: `claude -p '${PROMPT}' --max-turns 1` },
    {
        name: 'Codex (WebSocket stream)', agent: 'codex', env: ['OPENAI_API_KEY=sk-propr-egress-invalid', 'CODEX_API_KEY=sk-propr-egress-invalid'],
        command: `codex exec --ephemeral --skip-git-repo-check ${codexTransport('websocket')} '${PROMPT}'`,
    },
    {
        name: 'Codex (SSE stream)', agent: 'codex', env: ['OPENAI_API_KEY=sk-propr-egress-invalid', 'CODEX_API_KEY=sk-propr-egress-invalid'],
        command: `codex exec --ephemeral --skip-git-repo-check ${codexTransport('sse')} '${PROMPT}'`,
    },
    { name: 'OpenCode', agent: 'opencode', env: ['ANTHROPIC_API_KEY=sk-ant-propr-egress-invalid'], command: `opencode run --model anthropic/claude-sonnet-4-5 '${PROMPT}'` },
    {
        name: 'Vibe', agent: 'vibe', env: ['MISTRAL_API_KEY=propr-egress-invalid'],
        command: `printf '%s' '${PROMPT}' > /tmp/propr-egress-prompt.txt && vibe --output json --prompt-file /tmp/propr-egress-prompt.txt`,
    },
];

/** What a client that bypassed the proxy reports inside a container without DNS or a route. */
const BYPASSED_PROXY = /ENOTFOUND|EAI_AGAIN|getaddrinfo|Could not resolve host|Name or service not known|Temporary failure in name resolution|failed to lookup address|dns error|Network is unreachable|ENETUNREACH/i;
/** The provider's answer to the invalid credential. */
const PROVIDER_REJECTED = /\b401\b|\b403\b|unauthori[sz]ed|invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|authentication|invalid bearer|not authenticated|api key (?:is )?invalid/i;

test('every agent CLI marked supported is covered by a provider transport case', () => {
    const supported = Object.entries(AGENT_EGRESS_PROXY_SUPPORT).filter(([, entry]) => entry.supported).map(([agent]) => agent).sort();
    assert.deepEqual([...new Set(CASES.map(entry => entry.agent))].sort(), supported);
});

for (const entry of CASES) {
    test(`${entry.name} reaches its provider only through the restricted proxy`, { skip, timeout: 300_000 }, async () => {
        assert.ok(!missing, missing);
        const socketRoot = await mkdtemp(path.join(tmpdir(), 'propr-provider-egress-'));
        const previous = process.env.PROPR_EGRESS_SOCKET_DIR;
        process.env.PROPR_EGRESS_SOCKET_DIR = socketRoot;
        try {
            const args = wrapDockerRunArgsWithRepoSetup([
                'run', '--rm', '--network', 'bridge', '--user', '0:0', ...entry.env.flatMap(value => ['-e', value]), image!,
            ], image!, entry.agent);
            const { result, report } = await executeWithNetworkPolicy(
                { mode: 'restricted', source: 'workflow', allow: [] },
                () => executeDockerCommand('docker', [...args, '/bin/bash', '-c', `timeout 150 ${entry.command} 2>&1; echo "propr-exit=$?"`], { timeout: 240_000 }),
            );
            const output = `${result.stdout}\n${result.stderr}`;
            assert.equal(report.restrictedContainers, 1);
            assert.doesNotMatch(output, /propr-exit=124\b/, `${entry.name} hung instead of finishing:\n${output.slice(-4000)}`);
            assert.doesNotMatch(output, BYPASSED_PROXY, `${entry.name} tried to reach the network without the proxy:\n${output.slice(-4000)}`);
            assert.ok(report.allowedConnections >= 1, `${entry.name} opened no connection through the proxy:\n${output.slice(-4000)}`);
            assert.equal(report.failedConnections, 0, `allowed provider hosts must be reachable: ${JSON.stringify(report.failedHosts)}`);
            assert.match(output, PROVIDER_REJECTED, `${entry.name} got no answer from its provider:\n${output.slice(-4000)}`);
        } finally {
            if (previous === undefined) delete process.env.PROPR_EGRESS_SOCKET_DIR; else process.env.PROPR_EGRESS_SOCKET_DIR = previous;
            await rm(socketRoot, { recursive: true, force: true });
        }
    });
}
