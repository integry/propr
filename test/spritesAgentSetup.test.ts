import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Runs the Sprite setup script's functions with real bash against a fake
// Sprite layout: the script defines them and returns when it is sourced.
const SETUP_SCRIPT = path.resolve(import.meta.dirname, '../scripts/sprites-agent-setup.sh');

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'propr-sprites-setup-'));
}

function writeExecutable(file: string, body: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** A PATH holding only symlinks to the given system tools, so node is absent. */
function toolPath(root: string, tools: string[]): string {
    const dir = path.join(root, 'system-bin');
    fs.mkdirSync(dir, { recursive: true });
    for (const tool of tools) {
        const resolved = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
        fs.symlinkSync(resolved, path.join(dir, tool));
    }
    return dir;
}

function runSourced(script: string, env: Record<string, string>): string {
    return execFileSync('/bin/bash', ['-c', `set -euo pipefail; source "$SETUP_SCRIPT"; ${script}`], {
        encoding: 'utf8', env: { SETUP_SCRIPT, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** Fake Sprite: an nvm shim in /.sprite/bin whose real bin dir holds node, npm and npx. */
function fakeSpriteNode(root: string) {
    const realDir = path.join(root, '.sprite/languages/node/nvm/versions/node/v24.0.0/bin');
    for (const bin of ['node', 'npm', 'npx']) writeExecutable(path.join(realDir, bin), `echo "${bin} from nvm"`);
    const shim = path.join(root, '.sprite/bin/node');
    writeExecutable(shim, `[ "$1" = "-p" ] && [ "$2" = "process.execPath" ] && { echo "${realDir}/node"; exit 0; }\nexit 2`);
    const target = path.join(root, 'usr-local-bin');
    fs.mkdirSync(target);
    return { realDir, shim, target };
}

const SHELL_TOOLS = ['dirname', 'ln', 'head', 'grep', 'cat'];

test('Sprite setup links node, npm and npx from the nvm shim when root has no node on PATH', () => {
    const root = tempDir();
    try {
        const { realDir, shim, target } = fakeSpriteNode(root);
        const PATH = `${target}:${toolPath(root, SHELL_TOOLS)}`;
        assert.equal(runSourced('command -v node || echo missing', { PATH }).trim(), 'missing');

        const output = runSourced(`link_sprite_node "${shim}" "${target}"; command -v node; node; npm; npx`, { PATH });
        assert.deepEqual(output.trim().split('\n'), [path.join(target, 'node'), 'node from nvm', 'npm from nvm', 'npx from nvm']);
        for (const bin of ['node', 'npm', 'npx']) assert.equal(fs.readlinkSync(path.join(target, bin)), path.join(realDir, bin));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Sprite setup leaves an existing node alone and links nothing without a shim', () => {
    const root = tempDir();
    try {
        const { shim, target } = fakeSpriteNode(root);
        const systemBin = toolPath(root, SHELL_TOOLS);
        writeExecutable(path.join(root, 'existing/node'), 'echo existing');
        runSourced(`link_sprite_node "${shim}" "${target}"`, { PATH: `${target}:${path.join(root, 'existing')}:${systemBin}` });
        assert.deepEqual(fs.readdirSync(target), []);

        runSourced(`link_sprite_node "${path.join(root, 'no-such-shim')}" "${target}"`, { PATH: `${target}:${systemBin}` });
        assert.deepEqual(fs.readdirSync(target), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Sprite setup allows the pinned package install scripts (npm 12 blocks them otherwise)', () => {
    const root = tempDir();
    try {
        const npmPrefix = path.join(root, 'npm');
        const binDir = path.join(root, 'bin');
        fs.mkdirSync(binDir);
        const argsLog = path.join(root, 'npm-args');
        // The fake npm records its arguments and installs a claude that reports the pinned version.
        writeExecutable(path.join(root, 'fake-bin/npm'), [
            `printf '%s\\n' "$@" > "${argsLog}"`,
            `mkdir -p "${npmPrefix}/bin"`,
            `printf '#!/bin/sh\\necho "2.1.330 (Claude Code)"\\n' > "${npmPrefix}/bin/claude"`,
            `chmod 755 "${npmPrefix}/bin/claude"`,
        ].join('\n'));
        const PATH = `${path.join(root, 'fake-bin')}:${toolPath(root, [...SHELL_TOOLS, 'printf', 'mkdir', 'chmod'])}`;

        runSourced(`npm_prefix="${npmPrefix}"; bin_dir="${binDir}"; pin_npm_cli @anthropic-ai/claude-code 2.1.330 claude`, { PATH });
        const args = fs.readFileSync(argsLog, 'utf8').trim().split('\n');
        assert.ok(args.includes('--allow-scripts=@anthropic-ai/claude-code'), `npm args: ${args.join(' ')}`);
        assert.ok(args.includes('@anthropic-ai/claude-code@2.1.330'));
        assert.deepEqual(args.slice(args.indexOf('--prefix'), args.indexOf('--prefix') + 2), ['--prefix', npmPrefix]);
        assert.equal(fs.readlinkSync(path.join(binDir, 'claude')), path.join(npmPrefix, 'bin/claude'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

/**
 * The setpriv shim the setup installs on a Sprite without su-exec or gosu, with
 * a setpriv stand-in that (like setpriv) changes ids but passes HOME through:
 * the test user cannot change ids, so only the environment contract is exercised.
 */
function privilegeShimPath(root: string): string {
    const bin = path.join(root, 'shim-bin');
    fs.mkdirSync(bin, { recursive: true });
    writeExecutable(path.join(bin, 'setpriv'), 'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift; exec "$@"');
    runSourced(`write_privilege_shim "${path.join(bin, 'su-exec')}"`, { PATH: toolPath(root, ['cat', 'chmod']) });
    return `${bin}:${toolPath(root, ['id', 'getent', 'cut', 'env', 'git', 'sh', 'printf'])}`;
}

const testUser = () => execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
const testUserHome = () => execFileSync('getent', ['passwd', testUser()], { encoding: 'utf8' }).trim().split(':')[5];

test('the setpriv privilege shim sets HOME to the target user\'s home, as su-exec and gosu do', () => {
    const root = tempDir();
    try {
        const PATH = privilegeShimPath(root);
        const home = runSourced(`su-exec "${testUser()}" sh -c 'printf "%s" "$HOME"'`, { PATH, HOME: '/root' });
        assert.equal(home, testUserHome());
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Sprite setup writes the agent git configuration to the agent home through the shim, never to the inherited root HOME', () => {
    const root = tempDir();
    const rootHome = path.join(root, 'root-home');
    const agentHome = path.join(root, 'agent-home');
    fs.mkdirSync(rootHome);
    fs.mkdirSync(agentHome);
    fs.chmodSync(rootHome, 0o555); // root's home: the dropped user cannot write there
    try {
        const PATH = privilegeShimPath(root);
        // The shim alone would pick the user's passwd home, so this also proves the explicit HOME wins.
        runSourced(`configure_agent_git "${testUser()}" "${agentHome}"`, { PATH, HOME: rootHome, GIT_CONFIG_NOSYSTEM: '1' });
        const config = (key: string) => execFileSync('git', ['config', '--file', path.join(agentHome, '.gitconfig'), '--get-all', key], { encoding: 'utf8' }).trim();
        assert.equal(config('user.name'), 'ProPR Agent Bot');
        assert.equal(config('user.email'), 'agent-bot@propr.dev');
        assert.equal(config('init.defaultBranch'), 'main');
        assert.equal(config('safe.directory'), '*');
        assert.deepEqual(fs.readdirSync(rootHome), []);
    } finally {
        fs.chmodSync(rootHome, 0o755);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
