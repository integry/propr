import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { after, test } from 'node:test';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { ERROR_DETAIL_LIMIT, flyErrorDetail, type MachineLaunch, type MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
import { RUN } from '../packages/core/src/agents/runtime/fly/wrapper.ts';
import { WORKSPACE_TRANSPORT_RESULT_DIR as RESULT, WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import { validateContainerFilePaths } from '../packages/cli/src/commands/deploy/flyMachineConfig.ts';
import { closeConnection } from '../packages/core/src/db/connection.ts';

after(closeConnection);

const token = 'FlyV1 synthetic-worker-credential';
const env = { PROPR_FLY_APP: 'agents', PROPR_FLY_API_TOKEN: token, PROPR_FLY_IMAGE: 'registry.fly.io/agents@sha256:test' };
const envSecret = 'synthetic-env-secret-0123456789';

function spec() {
    return new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent', name: 'task', stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: '0123', branch: 'test', resultDir: RESULT, script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('claude', '--version').env('GH_TOKEN', envSecret).build();
}

/** Records the create request and refuses it, so no Machine exists afterwards. */
class RecordingMachines implements MachinesApi {
    launch?: MachineLaunch;
    async create(launch: MachineLaunch): Promise<string> { this.launch = launch; throw new Error('recorded'); }
    async exec(): Promise<{ stdout: string; exit_code: number }> { throw new Error('no Machine'); }
    async signal() {}
    async destroy() {}
    async gone() { return true; }
    async find() { return undefined; }
    async logs() {}
}

test('flyErrorDetail keeps only Fly\'s error string, redacted and truncated', () => {
    assert.equal(flyErrorDetail('not json'), undefined);
    assert.equal(flyErrorDetail(JSON.stringify({ config: { env: { GH_TOKEN: envSecret } } })), undefined, 'no error field: nothing echoed');
    assert.equal(flyErrorDetail(JSON.stringify({ error: { nested: envSecret } })), undefined);
    const echoed = flyErrorDetail(JSON.stringify({ error: `invalid config.env: GH_TOKEN=${envSecret} (${Buffer.from(envSecret).toString('base64')})`,
        config: { env: { GH_TOKEN: envSecret } } }), [envSecret]);
    assert.equal(echoed, 'invalid config.env: GH_TOKEN=[REDACTED] ([REDACTED])');
    // Secret-shaped values the worker did not list, and long opaque blobs such as raw_value, are redacted too.
    assert.doesNotMatch(flyErrorDetail(JSON.stringify({ error: 'bad ghp_' + 'a'.repeat(36) }))!, /ghp_a/);
    assert.equal(flyErrorDetail(JSON.stringify({ error: 'bad raw_value ' + 'QUJD'.repeat(40) })), 'bad raw_value [REDACTED]');
    const long = flyErrorDetail(JSON.stringify({ error: 'x '.repeat(1000) }))!;
    assert.equal(long.length, ERROR_DETAIL_LIMIT);
    assert.ok(long.endsWith('…'));
});

test('a rejected Machine create surfaces Fly\'s validation message without the echoed config or env secret', async t => {
    let posted: MachineLaunch | undefined;
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
        assert.ok(url.endsWith('/machines') && init.method === 'POST', 'a 4xx create is never retried or adopted');
        posted = JSON.parse(String(init.body));
        const raw = posted!.config.files.find(f => f.guest_path === '/opt/propr/fly-agent.json')!.raw_value;
        return Response.json({ error: `invalid machine config: env GH_TOKEN=${envSecret} in file raw_value ${raw}`, config: posted }, { status: 422 });
    });
    const run = new FlyMachinesRuntime(undefined, env, async () => ['figlet']).start(spec());
    await assert.rejects(run.wait(), (error: Error) => {
        assert.match(error.message, /^Fly Machines API POST returned HTTP 422: invalid machine config: env GH_TOKEN=\[REDACTED\] in file raw_value \[REDACTED\]$/);
        assert.ok(!error.message.includes(envSecret));
        assert.ok(!error.message.includes(token));
        return true;
    });
    assert.ok(posted?.config.files.some(f => f.guest_path === RUN + '/packages.json'), 'the rejected request carried the package install');
});

test('the full create body for a run with runtime packages satisfies the Machines file constraints', async () => {
    const api = new RecordingMachines();
    await assert.rejects(new FlyMachinesRuntime(api, env, async () => ['figlet', 'postgresql-client']).start(spec()).wait(), /recorded/);
    const launch = JSON.parse(JSON.stringify(api.launch)) as MachineLaunch;
    const files = launch.config.files;
    const install = files.find(f => f.guest_path === RUN + '/packages.json');
    assert.ok(install, 'the package install travels as a Machine file');
    assert.deepEqual(JSON.parse(Buffer.from(install.raw_value, 'base64').toString()).argv.slice(-2), ['figlet', 'postgresql-client']);
    // Same rule the control plane enforces: nothing under a path Fly mounts over after installing files.
    assert.doesNotThrow(() => validateContainerFilePaths([{ name: 'agent', files }]));
    const seen = new Set<string>();
    for (const file of files) {
        assert.deepEqual(Object.keys(file).sort(), ['guest_path', 'mode', 'raw_value']);
        assert.equal(file.guest_path, posix.normalize(file.guest_path), file.guest_path);
        assert.ok(posix.isAbsolute(file.guest_path), file.guest_path);
        assert.ok(!/^\/(?:run|proc|sys|dev)(?:\/|$)/.test(file.guest_path), file.guest_path + ' is under a path Fly init mounts');
        assert.ok(!seen.has(file.guest_path), 'duplicate guest_path ' + file.guest_path);
        seen.add(file.guest_path);
        assert.ok(Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777, `${file.guest_path} mode ${file.mode}`);
        assert.equal(typeof file.raw_value, 'string');
        assert.equal(Buffer.from(file.raw_value, 'base64').toString('base64'), file.raw_value, file.guest_path + ' raw_value is canonical base64');
    }
    // Nothing new outside files: no init, env, mounts or services, and the credential stays off the request.
    assert.deepEqual(Object.keys(launch.config).sort(), ['auto_destroy', 'files', 'guest', 'image', 'metadata', 'processes', 'restart']);
    assert.ok(!JSON.stringify(launch).includes(token));
});
