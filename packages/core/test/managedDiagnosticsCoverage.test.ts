import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProviderCredentialRoot } from '../src/diagnostics/providerRoots.js';
import { resolveCodexConfigPath, resolveConfigPath } from '../src/config/agentConfigPaths.js';
import { classifyTextLine, redactRecord, CONTINUATION_LINE_LIMIT } from '../src/diagnostics/redaction.js';
import { openCodeEnvVarRejection } from '../src/agents/impl/openCodeEnvForwarding.js';

const repository = path.resolve(import.meta.dirname, '../../..');
const providers = ['codex', 'claude', 'antigravity', 'opencode', 'vibe'] as const;
const nativeHome = (root: string) => ({
    codex: path.join(root, '.codex'), claude: path.join(root, '.claude'), antigravity: path.join(root, '.gemini'),
    opencode: path.join(root, '.local/share/opencode'), vibe: path.join(root, '.vibe'),
});
/** Runs `script` with managed diagnostics enabled and returns its JSON stdout. */
function run(root: string, script: string, env: Record<string, string | undefined> = {}) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import fs from 'node:fs';
        import { gunzipSync } from 'node:zlib';
        import * as runtime from './packages/core/src/diagnostics/managedLogRuntime.ts';
        const exported = () => {
            const db = runtime.managedDiagnostics(), records = [];
            for (let item; (item = db.exportOne());) {
                records.push(...gunzipSync(item.data).toString().trim().split('\\n').map(line => JSON.parse(line)));
                db.acknowledge(item.id, item.digest);
            }
            return records;
        };
        const sources = () => runtime.managedDiagnostics().status().sources;
        ${script}`], {
        cwd: repository, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, PROPR_DEMO_MODE: 'true', PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a',
            PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool'), HOME: root, CODEX_CONFIG_PATH: '', HOST_CODEX_DIR: '', CLAUDE_CONFIG_PATH: '',
            HOST_CLAUDE_DIR: '', ANTIGRAVITY_CONFIG_PATH: '', HOST_ANTIGRAVITY_DIR: '', VIBE_CONFIG_PATH: '', HOST_VIBE_DIR: '',
            OPENCODE_CONFIG_PATH: '', HOST_OPENCODE_XDG_DIR: '', HOST_OPENCODE_DATA_DIR: '', PROPR_MANAGED_CREDENTIALS_DIR: '',
            // Native fixtures: provider defaults expand against HOME, whatever host runs the suite.
            PROPR_CONTAINERIZED: '0', ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}

test('native installs resolve every provider default root without launcher-only HOST_* variables', () => {
    const env = { HOME: '/home/operator' };
    const expected = nativeHome('/home/operator');
    for (const provider of providers) {
        assert.deepEqual(resolveProviderCredentialRoot({ provider }, { env }), { root: expected[provider], basis: 'configured' }, provider);
    }
    // The same resolver the launchers mount from, not a parallel convention.
    assert.equal(resolveProviderCredentialRoot({ provider: 'codex', configPath: '~/.codex' }, { env }).root, resolveCodexConfigPath('~/.codex', env));
    assert.equal(resolveProviderCredentialRoot({ provider: 'claude', configPath: '~/work/.claude' }, { env }).root, resolveConfigPath('~/work/.claude', env));
    // Configured absolute roots are used as configured.
    assert.equal(resolveProviderCredentialRoot({ provider: 'claude', configPath: '/srv/claude-b' }, { env }).root, '/srv/claude-b');
    assert.equal(resolveProviderCredentialRoot({ provider: 'opencode', configPath: '/srv/b/.config/opencode' }, { env }).root, '/srv/b/.local/share/opencode');
});

test('Compose and hosted installs resolve configured and managed roots consistently', () => {
    const host = '/home/desktop-user';
    const compose = { HOME: '/root', PROPR_CONTAINERIZED: '1', CODEX_CONFIG_PATH: `${host}/.codex`, ANTIGRAVITY_CONFIG_PATH: `${host}/.gemini`,
        VIBE_CONFIG_PATH: `${host}/.vibe`, HOST_OPENCODE_DATA_DIR: `${host}/.local/share/opencode`, PROPR_MANAGED_CREDENTIALS_DIR: `${host}/.propr/agent-credentials` };
    assert.equal(resolveProviderCredentialRoot({ provider: 'codex' }, { env: compose }).root, `${host}/.codex`);
    assert.equal(resolveProviderCredentialRoot({ provider: 'claude', configPath: `${host}/.claude` }, { env: compose }).root, `${host}/.claude`);
    assert.equal(resolveProviderCredentialRoot({ provider: 'antigravity', configPath: '/saved/root' }, { env: compose }).root, `${host}/.gemini`);
    assert.equal(resolveProviderCredentialRoot({ provider: 'vibe', configPath: '~/.vibe' }, { env: compose }).root, `${host}/.vibe`);
    assert.equal(resolveProviderCredentialRoot({ provider: 'opencode' }, { env: compose }).root, `${host}/.local/share/opencode`);
    for (const [provider, suffix, root] of [['codex', '.codex', '.codex'], ['claude', '.claude', '.claude'], ['antigravity', '.gemini', '.gemini'],
        ['opencode', '.config/opencode', '.local/share/opencode']] as const) {
        const configPath = `~/.propr/agent-credentials/agent-a/${suffix}`;
        // Hosted/Compose: the managed directory; native: HOME/.propr, as the launcher resolves it.
        assert.equal(resolveProviderCredentialRoot({ provider, configPath }, { env: compose }).root, `${host}/.propr/agent-credentials/agent-a/${root}`, provider);
        assert.equal(resolveProviderCredentialRoot({ provider, configPath }, { env: { HOME: '/home/operator' } }).root,
            `/home/operator/.propr/agent-credentials/agent-a/${root}`, provider);
    }
    // A launcher-computed mount source always wins.
    assert.equal(resolveProviderCredentialRoot({ provider: 'vibe', authenticationRoot: '/run/vibe-home' }, { env: compose }).root, '/run/vibe-home');
});

test('Compose Claude default resolves to the mounted CLAUDE_CONFIG_PATH/HOST_CLAUDE_DIR, never the worker HOME', () => {
    const host = '/home/desktop-user';
    const env = { HOME: '/root', PROPR_CONTAINERIZED: '1', CLAUDE_CONFIG_PATH: `${host}/.claude`, PROPR_MANAGED_CREDENTIALS_DIR: `${host}/.propr/agent-credentials` };
    for (const configPath of [undefined, '~/.claude', '~/.claude/']) {
        assert.deepEqual(resolveProviderCredentialRoot({ provider: 'claude', configPath }, { env }), { root: `${host}/.claude`, basis: 'configured' }, String(configPath));
    }
    assert.equal(resolveProviderCredentialRoot({ provider: 'claude' }, { env: { ...env, CLAUDE_CONFIG_PATH: '', HOST_CLAUDE_DIR: `${host}/claude-b` } }).root, `${host}/claude-b`);
    // Managed, custom and absolute paths keep their own per-agent meaning.
    assert.equal(resolveProviderCredentialRoot({ provider: 'claude', configPath: '~/.propr/agent-credentials/agent-a/.claude' }, { env }).root,
        `${host}/.propr/agent-credentials/agent-a/.claude`);
    assert.equal(resolveProviderCredentialRoot({ provider: 'claude', configPath: '/srv/claude-b' }, { env }).root, '/srv/claude-b');
    assert.equal(resolveProviderCredentialRoot({ provider: 'claude', configPath: '~/work/.claude' }, { env }).root, '/root/work/.claude');
    assert.deepEqual(resolveProviderCredentialRoot({ provider: 'claude' }, { env: { ...env, CLAUDE_CONFIG_PATH: 'relative/.claude' } }), { reason: 'relative-root' });
});

test('Compose Claude capture and daemon inventory use the mounted default root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-compose-claude-'));
    try {
        // The worker HOME has no .claude; only the host directory is mounted.
        const mounted = path.join(root, 'host', '.claude');
        fs.mkdirSync(mounted, { recursive: true });
        fs.writeFileSync(path.join(mounted, '.credentials.json'), JSON.stringify({ access_token: 'opaque-compose-store-canary' }));
        const result = run(root, `
            const capture = runtime.prepareProviderCapture({ provider: 'claude', agent: 'compose', configPath: '~/.claude' });
            capture?.stdout.write('INFO opaque-compose-store-canary\\n'); capture?.stdout.close(); capture?.stderr.close();
            console.log(JSON.stringify({ capture: Boolean(capture), inventory: runtime.providerCredentialRoot({ provider: 'claude', agent: 'compose', configPath: '~/.claude' }), records: exported() }));
        `, { CLAUDE_CONFIG_PATH: mounted });
        assert.equal(result.capture, true);
        assert.equal(result.inventory, mounted);
        assert.deepEqual(result.records.filter((r: { message?: string }) => r.message), [{ message: 'INFO [REDACTED]' }]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unresolvable provider roots refuse with explicit reasons and no credential read', () => {
    const containerized = { HOME: '/root', PROPR_CONTAINERIZED: '1' };
    assert.deepEqual(resolveProviderCredentialRoot({ provider: 'codex' }, { env: containerized }), { reason: 'unmapped-default-root' });
    assert.deepEqual(resolveProviderCredentialRoot({ provider: 'claude', configPath: 'relative/.claude' }, { env: containerized }), { reason: 'relative-root' });
    assert.deepEqual(resolveProviderCredentialRoot({ provider: 'opencode', configPath: '/srv/opencode' }, { env: containerized }), { reason: 'no-mounted-auth-store' });
    assert.deepEqual(resolveProviderCredentialRoot({ provider: 'unknown' }, { env: containerized }), { reason: 'unsupported-provider' });
});

test('OpenCode refuses only when the launcher would forward XDG_DATA_HOME and skip the data mount', () => {
    const env = { HOME: '/home/operator' };
    // The launcher reserves XDG_DATA_HOME and still mounts the inferred sibling.
    assert.equal(openCodeEnvVarRejection('XDG_DATA_HOME', '/data'), 'reserved');
    for (const configPath of [undefined, '/srv/b/.config/opencode']) {
        const plain = resolveProviderCredentialRoot({ provider: 'opencode', configPath }, { env });
        assert.ok(plain.root);
        assert.deepEqual(resolveProviderCredentialRoot({ provider: 'opencode', configPath, credentials: { XDG_DATA_HOME: '/data' } }, { env }), plain);
    }
    // Other refusals are unchanged by an unforwarded XDG_DATA_HOME.
    assert.deepEqual(resolveProviderCredentialRoot({ provider: 'opencode', configPath: '/srv/opencode', credentials: { XDG_DATA_HOME: '/data' } }, { env }), { reason: 'no-mounted-auth-store' });
});

test('native fixtures capture with a verified credential context or refuse with an explicit reason', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-native-roots-'));
    try {
        const homes = nativeHome(root);
        const stores = { codex: 'auth.json', claude: '.credentials.json', antigravity: 'oauth_creds.json', opencode: 'auth.json', vibe: 'credentials.json' };
        for (const provider of providers) {
            fs.mkdirSync(homes[provider], { recursive: true });
            fs.writeFileSync(path.join(homes[provider], stores[provider]), JSON.stringify({ access_token: `opaque-${provider}-store-canary` }));
        }
        const result = run(root, `
            const outcomes = {};
            for (const provider of ${JSON.stringify(providers)}) {
                // Codex's containerized default refusal depends on /.dockerenv; its
                // default resolution is covered with an explicit environment above.
                const capture = runtime.prepareProviderCapture({ provider, agent: provider, ...(provider === 'codex' ? { configPath: ${JSON.stringify(path.join('ROOT', '.codex'))}.replace('ROOT', process.env.HOME) } : {}) });
                outcomes[provider] = Boolean(capture);
                capture?.stdout.write('INFO ' + 'opaque-' + provider + '-store-canary\\n'); capture?.stdout.close(); capture?.stderr.close();
            }
            fs.rmSync(${JSON.stringify(homes.claude)}, { recursive: true });
            outcomes.missing = Boolean(runtime.prepareProviderCapture({ provider: 'claude', agent: 'missing' }));
            const reasons = Object.fromEntries(sources().filter(s => s.source === 'capture').map(s => [s.agent, s.reason]));
            console.log(JSON.stringify({ outcomes, reasons, records: exported() }));
        `);
        for (const provider of providers) assert.equal(result.outcomes[provider], true, provider);
        assert.equal(result.outcomes.missing, false);
        assert.equal(result.reasons.missing, 'credential-root:missing');
        const text = JSON.stringify(result.records);
        for (const provider of providers) assert.ok(!text.includes(`opaque-${provider}-store-canary`), provider);
        assert.equal(result.records.filter((r: { message?: string }) => r.message === 'INFO [REDACTED]').length, providers.length);

        const refused = run(root, `
            const capture = runtime.prepareProviderCapture({ provider: 'codex', agent: 'unmapped' });
            console.log(JSON.stringify({ capture: Boolean(capture), reason: sources().find(s => s.agent === 'unmapped')?.reason }));
        `, { PROPR_CONTAINERIZED: '1' });
        assert.deepEqual(refused, { capture: false, reason: 'credential-root:unmapped-default-root' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stdout/stderr capture has deterministic safe outcomes for tails, stacks, Docker errors and unsafe lines', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-output-'));
    try {
        fs.mkdirSync(path.join(root, '.claude'));
        const result = run(root, `
            const capture = runtime.prepareProviderCapture({ provider: 'claude', agent: 'output', credentials: { RUN_TOKEN: 'opaque-run-canary-1' } });
            const stderr = capture.stderr, stdout = capture.stdout;
            stderr.write("docker: Error response from daemon: pull access denied for opaque-run-canary-1.\\nSee 'docker run --help'.\\n");
            stderr.write('TypeError: boom opaque-run-canary-1\\n    at run (/app/a.js:1:2)\\n');
            stderr.write('    at main (/app/b.js:3:4)\\r\\n    at {"token":"structured-canary"}\\n');
            stderr.write('plain unprefixed text\\n    at orphan (/app/c.js:5:6)\\n');
            stderr.write('{"token": "malformed-canary"\\n');
            stderr.write('INFO bell \\x07 control\\n');
            stderr.write('ERROR head\\n' + Array.from({ length: ${CONTINUATION_LINE_LIMIT + 2} }, (_, n) => '    at frame' + n + ' (/app/d.js:1:1)\\n').join(''));
            // A head rejected as unsafe-record opens no window, within or across writes.
            stderr.write('Error: bell \\x07 head\\n    at rejected (/app/e.js:1:1)\\n');
            stderr.write('TypeError: bell \\x07 head\\n');
            stderr.write('    at rejected (/app/f.js:1:1)\\n');
            stderr.write('INFO ' + 'x'.repeat(70000) + '\\n');
            stderr.write('INFO final unterminated opaque-run-canary-1');
            stderr.close();
            stdout.write('INFO ' + 'y'.repeat(70000));
            stdout.close();
            const status = Object.fromEntries(sources().filter(s => s.agent === 'output').map(s => [s.source, { gaps: s.gaps, dropped: s.droppedBytes }]));
            console.log(JSON.stringify({ records: exported(), status }));
        `);
        const records: Array<{ message?: string; continuation?: string }> = result.records;
        const text = JSON.stringify(records);
        for (const canary of ['opaque-run-canary-1', 'structured-canary', 'malformed-canary']) assert.ok(!text.includes(canary), canary);
        assert.deepEqual(records.slice(0, 5), [
            { message: 'docker: Error response from daemon: pull access denied for [REDACTED].' },
            { message: "See 'docker run --help'." },
            { message: 'TypeError: boom [REDACTED]' },
            { continuation: '    at run (/app/a.js:1:2)' },
            { continuation: '    at main (/app/b.js:3:4)' },
        ]);
        // Orphaned frames, structured frames, malformed JSON and control characters are gaps.
        assert.ok(!text.includes('orphan') && !text.includes('plain unprefixed') && !text.includes('bell'));
        const frames = records.filter(r => r.continuation?.includes('/app/d.js'));
        assert.equal(frames.length, CONTINUATION_LINE_LIMIT, 'one head carries a bounded window');
        assert.ok(!text.includes('rejected'), 'frames of a rejected head are not exported as orphans');
        assert.ok(!text.includes('x'.repeat(100)) && !text.includes('y'.repeat(100)), 'oversized lines never export');
        assert.equal(records.at(-1)!.message, 'INFO final unterminated [REDACTED]', 'a bounded final line without newline is a record');
        assert.ok(result.status.stderr.gaps >= 11, JSON.stringify(result.status));
        assert.ok(result.status.stdout.gaps >= 1 && result.status.stdout.dropped >= 70000, 'an oversized unterminated tail is a gap');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('continuation records cannot carry structured or auth data past redaction', () => {
    assert.equal(redactRecord('    at {"token":"x"}', 'text', [], { continuation: true }), null);
    assert.equal(redactRecord('    token: ', 'text', [], { continuation: true }), null);
    assert.equal(redactRecord('    free indented text', 'text', [], { continuation: true }), null);
    assert.equal(redactRecord('    at run (/app/a.js:1:2)', 'text', []), null, 'native files never carry continuations');
    // Native files share head recognition: Docker/exception heads are single-line records.
    assert.equal(redactRecord('TypeError: boom opaque-native-canary', 'text', ['opaque-native-canary']), JSON.stringify({ message: 'TypeError: boom [REDACTED]' }) + '\n');
    assert.equal(redactRecord("Error response from daemon: token=opaque-daemon-value", 'text', []), JSON.stringify({ message: 'Error response from daemon: token=[REDACTED]' }) + '\n');
    assert.equal(redactRecord('    at f (https://user:opaque-pass@host/x.js:1:1)', 'text', [], { continuation: true }),
        JSON.stringify({ continuation: '    at f (https://[REDACTED]@host/x.js:1:1)' }) + '\n');
    let window = classifyTextLine('Traceback (most recent call last):', 0).window;
    const frame = classifyTextLine('  File "/app/main.py", line 3, in <module>', window);
    assert.equal(frame.continuation, true);
    window = classifyTextLine('unrelated', frame.window).window;
    assert.equal(classifyTextLine('    at x (/a.js:1:1)', window).continuation, false, 'any other line closes the window');
});

test('post-policy environment arguments are discovered and redacted from exported data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-post-policy-'));
    try {
        fs.mkdirSync(path.join(root, '.claude'));
        const canaries = ['opaque-equals-canary', 'opaque-attached-canary', 'opaque-inherited-canary', 'opaque-proxy-canary', 'opaque-mcp-canary', 'opaque-final-canary',
            'opaque-userinfo-canary'];
        const result = run(root, `
            const create = ['run', '--env=RUN_TOKEN=${canaries[0]}', '-eAPI_KEY=${canaries[1]}', '-e', 'INHERITED_SECRET',
                '-e', 'GIT_CONFIG_VALUE_0=http://propr:${canaries[3]}@proxy:8080', '-e', 'MCP_CONFIG={"servers":{"x":{"headers":{"Authorization":"Bearer ${canaries[4]}"}}}}',
                '-e', 'UPSTREAM=http://${canaries[6]}:@proxy:8080', '--network', 'none', '--entrypoint', '/bin/bash', 'image', '-c', 'agent'];
            const final = ['start', '--attach', '--interactive', 'container', '--env', 'SESSION_SECRET=${canaries[5]}'];
            const capture = runtime.prepareProviderCapture({ provider: 'claude', agent: 'policy' }, final, { INHERITED_SECRET: '${canaries[2]}' }, create);
            capture.stdout.write(${JSON.stringify(canaries.map(c => `INFO leaked ${c}`).join('\n') + '\n')});
            capture.stdout.close(); capture.stderr.close();
            console.log(JSON.stringify({ records: exported() }));
        `);
        const text = JSON.stringify(result.records);
        assert.equal(result.records.length, canaries.length);
        for (const canary of canaries) assert.ok(!text.includes(canary), canary);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
