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
import { readFileSync, existsSync, accessSync, constants as fsConstants } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
// worker and api containers mount them so the spawned claude/codex/gemini/opencode/vibe
// agent containers can find the user's login state.
// Each variable can be set as a launcher `-e` flag OR in the mounted .env file.
const HOST_CLAUDE_DIR = process.env.HOST_CLAUDE_DIR || envFileValue('HOST_CLAUDE_DIR') || undefined;
const HOST_CODEX_DIR  = process.env.HOST_CODEX_DIR  || envFileValue('HOST_CODEX_DIR')  || undefined;
const HOST_GEMINI_DIR = process.env.HOST_GEMINI_DIR || envFileValue('HOST_GEMINI_DIR') || undefined;
const HOST_OPENCODE_LEGACY_DIR = process.env.HOST_OPENCODE_LEGACY_DIR || envFileValue('HOST_OPENCODE_LEGACY_DIR') || undefined;
// HOST_OPENCODE_DIR is a compatibility alias for HOST_OPENCODE_XDG_DIR. Prefer
// HOST_OPENCODE_XDG_DIR in new deployments because it names the current
// OpenCode config location explicitly.
const HOST_OPENCODE_XDG_DIR = process.env.HOST_OPENCODE_XDG_DIR || process.env.HOST_OPENCODE_DIR || envFileValue('HOST_OPENCODE_XDG_DIR') || envFileValue('HOST_OPENCODE_DIR') || undefined;
const HOST_OPENCODE_DATA_DIR = process.env.HOST_OPENCODE_DATA_DIR || envFileValue('HOST_OPENCODE_DATA_DIR') || undefined;
const HOST_VIBE_DIR   = process.env.HOST_VIBE_DIR   || envFileValue('HOST_VIBE_DIR')   || undefined;

function envFileValue(name) {
    if (!existsSync(ENV_FILE_LOCAL)) return undefined;
    for (const rawLine of readFileSync(ENV_FILE_LOCAL, 'utf8').split(/\r?\n/)) {
        const parsed = parseEnvAssignment(rawLine);
        if (parsed?.name === name) {
            const value = parsed.value || undefined;
            if (value && /\$\{[A-Za-z_]/.test(value)) {
                console.warn(`WARNING: ${name} in .env contains a variable reference ("${value}") that will not be expanded. Use an absolute path instead.`);
            }
            return value;
        }
    }
    return undefined;
}

function parseEnvAssignment(rawLine) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return null;
    const assignment = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const equalsIndex = assignment.indexOf('=');
    if (equalsIndex <= 0) return null;

    const name = assignment.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;

    const valueSource = assignment.slice(equalsIndex + 1).trimStart();
    return { name, value: parseEnvValue(valueSource) };
}

