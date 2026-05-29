#!/usr/bin/env node
// Propr launcher: replaces docker-compose for production deployments.
//
// Reads manifest.json for the pinned image tags, creates a user-defined docker
// network, pulls each image, runs the required containers with the right
// mounts/env/commands, and tears them down on SIGTERM/SIGINT.
//
// Runs INSIDE the propr/launcher container — uses the mounted docker socket
// to orchestrate sibling containers on the host's docker daemon.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, 'manifest.json'), 'utf8'));

const STACK   = process.env.PROPR_STACK || 'propr';
const NETWORK = process.env.PROPR_NETWORK || `${STACK}-net`;
// The launcher runs as a container and talks to the host docker daemon over
// the mounted socket. `docker run` has two kinds of path arguments:
//   --env-file PATH    resolved by the docker CLI (INSIDE launcher)
//   -v HOST:CONTAINER  resolved by the docker daemon (on HOST)
// So we need BOTH:
//   ENV_FILE_LOCAL   — path where the launcher itself can read the .env
//                      (used for --env-file on spawned containers)
//   ENV_FILE_HOST    — host path used when bind-mounting the .env into
//                      daemon/api containers at /usr/src/app/.env
// Same idea for data/logs/repos: the launcher never reads those paths, so
// only the host form is needed.
const ENV_FILE_LOCAL = process.env.PROPR_LAUNCHER_ENV_FILE || '/app/.env';
const ENV_FILE       = process.env.PROPR_ENV_FILE;
const HOST_DATA      = process.env.PROPR_DATA_DIR;
const HOST_LOGS      = process.env.PROPR_LOGS_DIR;
const HOST_REPOS     = process.env.PROPR_REPOS_DIR;
const API_PORT = process.env.API_PORT || '4000';
const UI_PORT = process.env.UI_PORT || '5173';
const DOCS_PORT = process.env.DOCS_PORT || '8080';
const REDIS_EXTERNAL_PORT = process.env.REDIS_EXTERNAL_PORT || '';
const DOCS_ENABLED = process.env.DOCS_ENABLED === 'true';

// Host paths for per-CLI credential directories. Launcher is in a container
// and can't read the host's $HOME, so the invoker must pass these in. The
// worker and api containers mount them so spawned agent containers can find
// the user's login state.
const HOST_CLAUDE_DIR = process.env.HOST_CLAUDE_DIR;
const HOST_CODEX_DIR  = process.env.HOST_CODEX_DIR;
const HOST_GEMINI_DIR = process.env.HOST_GEMINI_DIR;
const HOST_OPENCODE_DIR = process.env.HOST_OPENCODE_DIR;

// For each agent, mount the host credentials at the same path on both sides
// (HOST:HOST) and set *_CONFIG_PATH env vars to that path. When the worker/api
// then spawns an agent container, it passes -v <CONFIG_PATH>:/agent/path, and
// <CONFIG_PATH> resolves correctly on the host. Mounting at HOST:HOST keeps
// the paths identical end-to-end so the agent spawner doesn't need to do
// any path translation.
function agentCredentialArgs() {
    const args = [];
    if (HOST_CLAUDE_DIR) {
        args.push('-v', `${HOST_CLAUDE_DIR}:${HOST_CLAUDE_DIR}`);
        args.push('-e', `CLAUDE_CONFIG_PATH=${HOST_CLAUDE_DIR}`);
    }
    if (HOST_CODEX_DIR) {
        args.push('-v', `${HOST_CODEX_DIR}:${HOST_CODEX_DIR}`);
        args.push('-e', `CODEX_CONFIG_PATH=${HOST_CODEX_DIR}`);
    }
    if (HOST_GEMINI_DIR) {
        args.push('-v', `${HOST_GEMINI_DIR}:${HOST_GEMINI_DIR}`);
        args.push('-e', `GEMINI_CONFIG_PATH=${HOST_GEMINI_DIR}`);
    }
    if (HOST_OPENCODE_DIR) {
        args.push('-v', `${HOST_OPENCODE_DIR}:${HOST_OPENCODE_DIR}`);
        args.push('-e', `OPENCODE_CONFIG_PATH=${HOST_OPENCODE_DIR}`);
    }
    return args;
}

// Track containers we start so we can stop them on shutdown.
const runningContainers = new Set();

