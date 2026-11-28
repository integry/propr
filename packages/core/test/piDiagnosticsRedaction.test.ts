import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { nativeCredentialValues } from '../src/diagnostics/credentialRedaction.js';
import { ManagedLogSpool } from '../src/diagnostics/managedLogSpool.js';
import { collectProvider, nativeDirectoryAllowed, nativeFileClass } from '../src/diagnostics/providerCollector.js';
import { resolveProviderCredentialRoot } from '../src/diagnostics/providerRoots.js';

// The layout `pi auth login` writes: an API-key entry and an OAuth entry.
const piAuth = {
    openrouter: { type: 'api_key', key: 'sk-or-v1-pi-api-key-canary' },
    anthropic: { type: 'oauth', access: 'sk-ant-oat-pi-access-canary', refresh: 'sk-ant-ort-pi-refresh-canary', expires: 1798416000000 },
};
const customKey = 'opaque-provider-value-Zb37q';
const providerHeader = 'opaque-provider-header-Hp53c';
const modelHeader = 'opaque-model-header-Xm42n';
const overrideHeader = 'opaque-override-header-La86s';

function piHome() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-diagnostics-'));
    const home = path.join(root, '.pi', 'agent');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(piAuth, null, 2), { mode: 0o600 });
    return { root, home, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function writeModelConfig(home: string): void {
    const config = { providers: { custom: {
        baseUrl: 'https://endpoint.example.test/v1',
        api: 'openai-completions',
        apiKey: customKey,
        headers: { 'X-Provider-Secret': providerHeader },
        models: [{ id: 'custom-model', headers: { 'X-Model-Secret': modelHeader } }],
        modelOverrides: { standard: { headers: { 'X-Override-Secret': overrideHeader } } },
    } } };
    fs.writeFileSync(path.join(home, 'models.json'), `// User-managed Pi providers\n${JSON.stringify(config)}`, { mode: 0o600 });
}

function writeSession(home: string, text: string): void {
    const dir = path.join(home, 'sessions', '--home-operator-repo--');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-11-27T18-00-00-000Z_0b6e.jsonl'), `${JSON.stringify({ type: 'message', text })}\n`);
}

function exportText(spool: ManagedLogSpool): string {
    const exported: string[] = [];
    for (let item; (item = spool.exportOne());) {
        exported.push(gunzipSync(item.data).toString());
        spool.acknowledge(item.id, item.digest);
    }
    return exported.join('\n');
}

test('Pi auth.json API-key and OAuth entries are read for redaction', () => {
    const f = piHome();
    try {
        const values = nativeCredentialValues(f.home, 'pi');
        for (const secret of ['sk-or-v1-pi-api-key-canary', 'sk-ant-oat-pi-access-canary', 'sk-ant-ort-pi-refresh-canary']) {
            assert.ok(values.includes(secret), secret);
        }
        // Settings are outside the credential source allowlist.
        fs.writeFileSync(path.join(f.home, 'settings.json'), JSON.stringify({ theme: 'settings-value-not-a-secret' }));
        assert.ok(!nativeCredentialValues(f.home, 'pi').includes('settings-value-not-a-secret'));
    } finally { f.close(); }
});

test('a malformed Pi auth.json refuses collection instead of leaking credentials', () => {
    const f = piHome();
    try {
        fs.writeFileSync(path.join(f.home, 'auth.json'), '{"anthropic": {"access": "sk-ant-oat-truncated');
        assert.throws(() => nativeCredentialValues(f.home, 'pi'), /credential redaction unavailable/);
    } finally { f.close(); }
});

test('host Pi sessions redact credentials from auth.json and custom providers', () => {
    const f = piHome();
    const spool = new ManagedLogSpool(path.join(f.root, 'spool'), 'tenant-a');
    try {
        writeModelConfig(f.home);
        const secrets = [piAuth.anthropic.access, customKey, providerHeader, modelHeader, overrideHeader];
        writeSession(f.home, `session canary used ${secrets.join(' ')}`);
        assert.equal(nativeFileClass('pi', 'sessions/--home-operator-repo--/2026-11-27T18-00-00-000Z_0b6e.jsonl'), 'session');
        assert.equal(nativeFileClass('pi', 'auth.json'), 'auth-config');
        assert.equal(nativeFileClass('pi', 'models.json'), 'auth-config');
        assert.equal(nativeDirectoryAllowed('pi', 'sessions/--home-operator-repo--'), true);
        assert.equal(nativeDirectoryAllowed('pi', 'extensions'), false);

        assert.deepEqual(nativeCredentialValues(f.home, 'pi').filter(value => value.startsWith('opaque-')), secrets.slice(1));
        assert.ok(collectProvider(spool, { provider: 'pi', agent: 'pi-a', root: f.home, credentials: [], credentialContextComplete: true }));
        const text = exportText(spool);
        assert.match(text, /session canary used \[REDACTED\]/);
        for (const secret of secrets) assert.ok(!text.includes(secret));
        assert.ok(!text.includes('endpoint.example.test'));
    } finally { spool.close(); f.close(); }
});

test('unsafe Pi model credentials refuse collection and leave the session available for a safe retry', () => {
    const f = piHome();
    const spool = new ManagedLogSpool(path.join(f.root, 'spool'), 'tenant-a');
    const input = { provider: 'pi', agent: 'pi-a', root: f.home, credentials: [], credentialContextComplete: true } as const;
    const modelsPath = path.join(f.home, 'models.json');
    try {
        writeSession(f.home, `session canary used ${customKey}`);
        for (const content of ['{', ' '.repeat(64 * 1024 + 1), ...['!secret-command', 'prefix${CUSTOM_CREDENTIAL}', 'short'].map(apiKey =>
            JSON.stringify({ providers: { custom: { apiKey } } }))]) {
            fs.writeFileSync(modelsPath, content);
            assert.equal(collectProvider(spool, input), false);
            assert.doesNotMatch(exportText(spool), /session canary/);
        }
        fs.unlinkSync(modelsPath);
        fs.symlinkSync('missing-target', modelsPath);
        assert.equal(collectProvider(spool, input), false);
        fs.unlinkSync(modelsPath);
        writeModelConfig(f.home);
        assert.ok(collectProvider(spool, input));
        assert.match(exportText(spool), /session canary used \[REDACTED\]/);
    } finally { spool.close(); f.close(); }
});

test('managed Pi runtime capture redacts model credentials and refuses unresolved credentials', () => {
    const f = piHome();
    try {
        writeModelConfig(f.home);
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { gunzipSync } from 'node:zlib';
            import { managedDiagnostics, prepareProviderCapture } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            const root = ${JSON.stringify(f.home)};
            const agent = { provider: 'pi', agent: 'pi-a', configPath: root };
            const capture = prepareProviderCapture(agent);
            assert.ok(capture);
            capture.stdout.write(JSON.stringify({ type: 'tool_execution_end', output: 'runtime canary ' + ${JSON.stringify(customKey)} }) + '\\n');
            capture.stderr.write('Error: runtime canary ' + ${JSON.stringify(modelHeader)} + '\\n');
            capture.stdout.close();
            capture.stderr.close();
            const spool = managedDiagnostics();
            let exported = '';
            for (let item; (item = spool.exportOne());) {
                exported += gunzipSync(item.data).toString();
                spool.acknowledge(item.id, item.digest);
            }
            assert.equal(exported.match(/runtime canary \\[REDACTED\\]/g)?.length, 2);
            fs.writeFileSync(root + '/models.json', JSON.stringify({ providers: { custom: { apiKey: '!secret-command' } } }));
            assert.equal(prepareProviderCapture(agent), null);
            fs.unlinkSync(root + '/models.json');
            fs.writeFileSync(root + '/auth.json', JSON.stringify({ custom: { type: 'api_key', key: '$CUSTOM_KEY' } }));
            assert.equal(prepareProviderCapture(agent), null);
        `], {
            cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 20_000,
            env: { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: path.join(f.root, 'spool') },
        });
        assert.equal(result.status, 0, result.stderr);
    } finally { f.close(); }
});

test('Pi credential roots follow the launcher: default via PI_CONFIG_PATH/HOST_PI_DIR, managed accounts per agent', () => {
    assert.deepEqual(resolveProviderCredentialRoot({ provider: 'pi' }, { env: { HOME: '/home/operator' } }), { root: '/home/operator/.pi/agent', basis: 'configured' });
    const compose = { HOME: '/root', PROPR_CONTAINERIZED: '1', HOST_PI_DIR: '/home/desktop-user/.pi/agent', PROPR_MANAGED_CREDENTIALS_DIR: '/home/desktop-user/.propr/agent-credentials' };
    assert.equal(resolveProviderCredentialRoot({ provider: 'pi', configPath: '~/.pi/agent' }, { env: compose }).root, '/home/desktop-user/.pi/agent');
    assert.equal(resolveProviderCredentialRoot({ provider: 'pi', configPath: '~/.propr/agent-credentials/agent-a/.pi/agent' }, { env: compose }).root,
        '/home/desktop-user/.propr/agent-credentials/agent-a/.pi/agent');
    assert.deepEqual(resolveProviderCredentialRoot({ provider: 'pi' }, { env: { HOME: '/root', PROPR_CONTAINERIZED: '1' } }), { reason: 'unmapped-default-root' });
});