function parseEnvValue(valueSource) {
    if (!valueSource) return '';
    const quote = valueSource[0];
    if (quote === '"' || quote === "'") {
        let value = '';
        for (let index = 1; index < valueSource.length; index += 1) {
            const char = valueSource[index];
            if (char === quote) return quote === '"' ? unescapeDoubleQuotedEnv(value) : value;
            if (quote === '"' && char === '\\' && index + 1 < valueSource.length) {
                value += char + valueSource[index + 1];
                index += 1;
            } else {
                value += char;
            }
        }
        return quote === '"' ? unescapeDoubleQuotedEnv(value) : value;
    }

    return valueSource.replace(/\s+#.*$/, '').trimEnd();
}

function unescapeDoubleQuotedEnv(value) {
    return value.replace(/\\([\\nrt"$`])/g, (_match, escaped) => {
        if (escaped === 'n') return '\n';
        if (escaped === 'r') return '\r';
        if (escaped === 't') return '\t';
        return escaped;
    });
}

const VIBE_PROMPT_CACHE_DIR = process.env.VIBE_PROMPT_CACHE_DIR
    || envFileValue('VIBE_PROMPT_CACHE_DIR')
    || '/tmp/propr-vibe-prompts';
// HOST_VIBE_PROMPT_CACHE_DIR must be an explicit host path; do not default to
// the container-side VIBE_PROMPT_CACHE_DIR because that path may not exist on
// the host.
const HOST_VIBE_PROMPT_CACHE_DIR = process.env.HOST_VIBE_PROMPT_CACHE_DIR
    || envFileValue('HOST_VIBE_PROMPT_CACHE_DIR')
    || undefined;

// For each agent, mount the host credentials at the same path on both sides
// (HOST:HOST) and set *_CONFIG_PATH env vars to that path. When the worker/api
// then spawns an agent container, it passes -v <CONFIG_PATH>:/agent/path, and
// <CONFIG_PATH> resolves correctly on the host. Mounting at HOST:HOST keeps
// the paths identical end-to-end so the agent spawner doesn't need to do
// any path translation.
export function agentCredentialArgs() {
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
    if (HOST_OPENCODE_LEGACY_DIR) {
        args.push('-v', `${HOST_OPENCODE_LEGACY_DIR}:${HOST_OPENCODE_LEGACY_DIR}`);
        args.push('-e', `OPENCODE_LEGACY_CONFIG_PATH=${HOST_OPENCODE_LEGACY_DIR}`);
    }
    if (HOST_OPENCODE_XDG_DIR) {
        args.push('-v', `${HOST_OPENCODE_XDG_DIR}:${HOST_OPENCODE_XDG_DIR}`);
        args.push('-e', `OPENCODE_CONFIG_PATH=${HOST_OPENCODE_XDG_DIR}`);
    } else if (HOST_OPENCODE_LEGACY_DIR) {
        args.push('-e', `OPENCODE_CONFIG_PATH=${HOST_OPENCODE_LEGACY_DIR}`);
    }
    if (HOST_OPENCODE_DATA_DIR) {
        args.push('-v', `${HOST_OPENCODE_DATA_DIR}:${HOST_OPENCODE_DATA_DIR}:rw`);
        args.push('-e', `HOST_OPENCODE_DATA_DIR=${HOST_OPENCODE_DATA_DIR}`);
    }
    if (HOST_VIBE_DIR) {
        args.push('-v', `${HOST_VIBE_DIR}:${HOST_VIBE_DIR}`);
        args.push('-e', `VIBE_CONFIG_PATH=${HOST_VIBE_DIR}`);
    }
    return args;
}

function vibePromptCacheArgs() {
    if (!HOST_VIBE_PROMPT_CACHE_DIR) return [];
    return [
        '-v', `${HOST_VIBE_PROMPT_CACHE_DIR}:${VIBE_PROMPT_CACHE_DIR}`,
        '-e', `VIBE_PROMPT_CACHE_DIR=${VIBE_PROMPT_CACHE_DIR}`,
        '-e', `HOST_VIBE_PROMPT_CACHE_DIR=${HOST_VIBE_PROMPT_CACHE_DIR}`,
        '-e', 'VIBE_PROMPT_CACHE_HOST_MOUNTED=1',
    ];
}

// Validates host bind-mount paths for Linux production deployments.
// The ':' rejection prevents malformed -v HOST:CONTAINER arguments on Linux;
// Windows-style drive paths (C:\...) are not supported by the launcher.
// NOTE: The launcher only supports Linux hosts. Docker Desktop (macOS/Windows)
// users should use docker-compose.yml directly instead of the launcher.
function validateDockerBindPath(name, value, { containerPath = false } = {}) {
    if (!value || !isAbsolute(value) || value.includes('~') || /[\0\r\n]/.test(value)) {
        return `${name} must be an absolute path without '~' or control characters (launcher requires Linux host paths)`;
    }
    if (!containerPath && value.includes(':')) {
        return `${name} cannot contain ':' because it is used in a Docker bind mount (launcher requires Linux — Windows-style paths like C:\\... are not supported)`;
    }
    return null;
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
    console.log(`  [ok] started ${name}`);
}

function latestTagFor(imageTag) {
    const slashIndex = imageTag.lastIndexOf('/');
    const tagIndex = imageTag.lastIndexOf(':');
    return tagIndex > slashIndex ? `${imageTag.slice(0, tagIndex)}:latest` : null;
}

function tagAgentLatest(key, imageTag) {
    if (!key.startsWith('agent-')) return;
    // Keep existing configs that reference propr/agent-*:latest working when
    // the launcher manifest pins exact agent image versions.
    const latestTag = latestTagFor(imageTag);
    if (!latestTag || latestTag === imageTag) return;
    const existing = docker(['images', '-q', latestTag], { capture: true });
    if (existing.stdout.trim()) {
        console.log(`  . retagging ${imageTag} -> ${latestTag} (overwriting existing local tag)`);
    }
    const res = docker(['tag', imageTag, latestTag], { capture: true });
    if (res.status !== 0) {
        throw new Error(`Failed to tag ${imageTag} as ${latestTag}: ${res.stderr}`);
    }
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
    const skipAgentPull = process.env.PROPR_SKIP_AGENT_PULL === 'true'
        || process.env.PROPR_SKIP_AGENT_PULL === '1';
    const strictAgentPull = process.env.PROPR_STRICT_AGENT_PULL !== 'false'
        && process.env.PROPR_STRICT_AGENT_PULL !== '0';
    console.log('\npulling images…');
    const failedAgentImages = [];
    for (const [key, tag] of Object.entries(manifest.images)) {
        if (key === 'docs' && !DOCS_ENABLED) continue;
        if (key.startsWith('agent-') && skipAgentPull) {
            const localImg = docker(['images', '-q', tag], { capture: true });
            if (localImg.stdout.trim()) {
                console.log(`  · ${tag} (local, pull skipped via PROPR_SKIP_AGENT_PULL)`);
                tagAgentLatest(key, tag);
            } else {
                console.log(`  · ${tag} (not found locally, pull skipped via PROPR_SKIP_AGENT_PULL)`);
            }
            continue;
        }

        // If the image is already present locally, skip the pull — supports
        // development flow where images are built but not yet published.
        const local = docker(['images', '-q', tag], { capture: true });
        if (local.stdout.trim()) {
            console.log(`  · ${tag} (local)`);
            tagAgentLatest(key, tag);
            continue;
        }
        console.log(`  · ${tag}`);
        const pulled = docker(['pull', tag], { capture: key.startsWith('agent-') });
        if (key.startsWith('agent-') && pulled.status !== 0) {
            failedAgentImages.push(tag);
            console.log(`  · ${tag} (pull failed — jobs using this agent will fail until the image is available)`);
            continue;
        }
        tagAgentLatest(key, tag);
    }
    if (failedAgentImages.length > 0) {
        if (strictAgentPull) {
            console.error(`\nERROR: ${failedAgentImages.length} agent image(s) could not be pulled (PROPR_STRICT_AGENT_PULL is enabled):`);
            for (const tag of failedAgentImages) {
                console.error(`    - ${tag}`);
            }
            console.error('  Build locally with scripts/build-images.sh or push to the registry.');
            console.error('  Set PROPR_STRICT_AGENT_PULL=false to allow startup without all agent images.\n');
            process.exit(1);
        }
        console.warn(`\nWARNING: ${failedAgentImages.length} agent image(s) could not be pulled (strict mode disabled):`);
        for (const tag of failedAgentImages) {
            console.warn(`    - ${tag}`);
        }
        console.warn('  Jobs using these agents will fail until images are available.');
        console.warn('  Build locally with scripts/build-images.sh or push to the registry.\n');
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
    const mistralApiKey = process.env.MISTRAL_API_KEY || envFileValue('MISTRAL_API_KEY');
    const vibeConfigPath = process.env.VIBE_CONFIG_PATH || envFileValue('VIBE_CONFIG_PATH');
    if (vibeConfigPath && !HOST_VIBE_DIR) {
        console.error(
            'ERROR: VIBE_CONFIG_PATH is set but HOST_VIBE_DIR is not. ' +
            'VIBE_CONFIG_PATH tells the worker where to find Vibe credentials inside the container, ' +
            'but HOST_VIBE_DIR is required to mount that directory from the host. ' +
            'Set HOST_VIBE_DIR to the host path of your .vibe directory ' +
            '(e.g. -e HOST_VIBE_DIR=/home/propr/.vibe).'
        );
        process.exit(1);
    }
    const vibeEnabled = !!(HOST_VIBE_DIR || mistralApiKey);
    if (vibeEnabled && !HOST_VIBE_PROMPT_CACHE_DIR) {
        const vibeSource = HOST_VIBE_DIR ? 'HOST_VIBE_DIR' : 'MISTRAL_API_KEY';
        console.error(
            'ERROR: Vibe support is enabled (via ' + vibeSource +
            ') but HOST_VIBE_PROMPT_CACHE_DIR is missing. ' +
            'Vibe agent containers need HOST_VIBE_PROMPT_CACHE_DIR to bind-mount prompt ' +
            'files via the host Docker daemon. Set it to a host-visible directory path ' +
            '(e.g. /tmp/propr-vibe-prompts).'
        );
        process.exit(1);
    }
    if (vibeEnabled || HOST_VIBE_PROMPT_CACHE_DIR) {
        const invalidVibePromptPath = validateDockerBindPath('HOST_VIBE_PROMPT_CACHE_DIR', HOST_VIBE_PROMPT_CACHE_DIR)
            || validateDockerBindPath('VIBE_PROMPT_CACHE_DIR', VIBE_PROMPT_CACHE_DIR, { containerPath: true });
        if (invalidVibePromptPath) {
            console.error(`ERROR: ${invalidVibePromptPath}`);
            process.exit(1);
        }
        if (!existsSync(HOST_VIBE_PROMPT_CACHE_DIR)) {
            console.error(
                `ERROR: HOST_VIBE_PROMPT_CACHE_DIR (${HOST_VIBE_PROMPT_CACHE_DIR}) does not exist. ` +
                'Create it before starting the launcher: ' +
                `mkdir -p ${HOST_VIBE_PROMPT_CACHE_DIR}`
            );
            process.exit(1);
        }
        try {
            accessSync(HOST_VIBE_PROMPT_CACHE_DIR, fsConstants.W_OK);
        } catch {
            console.error(
                `ERROR: HOST_VIBE_PROMPT_CACHE_DIR (${HOST_VIBE_PROMPT_CACHE_DIR}) is not writable. ` +
                'Ensure the directory is owned by the user running the worker.'
            );
            process.exit(1);
        }
    }
    const credentialDirs = [
        ['HOST_CLAUDE_DIR', HOST_CLAUDE_DIR],
        ['HOST_CODEX_DIR', HOST_CODEX_DIR],
        ['HOST_GEMINI_DIR', HOST_GEMINI_DIR],
        ['HOST_OPENCODE_LEGACY_DIR', HOST_OPENCODE_LEGACY_DIR],
        ['HOST_OPENCODE_XDG_DIR', HOST_OPENCODE_XDG_DIR],
        ['HOST_OPENCODE_DATA_DIR', HOST_OPENCODE_DATA_DIR],
        ['HOST_VIBE_DIR', HOST_VIBE_DIR],
    ];
    const invalidCredentialPath = credentialDirs
        .map(([name, value]) => value ? validateDockerBindPath(name, value) : null).find(Boolean);
    if (invalidCredentialPath) {
        console.error(`ERROR: ${invalidCredentialPath}`);
        process.exit(1);
    }
    warnAboutOpenCodeCredentialPaths();
}

function warnAboutOpenCodeCredentialPaths() {
    const hasOpenCodeConfig = Boolean(HOST_OPENCODE_XDG_DIR || HOST_OPENCODE_LEGACY_DIR);
    if (hasOpenCodeConfig && !HOST_OPENCODE_DATA_DIR) {
        console.warn(
            'WARNING: OpenCode config is mounted but HOST_OPENCODE_DATA_DIR is not set. ' +
            'OpenCode login state is usually stored under ~/.local/share/opencode; ' +
            'set HOST_OPENCODE_DATA_DIR to that host path if authenticated runs cannot see credentials.'
        );
    }
    for (const [name, value] of [
        ['HOST_OPENCODE_XDG_DIR', HOST_OPENCODE_XDG_DIR],
        ['HOST_OPENCODE_LEGACY_DIR', HOST_OPENCODE_LEGACY_DIR],
        ['HOST_OPENCODE_DATA_DIR', HOST_OPENCODE_DATA_DIR],
    ]) {
        if (value && !existsSync(value)) {
            console.warn(
                `WARNING: ${name} (${value}) is not visible inside the launcher container. ` +
                'If this path is missing on the Docker host, Docker may create an empty root-owned bind-mount directory.'
            );
        }
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
    const vibePrompts = vibePromptCacheArgs();

    removeIfExists(`${STACK}-worker`);
    appContainer(`${STACK}-worker`, ['dist/src/worker.js'], [
        '-v', `${HOST_REPOS}:/usr/src/app/repos`,
        '-v', '/tmp/claude-logs:/tmp/claude-logs',
        '--ulimit', 'nofile=65536:65536',
        ...vibePrompts,
        ...creds,
    ]);

    removeIfExists(`${STACK}-analysis-worker`);
    appContainer(`${STACK}-analysis-worker`, ['dist/src/analysis_worker.js'], [
        ...vibePrompts,
        ...creds,
    ]);

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
        ...vibePrompts,
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
            console.log(`  [ok] stopped ${name}`);
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

    console.log(`\n[ok] stack up. streaming logs... (Ctrl-C to stop)`);
    streamLogs();

    // Keep process alive until signal.
    await new Promise(() => {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => {
        console.error('launcher failed:', e.message);
        shutdown(1);
    });
}
