/**
 * The run sshd's configuration under a real OpenSSH sshd (skipped when none is
 * installed; point PROPR_TEST_SSHD at one to run it). sshd runs unprivileged
 * here, so it admits only the current user: the test rewrites `AllowUsers`,
 * and everything else is the configuration a Sprite gets.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ssh2 from 'ssh2';
import { SpritesMcpForward } from '../packages/core/src/agents/runtime/sprites/spritesMcpForward.ts';
import {
    SPRITES_MCP_FORWARD_PORT, SPRITES_MCP_FORWARD_SCRIPT, SPRITES_MCP_FORWARD_USER, SPRITES_MCP_SSHD_PORT, spritesMcpAuthorizedKey, spritesMcpSshdConfig,
} from '../packages/core/src/agents/runtime/sprites/spritesMcpForwardConfig.ts';
import { FakeSprite } from './helpers/fakeSprites.ts';

const sshdPath = [process.env.PROPR_TEST_SSHD, '/usr/sbin/sshd'].find(candidate => candidate && spawnSync(candidate, ['-V']).error === undefined
    && /OpenSSH/.test(spawnSync(candidate, ['-V'], { encoding: 'utf8' }).stderr));
const skip = !sshdPath && 'OpenSSH sshd is not installed (set PROPR_TEST_SSHD)';
const me = os.userInfo().username;
// StrictModes refuses keys below a world-writable directory such as /tmp (a Sprite uses root-owned /run).
const root = fs.mkdtempSync(path.join(os.homedir(), '.propr-mcp-sshd-'));
let api: http.Server;
let apiPort = 0;
const daemons = new Set<ChildProcess>();

before(async () => {
    api = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${req.method} ${req.url} ${req.headers.authorization}\n\n`);
        setTimeout(() => res.end('data: done\n\n'), 20);
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', () => resolve()));
    apiPort = (api.address() as net.AddressInfo).port;
});
after(() => {
    for (const daemon of daemons) daemon.kill('SIGKILL');
    api?.closeAllConnections();
    api?.close();
    fs.rmSync(root, { recursive: true, force: true });
});

/** Start sshd from a run directory holding the files the forward uploads. */
async function startSshd(dir: string): Promise<ChildProcess> {
    const configPath = path.join(dir, 'sshd_config');
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace(`AllowUsers ${SPRITES_MCP_FORWARD_USER}`, `AllowUsers ${me}`));
    fs.chmodSync(path.join(dir, 'host_key'), 0o600);
    fs.chmodSync(path.join(dir, 'authorized_keys'), 0o600);
    const check = spawnSync(sshdPath!, ['-t', '-f', configPath], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const daemon = spawn(sshdPath!, ['-D', '-e', ...(process.env.PROPR_TEST_SSHD_DEBUG ? ['-d'] : []), '-f', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    daemons.add(daemon);
    daemon.once('exit', () => daemons.delete(daemon));
    let log = '';
    daemon.stderr!.on('data', chunk => { log += chunk; if (process.env.PROPR_TEST_SSHD_DEBUG) process.stderr.write(chunk); });
    for (let attempt = 0; attempt < 100; attempt++) {
        if (log.includes('Server listening')) return daemon;
        if (daemon.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`sshd did not start: ${log}`);
}

function stopSshd(daemon: ChildProcess) {
    return new Promise<void>(resolve => { if (daemon.exitCode !== null) resolve(); else { daemon.once('exit', () => resolve()); daemon.kill(); } });
}

function runDir(name: string) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { mode: 0o755 });
    return dir;
}

function connect(key: string, options: Partial<ssh2.ConnectConfig> = {}): Promise<ssh2.Client> {
    return new Promise((resolve, reject) => {
        const client = new ssh2.Client();
        client.once('ready', () => resolve(client));
        client.once('error', reject);
        client.connect({ host: '127.0.0.1', port: SPRITES_MCP_SSHD_PORT, username: me, privateKey: key, readyTimeout: 5000, ...options });
    });
}

test('real sshd: loopback only, key only, and nothing but the one remote listener', { skip }, async () => {
    const dir = runDir('security');
    const host = ssh2.utils.generateKeyPairSync('ed25519');
    const key = ssh2.utils.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(dir, 'host_key'), host.private);
    fs.writeFileSync(path.join(dir, 'authorized_keys'), spritesMcpAuthorizedKey(key.public));
    fs.writeFileSync(path.join(dir, 'sshd_config'), spritesMcpSshdConfig(dir));
    const daemon = await startSshd(dir);
    try {
        // Bound to loopback: no other local address reaches it.
        const external = Object.values(os.networkInterfaces()).flat().find(address => address && address.family === 'IPv4' && !address.internal);
        if (external) {
            await assert.rejects(new Promise((resolve, reject) => {
                const socket = net.connect(SPRITES_MCP_SSHD_PORT, external.address, () => { socket.destroy(); resolve(undefined); });
                socket.once('error', reject);
            }), /ECONNREFUSED/);
        }
        // Another key, a password or keyboard-interactive login are all refused.
        await assert.rejects(connect(ssh2.utils.generateKeyPairSync('ed25519').private), /authentication methods failed|Too many authentication failures/);
        await assert.rejects(connect(undefined as never, { password: 'x', tryKeyboard: true }), /authentication methods failed|Too many authentication failures/);
        const client = await connect(key.private);
        try {
            const forwardIn = (address: string, port: number) => new Promise<void>((resolve, reject) => client.forwardIn(address, port, error => error ? reject(error) : resolve()));
            await assert.rejects(forwardIn('0.0.0.0', SPRITES_MCP_FORWARD_PORT), 'no listener on other addresses');
            await assert.rejects(forwardIn('127.0.0.1', SPRITES_MCP_FORWARD_PORT + 1), 'no listener on other ports');
            await assert.rejects(new Promise<void>((resolve, reject) => client.forwardOut('127.0.0.1', 0, '127.0.0.1', apiPort, error => error ? reject(error) : resolve())),
                'no local (-L) forwarding into the Sprite');
            await assert.rejects(new Promise<void>((resolve, reject) => client.exec('id', (error, stream) => {
                if (error) return reject(error);
                stream.once('close', (code: number | null) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
            })), 'no sessions or commands');
            await forwardIn('127.0.0.1', SPRITES_MCP_FORWARD_PORT);
        } finally { client.end(); }
    } finally { await stopSshd(daemon); }
});

test('real sshd: the forward carries streamed MCP responses through the proxy, reconnects and tears down', { skip }, async () => {
    const dir = runDir('forward');
    const sprite = new FakeSprite('real-sshd');
    let daemon: ChildProcess | undefined;
    let proxied = 0;
    const startFiles = sprite.execFile.bind(sprite);
    sprite.execFile = async (cmd: string, args: string[], options?: { signal?: AbortSignal }) => {
        if (cmd !== 'sudo' || args[1] !== SPRITES_MCP_FORWARD_SCRIPT) return startFiles(cmd, args, options);
        if (args[2] === 'start') {
            for (const name of ['host_key', 'authorized_keys']) fs.writeFileSync(path.join(dir, name), sprite.files.get(`${args[3]}/${name}`)!);
            const config = sprite.files.get(`${args[3]}/sshd_config`)!.toString();
            assert.equal(config, spritesMcpSshdConfig('/run/propr-mcp-forward'));
            fs.writeFileSync(path.join(dir, 'sshd_config'), config.replaceAll('/run/propr-mcp-forward', dir));
            daemon = await startSshd(dir);
        } else if (daemon) await stopSshd(daemon);
        return { exitCode: 0, stdout: '', stderr: '' };
    };
    // Like the Sprites API proxy: a local listener whose connections reach 127.0.0.1:<sshd port> in the Sprite.
    const sockets = new Set<net.Socket>();
    Object.assign(sprite, {
        proxyPort: async (_local: number, remote: number, remoteHost: string) => {
            proxied++;
            const server = net.createServer(socket => {
                const upstream = net.connect(remote, remoteHost);
                sockets.add(socket).add(upstream);
                socket.pipe(upstream).pipe(socket);
                socket.on('error', () => upstream.destroy());
                upstream.on('error', () => socket.destroy());
            });
            await new Promise<void>(resolve => server.listen(0, 'localhost', () => resolve()));
            return Object.assign(new EventEmitter(), {
                localAddr: () => `localhost:${(server.address() as net.AddressInfo).port}`,
                close: () => server.close(),
            });
        },
    });
    const call = () => new Promise<string>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: SPRITES_MCP_FORWARD_PORT, path: '/api/mcp', headers: { Authorization: 'Bearer grant' } }, res => {
            let body = '';
            res.setEncoding('utf8').on('data', chunk => { body += chunk; }).on('end', () => resolve(body));
        }).on('error', reject);
    });
    const forward = await SpritesMcpForward.start({
        sprite: sprite as never, user: me, signal: AbortSignal.timeout(30_000), onLost: () => assert.fail('lost'), retryDelayMs: 50,
        target: { protocol: 'http:', host: '127.0.0.1', port: apiPort, url: `http://127.0.0.1:${SPRITES_MCP_FORWARD_PORT}/api/mcp` },
    });
    try {
        assert.equal(await call(), 'data: GET /api/mcp Bearer grant\n\ndata: done\n\n');
        for (const socket of sockets) socket.destroy();
        for (let attempt = 0; forward.connections < 2 && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(forward.connections, 2);
        assert.equal(await call(), 'data: GET /api/mcp Bearer grant\n\ndata: done\n\n');
        assert.ok(proxied >= 2);
    } finally { await forward.close(); }
    assert.equal(daemon?.exitCode !== null || daemon?.signalCode !== null, true, 'the run sshd is stopped');
    // The per-connection sshd child closes the listener as the connection ends.
    let refused = '';
    for (let attempt = 0; attempt < 100 && !refused.includes('ECONNREFUSED'); attempt++) {
        refused = await call().then(() => '', (error: Error) => error.message);
        if (!refused.includes('ECONNREFUSED')) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(refused, /ECONNREFUSED/);
});
