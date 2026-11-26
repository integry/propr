import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const token = process.env.PROPR_SPRITES_LIVE_TOKEN;
test('real Sprite provisions all pinned CLIs, runs as node and restores between clone runs', {
    skip: !token && 'set PROPR_SPRITES_LIVE_TOKEN', timeout: 30 * 60_000,
}, async t => {
    process.env.SPRITES_CLIENT_SIGNALS ??= '0';
    const { SpritesClient } = await import('@fly/sprites');
    const { SpritesRuntime } = await import('../packages/core/src/agents/runtime/spritesRuntime.ts');
    const { readSpritesCliPins } = await import('../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts');
    const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
    const { buildAgentRunRepoSetup } = await import('../packages/core/src/claude/docker/repoSetupWrapper.ts');
    const { WORKSPACE_TRANSPORT_SCRIPT, WORKSPACE_TRANSPORT_RESULT_DIR } = await import('../packages/core/src/git/workspaceTransportScript.ts');
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    t.after(closeConnection);
    const api = new SpritesClient(token!);
    const sprite = await api.createSprite('propr-test-' + randomUUID());
    t.after(() => api.deleteSprite(sprite.name));
    // A local remote exercises the real clone/snapshot protocol without a GitHub account.
    const remote = '/opt/test-remote.git';
    const { stdout } = await sprite.execFile('sudo', ['-n', 'bash', '-ec', `
        git init -q --bare ${remote}
        git init -q /tmp/test-seed
        cd /tmp/test-seed
        git -c user.name=ProPR -c user.email=test@propr.dev commit -q --allow-empty -m base
        git push -q ${remote} HEAD:refs/heads/base
        git rev-parse HEAD
    `]);
    let created = false;
    const runtime = new SpritesRuntime({
        createSprite: async () => { assert.ok(!created, 'the warm Sprite should be reused'); created = true; return sprite; },
        deleteSprite: async () => { throw new Error('live Sprite restore failed'); },
    }, { PROPR_SPRITES_TOKEN: token });
    const pins = readSpritesCliPins();
    const agyStore = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-live-credentials-'));
    t.after(() => fs.rmSync(agyStore, { recursive: true, force: true }));
    const oauth = 'antigravity-cli/antigravity-oauth-token';
    fs.mkdirSync(path.join(agyStore, 'antigravity-cli'));
    fs.writeFileSync(path.join(agyStore, oauth), 'synthetic-before');

    for (const [provider, cli, version] of [
        ['claude', 'claude', pins.CLAUDE_CLI_VERSION], ['codex', 'codex', pins.CODEX_CLI_VERSION],
        ['antigravity', 'agy', pins.ANTIGRAVITY_CLI_VERSION],
    ] as const) {
        const builder = new AgentRunSpecBuilder({
            name: 'live-' + provider, agentType: provider, image: 'live', stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
            workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', mode: 'clone', readOnly: false,
                clone: { remote, baseRef: 'refs/heads/base', baseCommit: stdout.toString().trim(), branch: 'task',
                    resultRef: 'refs/heads/result', resultDir: WORKSPACE_TRANSPORT_RESULT_DIR, script: WORKSPACE_TRANSPORT_SCRIPT } },
        });
        if (provider === 'antigravity') {
            builder.credentialBind(agyStore, '/home/node/.gemini-source', true, { provider, store: 'config', perRun: true })
                .env('PROPR_EPHEMERAL_STATE', '1').env('PROPR_ANTIGRAVITY_SOURCE_CONFIG', '/home/node/.gemini-source');
        }
        const spec = builder.command('/bin/bash', '-ec', `
            test "$(id -un)" = node
            test -z "$SPRITES_TOKEN$PROPR_SPRITES_TOKEN"
            test /tmp -ef /opt/propr/run/tmp
            test ! -e /tmp/previous-run
            test ! -e previous-run
            touch /tmp/previous-run previous-run
            ${provider === 'antigravity' ? `test -z "$PROPR_ANTIGRAVITY_SOURCE_CONFIG"
            test ! -w "/opt/propr/run/source/${oauth}"
            test "$(cat "$HOME/.gemini/${oauth}")" = synthetic-before
            printf synthetic-after > "$HOME/.gemini/${oauth}"` : ''}
            ${cli} --version
        `).build();
        spec.repoSetup = buildAgentRunRepoSetup(provider);
        const run = runtime.start(spec, { timeout: 20 * 60_000 });
        try {
            const result = await run.wait();
            assert.equal(result.exitCode, 0, result.stderr);
            await sprite.execFile('sh', ['-ec', 'test ! -e /tmp/previous-run; touch /tmp/previous-run']);
            assert.ok(result.stdout.includes(version), 'provider CLI version');
            assert.match((await run.readFile!(WORKSPACE_TRANSPORT_RESULT_DIR + '/status'))!.toString(), /^pushed /);
        } finally { await run.release!(); }
        await sprite.execFile('test', ['!', '-e', '/tmp/previous-run']);
    }
    assert.equal(fs.readFileSync(path.join(agyStore, oauth), 'utf8'), 'synthetic-after');
});

