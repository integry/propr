import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MachineLaunch } from '../packages/core/src/agents/runtime/fly/api.ts';
import { test } from 'node:test';

const token = process.env.PROPR_FLY_LIVE_TOKEN;
const app = process.env.PROPR_FLY_LIVE_APP;
test('real Machines run a task as node and snapshot a stopped task before destruction', {
    skip: (!token || !app) && 'set PROPR_FLY_LIVE_TOKEN and PROPR_FLY_LIVE_APP', timeout: 10 * 60_000,
}, async t => {
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    t.after(closeConnection);
    const { FlyMachinesRuntime } = await import('../packages/core/src/agents/runtime/flyMachinesRuntime.ts');
    const { MachinesClient } = await import('../packages/core/src/agents/runtime/fly/api.ts');
    const { flyConfig } = await import('../packages/core/src/agents/runtime/fly/config.ts');
    const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
    const { buildAgentRunRepoSetup } = await import('../packages/core/src/claude/docker/repoSetupWrapper.ts');
    const { WORKSPACE_TRANSPORT_RESULT_DIR, WORKSPACE_TRANSPORT_SCRIPT } = await import('../packages/core/src/git/workspaceTransportScript.ts');

    const environment = { ...process.env, PROPR_FLY_API_TOKEN: token, PROPR_FLY_APP: app };
    const config = flyConfig(environment);
    // A tiny local Git bundle can be fetched but cannot accept a push.
    // Exercise the real clone and bundle-return paths without a GitHub account.
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-live-'));
    t.after(() => fs.rmSync(seed, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', ['-C', seed, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'base');
    git('-c', 'user.name=ProPR', '-c', 'user.email=test@propr.dev', 'commit', '-q', '--allow-empty', '-m', 'base');
    const baseCommit = git('rev-parse', 'HEAD').trim();
    const baseRef = 'refs/heads/base';
    const remote = '/opt/propr/test-base.bundle';
    git('bundle', 'create', 'base.bundle', baseRef);
    const fixture = fs.readFileSync(path.join(seed, 'base.bundle')).toString('base64');
    class FixtureClient extends MachinesClient {
        override create(launch: MachineLaunch) {
            launch.config.files.push({ guest_path: remote, mode: 0o644, raw_value: fixture });
            return super.create(launch);
        }
    }
    const api = new FixtureClient(config);
    const runtime = new FlyMachinesRuntime(api, environment);
    for (const provider of ['claude', 'codex'] as const) {
        const stop = provider === 'codex';
        const builder = new AgentRunSpecBuilder({
            name: 'live-' + provider, agentType: provider, stdin: true, user: '0:0', image: config.image, network: agentRunNetwork('bridge'),
            workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
                clone: { remote, baseRef, baseCommit, branch: 'task', resultRef: 'refs/heads/propr-live-result',
                    resultDir: WORKSPACE_TRANSPORT_RESULT_DIR, script: WORKSPACE_TRANSPORT_SCRIPT } },
        }).command('/bin/bash', '-ec', `
            test "$(id -un)" = node
            test -z "$PROPR_FLY_API_TOKEN$PROPR_FLY_LIVE_TOKEN$FLY_API_TOKEN$PROPR_WORKSPACE_GIT_TOKEN"
            ${provider} --version
            cat > live-task.txt
            test "$(cat live-task.txt)" = 'Fly task'
            touch /tmp/propr-task-ready
            ${stop ? 'exec sleep 180' : 'echo task-completed'}
        `);
        builder.spec.repoSetup = buildAgentRunRepoSetup(provider);
        const run = runtime.start(builder.build(), { timeout: 240_000, stdinData: 'Fly task\n' });
        try {
            if (stop) {
                const deadline = Date.now() + 150_000;
                let ready = false;
                while (Date.now() < deadline && await run.isAlive()) {
                    const { id } = await run.inspect();
                    if (id && (await api.exec(id, ['test', '-f', '/tmp/propr-task-ready']).catch(() => null))?.exit_code === 0) {
                        ready = true;
                        break;
                    }
                    await delay(1000);
                }
                assert.ok(ready, 'task reached its working phase');
                await run.stop('SIGTERM', 30_000);
            }
            const result = await run.wait();
            assert.equal(result.exitCode, stop ? 143 : 0, result.stderr);
            if (!stop) assert.match(result.stdout, /task-completed/);
            assert.match((await run.readFile!(WORKSPACE_TRANSPORT_RESULT_DIR + '/status'))!.toString(), /^bundle /);
            const bytes = await run.readFile!(WORKSPACE_TRANSPORT_RESULT_DIR + '/result.bundle');
            assert.ok(bytes?.subarray(0, 16).toString().includes('git bundle'));
            const { id } = await run.inspect();
            const response = await fetch(`https://api.machines.dev/v1/apps/${app}/machines/${id}`, {
                headers: { Authorization: token!.startsWith('FlyV1 ') ? token! : 'Bearer ' + token },
            });
            if (response.status !== 404) assert.equal((await response.json() as { state: string }).state, 'destroyed');
        } finally { await run.release!(); }
    }
});
