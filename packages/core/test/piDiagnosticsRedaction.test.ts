import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function piHome() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-diagnostics-'));
    const home = path.join(root, '.pi', 'agent');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(piAuth, null, 2), { mode: 0o600 });
    return { root, home, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Pi auth.json API-key and OAuth entries are read for redaction', () => {
    const f = piHome();
    try {
        const values = nativeCredentialValues(f.home, 'pi');
        for (const secret of ['sk-or-v1-pi-api-key-canary', 'sk-ant-oat-pi-access-canary', 'sk-ant-ort-pi-refresh-canary']) {
            assert.ok(values.includes(secret), secret);
        }
        // Only auth.json is read: other files in the agent dir are never opened.
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

test('host Pi sessions are collected with auth.json values redacted; credential files are never exported', () => {
    const f = piHome();
    const spool = new ManagedLogSpool(path.join(f.root, 'spool'), 'tenant-a');
    try {
        const sessionDir = path.join(f.home, 'sessions', '--home-operator-repo--');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, '2026-11-27T18-00-00-000Z_0b6e.jsonl'),
            `${JSON.stringify({ type: 'message', text: 'used sk-ant-oat-pi-access-canary' })}\n`);
        assert.equal(nativeFileClass('pi', 'sessions/--home-operator-repo--/2026-11-27T18-00-00-000Z_0b6e.jsonl'), 'session');
        assert.equal(nativeFileClass('pi', 'auth.json'), 'auth-config');
        assert.equal(nativeDirectoryAllowed('pi', 'sessions/--home-operator-repo--'), true);
        assert.equal(nativeDirectoryAllowed('pi', 'extensions'), false);

        const credentials = nativeCredentialValues(f.home, 'pi');
        collectProvider(spool, { provider: 'pi', agent: 'pi-a', root: f.home, credentials, credentialContextComplete: true });
        const exported: string[] = [];
        for (let item; (item = spool.exportOne());) {
            exported.push(gunzipSync(item.data).toString());
            spool.acknowledge(item.id, item.digest);
        }
        const text = exported.join('\n');
        for (const secret of ['sk-or-v1-pi-api-key-canary', 'sk-ant-oat-pi-access-canary', 'sk-ant-ort-pi-refresh-canary']) {
            assert.ok(!text.includes(secret), secret);
        }
    } finally { spool.close(); f.close(); }
});

test('Pi credential roots follow the launcher: default via PI_CONFIG_PATH/HOST_PI_DIR, managed accounts per agent', () => {
    assert.deepEqual(resolveProviderCredentialRoot({ provider: 'pi' }, { env: { HOME: '/home/operator' } }), { root: '/home/operator/.pi/agent', basis: 'configured' });
    const compose = { HOME: '/root', PROPR_CONTAINERIZED: '1', HOST_PI_DIR: '/home/desktop-user/.pi/agent', PROPR_MANAGED_CREDENTIALS_DIR: '/home/desktop-user/.propr/agent-credentials' };
    assert.equal(resolveProviderCredentialRoot({ provider: 'pi', configPath: '~/.pi/agent' }, { env: compose }).root, '/home/desktop-user/.pi/agent');
    assert.equal(resolveProviderCredentialRoot({ provider: 'pi', configPath: '~/.propr/agent-credentials/agent-a/.pi/agent' }, { env: compose }).root,
        '/home/desktop-user/.propr/agent-credentials/agent-a/.pi/agent');
    assert.deepEqual(resolveProviderCredentialRoot({ provider: 'pi' }, { env: { HOME: '/root', PROPR_CONTAINERIZED: '1' } }), { reason: 'unmapped-default-root' });
});