test('real Sprite reaches a worker-local ProPR API over the SSH reverse forward, streaming included', {
    skip: !token && 'set PROPR_SPRITES_LIVE_TOKEN', timeout: 30 * 60_000,
}, async t => {
    process.env.SPRITES_CLIENT_SIGNALS ??= '0';
    const http = await import('node:http');
    const { SpritesClient } = await import('@fly/sprites');
    const { SpritesRuntime } = await import('../packages/core/src/agents/runtime/spritesRuntime.ts');
    const { AgentRunSpecBuilder, agentRunMcpGrant, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
    const { planAgentRunMcpTransport } = await import('../packages/core/src/agents/runtime/agentRunMcpTransport.ts');
    const { WORKSPACE_TRANSPORT_SCRIPT, WORKSPACE_TRANSPORT_RESULT_DIR } = await import('../packages/core/src/git/workspaceTransportScript.ts');
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    t.after(closeConnection);
    // The "internal API": reachable only from this machine, never from the internet.
    const grantToken = 'propr_mcp_live_' + randomUUID();
    const api = http.createServer((req, res) => {
        if (req.headers.authorization !== `Bearer ${grantToken}`) { res.writeHead(401).end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: first\n\n');
        setTimeout(() => res.end('data: second\n\n'), 500);
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', () => resolve()));
    t.after(() => { api.closeAllConnections(); api.close(); });
    const environment = { PROPR_SPRITES_TOKEN: token, PROPR_INTERNAL_API_URL: `http://127.0.0.1:${(api.address() as { port: number }).port}` };
    const client = new SpritesClient(token!);
    const sprite = await client.createSprite('propr-test-' + randomUUID());
    t.after(() => client.deleteSprite(sprite.name));
    const remote = '/opt/test-remote.git';
    const { stdout } = await sprite.execFile('sudo', ['-n', 'bash', '-ec', `
        git init -q --bare ${remote}
        git init -q /tmp/test-seed
        cd /tmp/test-seed
        git -c user.name=ProPR -c user.email=test@propr.dev commit -q --allow-empty -m base
        git push -q ${remote} HEAD:refs/heads/base
        git rev-parse HEAD
    `]);
    const runtime = new SpritesRuntime({ createSprite: async () => sprite, deleteSprite: async () => {} }, environment);
    const plan = planAgentRunMcpTransport(runtime, environment);
    assert.equal(plan.transport, 'ssh-reverse-forward');
    const url = (plan as { url: string }).url;
    const spec = new AgentRunSpecBuilder({
        name: 'live-forward', agentType: 'claude', image: 'live', stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        mcpGrant: agentRunMcpGrant({ mcpServers: [{ name: 'propr', url, bearerTokenEnv: 'PROPR_MCP_TOKEN', bearerToken: grantToken }], mcpTransport: 'ssh-reverse-forward' }),
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', mode: 'clone', readOnly: false,
            clone: { remote, baseRef: 'refs/heads/base', baseCommit: stdout.toString().trim(), branch: 'task',
                resultRef: 'refs/heads/result', resultDir: WORKSPACE_TRANSPORT_RESULT_DIR, script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).env('PROPR_MCP_TOKEN', grantToken).command('/bin/bash', '-ec', `
        # sshd (port 39022 = 0x986E) and the forward (39080 = 0x98A8) listen on 127.0.0.1 only.
        listening() { awk 'NR > 1 && $4 == "0A" { print $2 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null; }
        listening | grep -qx '0100007F:986E'
        listening | grep -qx '0100007F:98A8'
        ! listening | grep -v '^0100007F:' | grep -qE ':(986E|98A8)$'
        curl -fsS -N -H "Authorization: Bearer $PROPR_MCP_TOKEN" ${url}
    `).build();
    const run = runtime.start(spec, { timeout: 20 * 60_000 });
    try {
        const result = await run.wait();
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'data: first\n\ndata: second');
        assert.ok((await run.inspect!()).diagnostics?.some(line => line.includes('ssh-reverse-forward')));
        assert.ok(!result.stdout.includes('PRIVATE KEY') && !result.stderr.includes('PRIVATE KEY'));
    } finally { await run.release!(); }
});