function docker(args, { capture = false } = {}) {
    const res = spawnSync('docker', args, {
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        encoding: 'utf8',
    });
    if (res.status !== 0 && !capture) {
        throw new Error(`docker ${args.join(' ')} failed with code ${res.status}`);
    }
    return res;
}

function dockerRunDetached(name, args) {
    const full = ['run', '-d', '--init', '--name', name, '--network', NETWORK, '--restart', 'unless-stopped', ...args];
    const res = docker(full, { capture: true });
    if (res.status !== 0) {
        throw new Error(`Failed to start ${name}: ${res.stderr}`);
    }
    runningContainers.add(name);
    console.log(`  ✓ started ${name}`);
}

function containerExists(name) {
    const res = docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'], { capture: true });
    return res.stdout.trim() === name;
}

function removeIfExists(name) {
    if (containerExists(name)) {
        console.log(`  · removing stale ${name}`);
        docker(['rm', '-f', name], { capture: true });
    }
}

function ensureNetwork() {
    const res = docker(['network', 'inspect', NETWORK], { capture: true });
    if (res.status !== 0) {
        console.log(`creating network ${NETWORK}`);
        docker(['network', 'create', NETWORK], { capture: true });
    }
}

function pullImages() {
    console.log('\npulling images…');
    for (const [key, tag] of Object.entries(manifest.images)) {
        // Skip agent images — workers pull them on demand.
        if (key.startsWith('agent-')) continue;
        if (key === 'docs' && !DOCS_ENABLED) continue;

        // If the image is already present locally, skip the pull — supports
        // development flow where images are built but not yet published.
        const local = docker(['images', '-q', tag], { capture: true });
        if (local.stdout.trim()) {
            console.log(`  · ${tag} (local)`);
            continue;
        }
        console.log(`  · ${tag}`);
        docker(['pull', tag]);
    }
}

function validateEnv() {
    const missing = [];
    if (!ENV_FILE)  missing.push('PROPR_ENV_FILE');
    if (!HOST_DATA) missing.push('PROPR_DATA_DIR');
    if (!HOST_LOGS) missing.push('PROPR_LOGS_DIR');
    if (!HOST_REPOS) missing.push('PROPR_REPOS_DIR');
    if (missing.length) {
        console.error(`ERROR: missing required env vars (must point at real host paths): ${missing.join(', ')}`);
        console.error('Example: -e PROPR_ENV_FILE=$PWD/.env -e PROPR_DATA_DIR=$PWD/data ...');
        process.exit(1);
    }
    if (!existsSync(ENV_FILE_LOCAL)) {
        console.error(`ERROR: launcher cannot read the env file at ${ENV_FILE_LOCAL}.`);
        console.error(`Mount your .env into the launcher too: -v ${ENV_FILE}:${ENV_FILE_LOCAL}:ro`);
        process.exit(1);
    }
}

function startRedis() {
    const name = `${STACK}-redis`;
    removeIfExists(name);
    // Redis only needs to be reachable from sibling containers, which happens
    // via the user-defined network. Host-publish only when REDIS_EXTERNAL_PORT
    // is set (and not "0"/"none") — e.g. for PR preview setups that share
    // sessions across host processes.
    const args = ['-v', `${STACK}-redis-data:/data`];
    if (REDIS_EXTERNAL_PORT && REDIS_EXTERNAL_PORT !== '0' && REDIS_EXTERNAL_PORT !== 'none') {
        args.unshift('-p', `${REDIS_EXTERNAL_PORT}:6379`);
    }
    args.push(manifest.images.redis);
    dockerRunDetached(name, args);
}

function appContainer(name, command, extraArgs = []) {
    const baseArgs = [
        // --env-file is resolved by the docker CLI (inside launcher container).
        '--env-file', ENV_FILE_LOCAL,
        '-v', `${HOST_LOGS}:/usr/src/app/logs`,
        '-v', `${HOST_DATA}:/usr/src/app/data`,
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '-v', '/tmp/git-processor:/tmp/git-processor',
        '--add-host', 'host.docker.internal:host-gateway',
        '-e', `REDIS_HOST=${STACK}-redis`,
    ];
    dockerRunDetached(name, [...baseArgs, ...extraArgs, manifest.images.app, 'node', ...command]);
}

