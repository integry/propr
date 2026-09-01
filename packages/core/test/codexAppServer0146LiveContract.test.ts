import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';

type RpcResponse = { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } };

function codexVersion(): string | undefined {
    try { return execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(); }
    catch { return undefined; }
}

test('generated and live Codex 0.146 contract accepts workspace-write and rejects workspaceWrite', async t => {
    const version = codexVersion();
    if (!version) return t.skip('codex binary is not installed in this validation environment');
    assert.equal(version, 'codex-cli 0.146.0');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-0146-contract-'));
    const generated = path.join(root, 'generated');
    const codexHome = path.join(root, 'home');
    fs.mkdirSync(codexHome, { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('codex', ['app-server', 'generate-ts', '--experimental', '--out', generated]);
    const sandbox = fs.readFileSync(path.join(generated, 'v2', 'SandboxMode.ts'), 'utf8');
    const source = fs.readFileSync(path.join(generated, 'v2', 'SessionSource.ts'), 'utf8');
    const response = fs.readFileSync(path.join(generated, 'v2', 'ThreadStartResponse.ts'), 'utf8');
    assert.match(sandbox, /"workspace-write"/);
    assert.doesNotMatch(sandbox, /"workspaceWrite"/);
    for (const variant of ['appServer', 'subAgent', 'custom', 'unknown']) assert.match(source, new RegExp(variant));
    for (const field of ['thread', 'modelProvider', 'runtimeWorkspaceRoots', 'instructionSources']) {
        assert.match(response, new RegExp(field));
    }

    const child = spawn('codex', ['app-server'], {
        cwd: process.cwd(), env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    const pending = new Map<number, (value: RpcResponse) => void>();
    readline.createInterface({ input: child.stdout }).on('line', line => {
        const value = JSON.parse(line) as RpcResponse;
        if (typeof value.id === 'number') pending.get(value.id)?.(value);
    });
    const request = (id: number, method: string, params: Record<string, unknown>): Promise<RpcResponse> => {
        const result = new Promise<RpcResponse>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`live ${method} timed out`)), 10_000);
            pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value); });
        });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        return result;
    };
    const initialized = await request(1, 'initialize', {
        clientInfo: { name: 'propr_goal_runtime', title: 'ProPR Goal Runtime', version: '0.146.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
    });
    assert.equal(initialized.result?.codexHome, codexHome);
    assert.match(String(initialized.result?.userAgent), /^propr_goal_runtime\/0\.146\.0 \(/);
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);

    const common = { model: 'gpt-5.6-sol', cwd: process.cwd(), approvalPolicy: 'never' };
    const rejected = await request(2, 'thread/start', { ...common, sandbox: 'workspaceWrite' });
    assert.equal(rejected.error?.code, -32600);
    const accepted = await request(3, 'thread/start', { ...common, sandbox: 'workspace-write' });
    assert.equal(accepted.error, undefined);
    assert.equal(typeof (accepted.result?.thread as Record<string, unknown>)?.id, 'string');
});
