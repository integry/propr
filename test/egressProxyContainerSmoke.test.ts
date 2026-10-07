import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { wrapDockerRunArgsWithRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.js';
import { executeDockerCommand } from '../packages/core/src/claude/docker/dockerExecutor.js';
import { executeWithNetworkPolicy } from '../packages/core/src/network/egressExecution.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

// Runs a real agent image in restricted mode, so it needs Docker on this host
// (the socket directory must be a path the Docker daemon can bind-mount) and an
// image name, e.g. PROPR_TEST_AGENT_IMAGE=propr-agent:latest. Otherwise skipped,
// unless PROPR_TEST_REQUIRE_DOCKER=1 (the CI job), which makes that a failure.
const image = process.env.PROPR_TEST_AGENT_IMAGE;
const missing = !image ? 'set PROPR_TEST_AGENT_IMAGE to a supported agent image'
    : spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0 ? 'docker is needed for the container smoke test' : undefined;
const skip = missing && process.env.PROPR_TEST_REQUIRE_DOCKER !== '1' ? missing : false;

after(closeConnection);

test('a restricted container reaches an allowed host only through the proxy and nothing else', { skip, timeout: 300_000 }, async () => {
    assert.ok(!missing, missing);
    const socketRoot = await mkdtemp(path.join(tmpdir(), 'propr-egress-smoke-'));
    const previous = process.env.PROPR_EGRESS_SOCKET_DIR;
    process.env.PROPR_EGRESS_SOCKET_DIR = socketRoot;
    const server = http.createServer((_request, response) => response.end('allowed-ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
        // NO_PROXY covers loopback, so the probes name the proxy explicitly.
        const probe = [
            `echo "allowed=$(curl -sS --noproxy '' -x "$HTTP_PROXY" --max-time 20 http://127.0.0.1:${port}/ 2>&1)"`,
            `echo "denied=$(curl -s -o /dev/null --noproxy '' -x "$HTTPS_PROXY" -w '%{http_connect}' --max-time 20 https://example.com/)"`,
            `if curl -s -o /dev/null --noproxy '*' --max-time 10 https://example.com/; then echo direct=reachable; else echo direct=blocked; fi`,
            `if curl -s -o /dev/null --noproxy '*' --max-time 10 http://1.1.1.1/; then echo direct-ip=reachable; else echo direct-ip=blocked; fi`,
        ].join('; ');
        const args = wrapDockerRunArgsWithRepoSetup(['run', '--rm', '--network', 'bridge', '--user', '0:0', image!], image!, 'claude');
        const { result, report } = await executeWithNetworkPolicy(
            { mode: 'restricted', source: 'workflow', allow: [`127.0.0.1:${port}`] },
            () => executeDockerCommand('docker', [...args, '/bin/bash', '-c', probe], { timeout: 240_000 }),
        );
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, /^allowed=allowed-ok$/m);
        assert.match(result.stdout, /^denied=403$/m);
        assert.match(result.stdout, /^direct=blocked$/m);
        assert.match(result.stdout, /^direct-ip=blocked$/m);
        assert.equal(report.restrictedContainers, 1);
        assert.deepEqual(report.deniedHosts, [{ host: 'example.com', count: 1 }]);
    } finally {
        if (previous === undefined) delete process.env.PROPR_EGRESS_SOCKET_DIR; else process.env.PROPR_EGRESS_SOCKET_DIR = previous;
        await new Promise(resolve => server.close(resolve));
        await rm(socketRoot, { recursive: true, force: true });
    }
});