function startApp() {
    removeIfExists(`${STACK}-daemon`);
    appContainer(`${STACK}-daemon`, ['dist/src/daemon.js'], [
        '-v', `${ENV_FILE}:/usr/src/app/.env:ro`,
        '-v', '/tmp/pr-worktrees:/tmp/pr-worktrees',
        '-e', `GITHUB_BOT_USERNAME=${process.env.GITHUB_BOT_USERNAME || 'propr.dev[bot]'}`,
        '-e', 'STAGING_ENV_FILE=/usr/src/app/.env',
    ]);

    const creds = agentCredentialArgs();

    removeIfExists(`${STACK}-worker`);
    appContainer(`${STACK}-worker`, ['dist/src/worker.js'], [
        '-v', `${HOST_REPOS}:/usr/src/app/repos`,
        '-v', '/tmp/claude-logs:/tmp/claude-logs',
        '--ulimit', 'nofile=65536:65536',
        ...creds,
    ]);

    removeIfExists(`${STACK}-analysis-worker`);
    appContainer(`${STACK}-analysis-worker`, ['dist/src/analysis_worker.js'], [...creds]);

    removeIfExists(`${STACK}-indexing-worker`);
    appContainer(`${STACK}-indexing-worker`, ['dist/src/indexing_worker.js'], [
        '-v', '/tmp/claude-logs:/tmp/claude-logs',
        '-e', `INDEXING_SCAN_INTERVAL_MS=${process.env.INDEXING_SCAN_INTERVAL_MS || '300000'}`,
        '-e', `INDEXING_REINDEX_INTERVAL_MS=${process.env.INDEXING_REINDEX_INTERVAL_MS || '86400000'}`,
        ...creds,
    ]);

    removeIfExists(`${STACK}-api`);
    appContainer(`${STACK}-api`, ['dist/packages/api/server.js'], [
        '-p', `${API_PORT}:4000`,
        '-v', `${ENV_FILE}:/usr/src/app/.env:ro`,
        '-v', '/tmp/pr-worktrees:/tmp/pr-worktrees',
        '--ulimit', 'nofile=65536:65536',
        ...creds,
        '-e', `API_PUBLIC_URL=${process.env.API_PUBLIC_URL || `http://localhost:${API_PORT}`}`,
        '-e', `FRONTEND_URL=${process.env.FRONTEND_URL || `http://localhost:${UI_PORT}`}`,
        '-e', `GH_OAUTH_CALLBACK_URL=${process.env.GH_OAUTH_CALLBACK_URL || `http://localhost:${API_PORT}/api/auth/github/callback`}`,
        '-e', 'SESSION_REDIS_HOST=' + `${STACK}-redis`,
        '-e', 'CONFIG_REPO_PATH=/tmp/config_repo',
    ]);
}

function startUI() {
    removeIfExists(`${STACK}-ui`);
    dockerRunDetached(`${STACK}-ui`, [
        '-p', `${UI_PORT}:5173`,
        manifest.images.ui,
    ]);
}

function startDocs() {
    if (!DOCS_ENABLED) return;
    removeIfExists(`${STACK}-docs`);
    dockerRunDetached(`${STACK}-docs`, [
        '-p', `${DOCS_PORT}:3000`,
        manifest.images.docs,
    ]);
}

function shutdown(code = 0) {
    console.log('\nshutting down…');
    for (const name of runningContainers) {
        try {
            docker(['stop', '-t', '10', name], { capture: true });
            docker(['rm', name], { capture: true });
            console.log(`  ✓ stopped ${name}`);
        } catch (e) {
            console.error(`  ! failed to stop ${name}: ${e.message}`);
        }
    }
    process.exit(code);
}

function streamLogs() {
    // `docker events` would be more correct, but tailing logs is simpler and
    // matches what users expect from `docker-compose up`.
    const names = [...runningContainers];
    for (const name of names) {
        const p = spawn('docker', ['logs', '-f', '--tail', '0', name], { stdio: 'inherit' });
        p.on('exit', () => {/* ignore — shutdown kills them */});
    }
}

async function main() {
    console.log(`propr launcher ${manifest.version}`);
    console.log(`  stack: ${STACK}`);
    console.log(`  network: ${NETWORK}`);
    console.log(`  env file: ${ENV_FILE}`);

    validateEnv();
    ensureNetwork();
    pullImages();

    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));

    console.log('\nstarting containers…');
    startRedis();
    startApp();
    startUI();
    startDocs();

    console.log(`\n✓ stack up. streaming logs… (Ctrl-C to stop)`);
    streamLogs();

    // Keep process alive until signal.
    await new Promise(() => {});
}

main().catch((e) => {
    console.error('launcher failed:', e.message);
    shutdown(1);
});
