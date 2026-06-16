// Propr stack orchestrator — shared, dependency-free core.
//
// This module contains all the logic for running the Propr stack as sibling
// containers via raw `docker run` against a docker daemon. It is consumed by
// TWO callers:
//
//   1. docker/launcher/entrypoint.mjs — runs INSIDE the propr/launcher
//      container, talking to the host daemon over a mounted socket. Paths come
//      in as bind-mounted host paths (PROPR_*_DIR), and the launcher reads the
//      .env from a separate local path (PROPR_LAUNCHER_ENV_FILE / /app/.env).
//
//   2. packages/cli — runs natively ON THE HOST. Here the "local" path and the
//      "host" path for the env file collapse to the same thing, and data/logs/
//      repos live under a single root dir. resolveHostConfig() captures that.
//
// Pure Node stdlib only (child_process, fs, path, url) so the launcher image
// needs no npm install and the CLI can import it without a transpile step.
// The CLI imports this .mjs dynamically and types it via src/orchestrator/types.ts.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// True only for an existing regular file (guards against a path that exists but
// is a directory, which would make readFileSync throw EISDIR).
function isReadableFile(path) {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// .env file parsing (parameterized by the file path so it works for both the
// launcher's local env file and the host's <root>/.env)
// ---------------------------------------------------------------------------

export function parseEnvAssignment(rawLine) {
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

export function parseEnvValue(valueSource) {
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

// Reads a single value from an env file. Re-reads the file per call (matches the
// original launcher behavior; call sites are few and startup-only).
function envFileValueFrom(envFileLocal, name) {
    if (!envFileLocal || !isReadableFile(envFileLocal)) return undefined;
    for (const rawLine of readFileSync(envFileLocal, 'utf8').split(/\r?\n/)) {
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

/**
 * Parse every assignment from an env file into a plain object. Used by the CLI
 * `check`/`init` commands to inspect HOST_*_DIR settings without re-reading.
 */
export function readEnvFile(envFilePath) {
    const out = {};
    if (!envFilePath || !isReadableFile(envFilePath)) return out;
    for (const rawLine of readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
        const parsed = parseEnvAssignment(rawLine);
        if (parsed) out[parsed.name] = parsed.value;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a stack config from an environment + overrides. Works for both the
 * containerized launcher (paths are bind-mounted host paths) and the host CLI
 * (paths are real local dirs). `overrides` lets the CLI inject host-derived
 * paths without needing env vars.
 */
export function resolveConfig(env = process.env, overrides = {}) {
    const stack = overrides.stack ?? env.PROPR_STACK ?? 'propr';
    const network = overrides.network ?? env.PROPR_NETWORK ?? `${stack}-net`;
    const envFileLocal = overrides.envFileLocal ?? env.PROPR_LAUNCHER_ENV_FILE ?? '/app/.env';
    const envFileHost = overrides.envFileHost ?? env.PROPR_ENV_FILE;

    // value precedence: explicit override → process env → .env file
    const get = (name) => env[name] !== undefined ? env[name] : envFileValueFrom(envFileLocal, name) || undefined;

    const hostData = overrides.hostData ?? env.PROPR_DATA_DIR;
    const hostLogs = overrides.hostLogs ?? env.PROPR_LOGS_DIR;
    const hostRepos = overrides.hostRepos ?? env.PROPR_REPOS_DIR;

    const apiPort = overrides.apiPort ?? get('API_PORT') ?? '4000';
    const uiPort = overrides.uiPort ?? get('UI_PORT') ?? '5173';
    const docsPort = overrides.docsPort ?? get('DOCS_PORT') ?? '8080';
    const redisExternalPort = overrides.redisExternalPort ?? get('REDIS_EXTERNAL_PORT') ?? '';
    const docsEnabled = overrides.docsEnabled ?? (get('DOCS_ENABLED') === 'true');

    // Agent credential host dirs (HOST:HOST mounts so spawned agent containers
    // resolve the same path end-to-end). HOST_OPENCODE_DIR is a back-compat alias.
    const hostClaudeDir = get('HOST_CLAUDE_DIR');
    const hostCodexDir = get('HOST_CODEX_DIR');
    const hostAntigravityDir = get('HOST_ANTIGRAVITY_DIR');
    const hostOpencodeLegacyDir = get('HOST_OPENCODE_LEGACY_DIR');
    const hostOpencodeXdgDir = env.HOST_OPENCODE_XDG_DIR !== undefined ? env.HOST_OPENCODE_XDG_DIR
        : env.HOST_OPENCODE_DIR !== undefined ? env.HOST_OPENCODE_DIR
            : envFileValueFrom(envFileLocal, 'HOST_OPENCODE_XDG_DIR')
            || envFileValueFrom(envFileLocal, 'HOST_OPENCODE_DIR') || undefined;
    const hostOpencodeDataDir = get('HOST_OPENCODE_DATA_DIR');
    const hostVibeDir = get('HOST_VIBE_DIR');

    const vibePromptCacheDir = get('VIBE_PROMPT_CACHE_DIR') || '/tmp/propr-vibe-prompts';
    const hostVibePromptCacheDir = get('HOST_VIBE_PROMPT_CACHE_DIR');

    // Host path to the GitHub App private key (.pem). When set, the key is
    // bind-mounted into the app containers (HOST:HOST, read-only) and
    // GH_PRIVATE_KEY_PATH is overridden to that path so the daemon/worker can
    // read it without the user having to stage it under data/.
    const hostGhPrivateKey = get('HOST_GH_PRIVATE_KEY');

    const manifestPath = overrides.manifestPath ?? resolve(__dirname, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    return Object.freeze({
        stack, network, envFileLocal, envFileHost,
        validateHostPaths: overrides.validateHostPaths === true,
        hostData, hostLogs, hostRepos,
        apiPort, uiPort, docsPort, redisExternalPort, docsEnabled,
        hostClaudeDir, hostCodexDir, hostAntigravityDir,
        hostOpencodeLegacyDir, hostOpencodeXdgDir, hostOpencodeDataDir,
        hostVibeDir, vibePromptCacheDir, hostVibePromptCacheDir,
        hostGhPrivateKey,
        // misc -e overrides the launcher computed from ports/env
        apiPublicUrl: get('API_PUBLIC_URL') || `http://localhost:${apiPort}`,
        frontendUrl: get('FRONTEND_URL') || `http://localhost:${uiPort}`,
        ghOauthCallbackUrl: get('GH_OAUTH_CALLBACK_URL') || `http://localhost:${apiPort}/api/auth/github/callback`,
        githubBotUsername: get('GITHUB_BOT_USERNAME') || 'propr.dev[bot]',
        indexingScanInterval: get('INDEXING_SCAN_INTERVAL_MS') || '300000',
        indexingReindexInterval: get('INDEXING_REINDEX_INTERVAL_MS') || '86400000',
        mistralApiKey: get('MISTRAL_API_KEY'),
        vibeConfigPath: get('VIBE_CONFIG_PATH'),
        manifest, images: manifest.images, manifestPath,
    });
}

/**
 * Host CLI convenience: env file, data, logs and repos all live under a single
 * root dir; the local path IS the host path (no container indirection).
 * `cliOverrides` lets the CLI pass in persisted config (e.g. docsEnabled from
 * ConfigManager) that should take precedence over env/defaults.
 */
export function resolveHostConfig({ rootDir = process.cwd(), env = process.env, manifestPath, cliOverrides = {} } = {}) {
    return resolveConfig(env, {
        envFileLocal: join(rootDir, '.env'),
        envFileHost: join(rootDir, '.env'),
        hostData: join(rootDir, 'data'),
        hostLogs: join(rootDir, 'logs'),
        hostRepos: join(rootDir, 'repos'),
        validateHostPaths: true,
        manifestPath,
        ...cliOverrides,
    });
}

// ---------------------------------------------------------------------------
// docker arg builders
// ---------------------------------------------------------------------------

// Mount host credentials at the same path on both sides (HOST:HOST) and set the
// *_CONFIG_PATH env vars to that path, so the worker/api can re-mount them into
// agent containers without any path translation.
function agentCredentialArgs(cfg, { opencodeDataReadWrite = false } = {}) {
    const args = [];
    if (cfg.hostClaudeDir) {
        args.push('-v', `${cfg.hostClaudeDir}:${cfg.hostClaudeDir}`);
        args.push('-e', `CLAUDE_CONFIG_PATH=${cfg.hostClaudeDir}`);
    }
    if (cfg.hostCodexDir) {
        args.push('-v', `${cfg.hostCodexDir}:${cfg.hostCodexDir}`);
        args.push('-e', `CODEX_CONFIG_PATH=${cfg.hostCodexDir}`);
    }
    if (cfg.hostAntigravityDir) {
        args.push('-v', `${cfg.hostAntigravityDir}:${cfg.hostAntigravityDir}`);
        args.push('-e', `ANTIGRAVITY_CONFIG_PATH=${cfg.hostAntigravityDir}`);
    }
    if (cfg.hostOpencodeLegacyDir) {
        args.push('-v', `${cfg.hostOpencodeLegacyDir}:${cfg.hostOpencodeLegacyDir}`);
        args.push('-e', `OPENCODE_LEGACY_CONFIG_PATH=${cfg.hostOpencodeLegacyDir}`);
    }
    if (cfg.hostOpencodeXdgDir) {
        args.push('-v', `${cfg.hostOpencodeXdgDir}:${cfg.hostOpencodeXdgDir}`);
        args.push('-e', `OPENCODE_CONFIG_PATH=${cfg.hostOpencodeXdgDir}`);
    } else if (cfg.hostOpencodeLegacyDir) {
        args.push('-e', `OPENCODE_CONFIG_PATH=${cfg.hostOpencodeLegacyDir}`);
    }
    if (cfg.hostOpencodeDataDir) {
        const dataMode = opencodeDataReadWrite ? 'rw' : 'ro';
        args.push('-v', `${cfg.hostOpencodeDataDir}:${cfg.hostOpencodeDataDir}:${dataMode}`);
        args.push('-e', `HOST_OPENCODE_DATA_DIR=${cfg.hostOpencodeDataDir}`);
    }
    if (cfg.hostVibeDir) {
        args.push('-v', `${cfg.hostVibeDir}:${cfg.hostVibeDir}`);
        args.push('-e', `VIBE_CONFIG_PATH=${cfg.hostVibeDir}`);
    }
    return args;
}

// Bind-mount the GitHub App private key into app containers (read-only) and
// point GH_PRIVATE_KEY_PATH at the mounted path. Mounting HOST:HOST keeps the
// path identical inside and out so GH_PRIVATE_KEY_PATH is a real, resolvable
// path for the daemon/worker.
function githubKeyArgs(cfg) {
    if (!cfg.hostGhPrivateKey) return [];
    return [
        '-v', `${cfg.hostGhPrivateKey}:${cfg.hostGhPrivateKey}:ro`,
        '-e', `GH_PRIVATE_KEY_PATH=${cfg.hostGhPrivateKey}`,
    ];
}

function vibePromptCacheArgs(cfg) {
    if (!cfg.hostVibePromptCacheDir) return [];
    return [
        '-v', `${cfg.hostVibePromptCacheDir}:${cfg.vibePromptCacheDir}`,
        '-e', `VIBE_PROMPT_CACHE_DIR=${cfg.vibePromptCacheDir}`,
        '-e', `HOST_VIBE_PROMPT_CACHE_DIR=${cfg.hostVibePromptCacheDir}`,
        '-e', 'VIBE_PROMPT_CACHE_HOST_MOUNTED=1',
    ];
}

// Validates host bind-mount paths for Linux deployments. ':' rejection prevents
// malformed -v HOST:CONTAINER args; Windows drive paths (C:\...) are unsupported.
export function validateDockerBindPath(name, value, { containerPath = false } = {}) {
    if (!value || !isAbsolute(value) || value.includes('~') || /[\0\r\n]/.test(value)) {
        return `${name} must be an absolute path without '~' or control characters (requires Linux host paths)`;
    }
    if (!containerPath && value.includes(':')) {
        return `${name} cannot contain ':' because it is used in a Docker bind mount (requires Linux — Windows-style paths like C:\\... are not supported)`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// docker exec helpers
// ---------------------------------------------------------------------------

export function docker(args, { capture = false } = {}) {
    const res = spawnSync('docker', args, {
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        encoding: 'utf8',
    });
    if (res.status !== 0 && !capture) {
        throw new Error(`docker ${args.join(' ')} failed with code ${res.status}`);
    }
    return res;
}

/** Returns true if the docker daemon is reachable. */
export function dockerAvailable() {
    const res = spawnSync('docker', ['info'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return res.status === 0;
}

function dockerRunDetached(cfg, name, service, args) {
    const full = [
        'run', '-d', '--init', '--name', name,
        '--network', cfg.network, '--restart', 'unless-stopped',
        '--label', `propr.stack=${cfg.stack}`,
        '--label', `propr.service=${service}`,
        ...args,
    ];
    const res = docker(full, { capture: true });
    if (res.status !== 0) {
        throw new Error(`Failed to start ${name}: ${res.stderr}`);
    }
}

function latestTagFor(imageTag) {
    const slashIndex = imageTag.lastIndexOf('/');
    const tagIndex = imageTag.lastIndexOf(':');
    return tagIndex > slashIndex ? `${imageTag.slice(0, tagIndex)}:latest` : null;
}

function tagAgentLatest(key, imageTag) {
    if (!key.startsWith('agent-')) return;
    const latestTag = latestTagFor(imageTag);
    if (!latestTag || latestTag === imageTag) return;
    const res = docker(['tag', imageTag, latestTag], { capture: true });
    if (res.status !== 0) {
        throw new Error(`Failed to tag ${imageTag} as ${latestTag}: ${res.stderr}`);
    }
}

export function containerExists(cfg, name) {
    const res = docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'], { capture: true });
    return res.stdout.trim() === name;
}

function removeIfExists(cfg, name, onLog) {
    if (containerExists(cfg, name)) {
        onLog?.(`  · removing stale ${name}`);
        docker(['rm', '-f', name], { capture: true });
    }
}

export function ensureNetwork(cfg, onLog) {
    const res = docker(['network', 'inspect', cfg.network], { capture: true });
    if (res.status !== 0) {
        onLog?.(`creating network ${cfg.network}`);
        docker(['network', 'create', cfg.network], { capture: true });
    }
}

function imagePresentLocally(tag) {
    const res = docker(['images', '-q', tag], { capture: true });
    return res.stdout.trim().length > 0;
}

function firstLine(value) {
    return (value || '').trim().split('\n')[0] || '';
}

function normalizeDigest(value) {
    const digest = firstLine(value);
    if (!digest) return null;
    const atIndex = digest.lastIndexOf('@');
    return atIndex >= 0 ? digest.slice(atIndex + 1) : digest;
}

function localRepoDigests(tag) {
    const res = docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', tag], { capture: true });
    if (res.status !== 0) return null;
    try {
        const parsed = JSON.parse(res.stdout.trim() || '[]');
        return Array.isArray(parsed) ? parsed.map(normalizeDigest).filter(Boolean) : [];
    } catch {
        return [];
    }
}

function remoteManifestDigest(tag) {
    const res = docker(['manifest', 'inspect', '--verbose', tag], { capture: true });
    if (res.status !== 0) {
        return { ok: false, error: firstLine(res.stderr || res.stdout || 'docker manifest inspect failed') };
    }

    try {
        const parsed = JSON.parse(res.stdout);
        const descriptor = Array.isArray(parsed) ? null : parsed?.Descriptor;
        const digest = descriptor?.digest || descriptor?.Digest || parsed?.digest || parsed?.Digest;
        if (!digest) {
            return { ok: false, error: 'remote manifest digest was not available from docker manifest inspect' };
        }
        return { ok: true, digest };
    } catch {
        return { ok: false, error: 'could not parse docker manifest inspect output' };
    }
}

/**
 * Inspect whether a local image tag is current with the remote registry tag.
 * Registry and metadata errors are reported as "unknown" so callers can warn
 * without treating offline/air-gapped environments as hard failures.
 */
export function inspectImageFreshness(tag) {
    if (!imagePresentLocally(tag)) {
        return { status: 'missing', tag };
    }

    const localDigests = localRepoDigests(tag);
    if (!localDigests) {
        return { status: 'missing', tag };
    }

    if (localDigests.length === 0) {
        return { status: 'unknown', tag, error: 'local image has no registry digest; pull the tag to verify freshness' };
    }

    const remote = remoteManifestDigest(tag);
    if (!remote.ok) {
        return { status: 'unknown', tag, localDigests, error: remote.error };
    }

    const remoteDigest = normalizeDigest(remote.digest);
    if (!remoteDigest) {
        return { status: 'unknown', tag, localDigests, error: 'remote manifest digest was empty' };
    }

    return localDigests.includes(remoteDigest)
        ? { status: 'current', tag, localDigests, remoteDigest }
        : { status: 'stale', tag, localDigests, remoteDigest };
}

/** Pull a single non-agent service image if it is not already present locally or is stale. */
export function ensureServiceImage(cfg, service, onLog) {
    const tag = imageTagForService(cfg, service);
    if (!tag) return;
    const freshness = inspectImageFreshness(tag);
    if (freshness.status === 'current') return;
    if (freshness.status === 'unknown') {
        onLog?.(`  · ${tag} (local, freshness not verified: ${freshness.error})`);
        return;
    }
    onLog?.(`  · pulling ${tag}`);
    const res = docker(['pull', tag], { capture: true });
    if (res.status !== 0) {
        throw new Error(`Failed to pull ${tag}: ${(res.stderr || '').trim()}`);
    }
}

// ---------------------------------------------------------------------------
// service registry
// ---------------------------------------------------------------------------

export const CORE_SERVICES = ['redis', 'daemon', 'worker', 'analysis-worker', 'indexing-worker', 'api'];
export const TOGGLE_SERVICES = ['ui', 'docs'];
export const SERVICES = [...CORE_SERVICES, ...TOGGLE_SERVICES];

function imageTagForService(cfg, service) {
    if (service === 'redis') return cfg.images.redis;
    if (service === 'ui') return cfg.images.ui;
    if (service === 'docs') return cfg.images.docs;
    // daemon/worker/analysis-worker/indexing-worker/api all run the app image
    return cfg.images.app;
}

function appBaseArgs(cfg) {
    return [
        // --env-file is resolved by the docker CLI (inside the launcher / on host).
        '--env-file', cfg.envFileLocal,
        '-v', `${cfg.hostLogs}:/usr/src/app/logs`,
        '-v', `${cfg.hostData}:/usr/src/app/data`,
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '-v', '/tmp/git-processor:/tmp/git-processor',
        '--add-host', 'host.docker.internal:host-gateway',
        '-e', `REDIS_HOST=${cfg.stack}-redis`,
        // Every app container imports @propr/core's githubAuth, which needs the
        // GitHub App private key — so mount it for all of them when provided.
        ...githubKeyArgs(cfg),
    ];
}

function appSpec(cfg, command, extraArgs = []) {
    return { image: cfg.images.app, args: [...appBaseArgs(cfg), ...extraArgs], command: ['node', ...command] };
}

// Returns { image, args, command? } for a canonical service name.
function buildServiceSpec(cfg, service) {
    switch (service) {
        case 'redis': {
            const args = ['-v', `${cfg.stack}-redis-data:/data`];
            if (cfg.redisExternalPort && cfg.redisExternalPort !== '0' && cfg.redisExternalPort !== 'none') {
                args.unshift('-p', `${cfg.redisExternalPort}:6379`);
            }
            return { image: cfg.images.redis, args };
        }
        case 'daemon':
            return appSpec(cfg, ['dist/src/daemon.js'], [
                '-v', `${cfg.envFileHost}:/usr/src/app/.env:ro`,
                '-v', '/tmp/pr-worktrees:/tmp/pr-worktrees',
                '-e', `GITHUB_BOT_USERNAME=${cfg.githubBotUsername}`,
                '-e', 'STAGING_ENV_FILE=/usr/src/app/.env',
            ]);
        case 'worker':
            return appSpec(cfg, ['dist/src/worker.js'], [
                '-v', `${cfg.hostRepos}:/usr/src/app/repos`,
                '-v', '/tmp/claude-logs:/tmp/claude-logs',
                '--ulimit', 'nofile=65536:65536',
                // The worker validates the attachment base URL at startup
                // (validateAttachmentBaseUrlConfig); inject the computed value so a
                // .env without API_PUBLIC_URL/FRONTEND_URL doesn't crashloop it.
                '-e', `API_PUBLIC_URL=${cfg.apiPublicUrl}`,
                ...vibePromptCacheArgs(cfg),
                ...agentCredentialArgs(cfg, { opencodeDataReadWrite: true }),
            ]);
        case 'analysis-worker':
            return appSpec(cfg, ['dist/src/analysis_worker.js'], [
                ...vibePromptCacheArgs(cfg),
                ...agentCredentialArgs(cfg),
            ]);
        case 'indexing-worker':
            return appSpec(cfg, ['dist/src/indexing_worker.js'], [
                '-v', '/tmp/claude-logs:/tmp/claude-logs',
                '-e', `INDEXING_SCAN_INTERVAL_MS=${cfg.indexingScanInterval}`,
                '-e', `INDEXING_REINDEX_INTERVAL_MS=${cfg.indexingReindexInterval}`,
                ...agentCredentialArgs(cfg),
            ]);
        case 'api':
            return appSpec(cfg, ['dist/packages/api/server.js'], [
                '-p', `${cfg.apiPort}:4000`,
                '-v', `${cfg.envFileHost}:/usr/src/app/.env:ro`,
                '-v', '/tmp/pr-worktrees:/tmp/pr-worktrees',
                '--ulimit', 'nofile=65536:65536',
                ...vibePromptCacheArgs(cfg),
                ...agentCredentialArgs(cfg),
                '-e', `API_PUBLIC_URL=${cfg.apiPublicUrl}`,
                '-e', `FRONTEND_URL=${cfg.frontendUrl}`,
                '-e', `GH_OAUTH_CALLBACK_URL=${cfg.ghOauthCallbackUrl}`,
                '-e', `SESSION_REDIS_HOST=${cfg.stack}-redis`,
                '-e', 'CONFIG_REPO_PATH=/tmp/config_repo',
            ]);
        case 'ui':
            return { image: cfg.images.ui, args: ['-p', `${cfg.uiPort}:5173`] };
        case 'docs':
            return { image: cfg.images.docs, args: ['-p', `${cfg.docsPort}:3000`] };
        default:
            throw new Error(`unknown service: ${service}`);
    }
}

/**
 * Start a single service container (removing any stale instance first). Pulls
 * the service image if it is missing so toggles (`propr docs on`) work even when
 * the image was skipped at startup.
 */
export function startService(cfg, service, { onLog, pull = true } = {}) {
    const name = `${cfg.stack}-${service}`;
    if (pull) ensureServiceImage(cfg, service, onLog);
    const spec = buildServiceSpec(cfg, service);
    removeIfExists(cfg, name, onLog);
    const runArgs = [...spec.args, spec.image, ...(spec.command || [])];
    dockerRunDetached(cfg, name, service, runArgs);
    onLog?.(`  [ok] started ${name}`);
    return getServiceState(cfg, service);
}

/** Stop (and by default remove) a single service container. Throws if the stop fails. */
export function stopService(cfg, service, { remove = true, onLog } = {}) {
    const name = `${cfg.stack}-${service}`;
    if (!containerExists(cfg, name)) return;
    const stopped = docker(['stop', '-t', '10', name], { capture: true });
    if (stopped.status !== 0) {
        throw new Error(`Failed to stop ${name}: ${(stopped.stderr || '').trim()}`);
    }
    if (remove) {
        const removed = docker(['rm', name], { capture: true });
        if (removed.status !== 0) {
            throw new Error(`Stopped ${name} but failed to remove it: ${(removed.stderr || '').trim()}`);
        }
    }
    onLog?.(`  [ok] stopped ${name}`);
}

/**
 * Check if any core service container in the stack is currently running.
 * Useful for callers that want to detect an already-running stack and
 * prompt before restarting (e.g. `propr start`).
 */
export function isStackRunning(cfg) {
    const status = getStackStatus(cfg);
    return status.services.some((s) => CORE_SERVICES.includes(s.service) && s.running);
}

/**
 * Start the full stack in dependency order. If a service fails to start, the
 * services started so far are stopped (best effort) before the error is
 * rethrown, so a failed startup doesn't leave a half-running stack behind.
 */
export function startStack(cfg, { ui = true, docs = cfg.docsEnabled, onLog } = {}) {
    const toStart = [...CORE_SERVICES, ...(ui ? ['ui'] : []), ...(docs ? ['docs'] : [])];
    const started = [];
    try {
        for (const service of toStart) {
            startService(cfg, service, { onLog });
            started.push(service);
        }
    } catch (err) {
        onLog?.(`  ! startup failed (${err.message}) — rolling back already-started services`);
        for (const service of started.reverse()) {
            try {
                stopService(cfg, service, { onLog });
            } catch (stopErr) {
                onLog?.(`  ! rollback: ${stopErr.message}`);
            }
        }
        throw err;
    }
    return getStackStatus(cfg);
}

/**
 * Stop every container belonging to this stack (discovered by label + legacy
 * name pattern). Returns `{ failed }` listing containers that could not be
 * stopped/removed so callers can surface partial failures.
 */
export function stopStack(cfg, { remove = true, removeNetwork = false, onLog } = {}) {
    const res = docker(['ps', '-a', '--filter', `label=propr.stack=${cfg.stack}`, '--format', '{{.Names}}'], { capture: true });
    const names = new Set(res.stdout.split('\n').map((s) => s.trim()).filter(Boolean));

    // Also discover legacy containers that were created before labeling was added
    // (named <stack>-<service> but missing the propr.stack label).
    for (const service of SERVICES) {
        const legacyName = `${cfg.stack}-${service}`;
        if (!names.has(legacyName) && containerExists(cfg, legacyName)) {
            names.add(legacyName);
        }
    }

    const failed = [];
    for (const name of names) {
        // docker() with capture never throws — check the exit status explicitly so
        // a failed stop is reported instead of being logged as "[ok] stopped".
        const stopped = docker(['stop', '-t', '10', name], { capture: true });
        if (stopped.status !== 0) {
            failed.push(name);
            onLog?.(`  ! failed to stop ${name}: ${(stopped.stderr || '').trim()}`);
            continue;
        }
        if (remove) {
            const removed = docker(['rm', name], { capture: true });
            if (removed.status !== 0) {
                failed.push(name);
                onLog?.(`  ! stopped ${name} but failed to remove it: ${(removed.stderr || '').trim()}`);
                continue;
            }
        }
        onLog?.(`  [ok] stopped ${name}`);
    }

    if (removeNetwork) {
        const removedNet = docker(['network', 'rm', cfg.network], { capture: true });
        // Non-zero is not fatal — the network may not exist or may still be in use.
        if (removedNet.status === 0) {
            onLog?.(`  [ok] removed network ${cfg.network}`);
        }
    }

    return { failed };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/** Per-service state for the whole stack, discovered by canonical/legacy container name. */
export function getStackStatus(cfg) {
    const expectedNames = new Set(SERVICES.map((service) => `${cfg.stack}-${service}`));
    const res = docker([
        'ps', '-a',
        '--format', '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}',
    ], { capture: true });

    const byName = new Map();
    for (const line of res.stdout.split('\n').filter(Boolean)) {
        const [name, state, status, ports] = line.split('\t');
        if (expectedNames.has(name)) byName.set(name, { state, status, ports: ports || '' });
    }

    const services = SERVICES.map((service) => {
        const name = `${cfg.stack}-${service}`;
        const found = byName.get(name);
        return {
            name,
            service,
            exists: Boolean(found),
            running: found ? found.state === 'running' : false,
            state: found ? found.state : 'absent',
            status: found ? found.status : 'not created',
            ports: found ? found.ports : '',
        };
    });

    const anyRunning = services.some((s) => s.running);
    return { stack: cfg.stack, network: cfg.network, running: anyRunning, services };
}

export function getServiceState(cfg, service) {
    return getStackStatus(cfg).services.find((s) => s.service === service);
}

/** Spawn `docker logs` for a service. Returns the ChildProcess. */
export function getServiceLogs(cfg, service, { follow = false, tail = 'all', stdio = 'inherit' } = {}) {
    const args = ['logs'];
    if (follow) args.push('-f');
    args.push('--tail', String(tail), `${cfg.stack}-${service}`);
    return spawn('docker', args, { stdio });
}

// ---------------------------------------------------------------------------
// validation + image pull (startup)
// ---------------------------------------------------------------------------

/**
 * Validate that required host paths and vibe settings are coherent. Returns a
 * result object (the caller decides whether to abort) — no process.exit here.
 */
export function validateEnv(cfg) {
    const errors = [];
    const warnings = [];

    // Docker name constraint — the stack name is embedded in container, volume
    // and network names, so reject it early instead of failing mid-startup.
    const dockerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
    if (!dockerNamePattern.test(cfg.stack)) {
        errors.push(`PROPR_STACK ("${cfg.stack}") is not a valid Docker name — use letters, digits, '_', '.' or '-', starting with a letter or digit.`);
    }
    if (!dockerNamePattern.test(cfg.network)) {
        errors.push(`PROPR_NETWORK ("${cfg.network}") is not a valid Docker network name — use letters, digits, '_', '.' or '-', starting with a letter or digit.`);
    }

    if (!cfg.envFileHost) errors.push('env file path is not set (PROPR_ENV_FILE / <root>/.env)');
    if (!cfg.hostData) errors.push('data dir is not set (PROPR_DATA_DIR)');
    if (!cfg.hostLogs) errors.push('logs dir is not set (PROPR_LOGS_DIR)');
    if (!cfg.hostRepos) errors.push('repos dir is not set (PROPR_REPOS_DIR)');
    if (cfg.validateHostPaths) {
        for (const [name, path] of [
            ['PROPR_DATA_DIR', cfg.hostData],
            ['PROPR_LOGS_DIR', cfg.hostLogs],
            ['PROPR_REPOS_DIR', cfg.hostRepos],
        ]) {
            if (path && !isDirectory(path)) {
                errors.push(`${name} (${path}) is not an existing directory. Run \`propr init stack\` to create the stack directories.`);
            }
        }
    }
    if (cfg.envFileLocal && !isReadableFile(cfg.envFileLocal)) {
        errors.push(`cannot read the env file at ${cfg.envFileLocal}`);
    }

    if (cfg.vibeConfigPath && !cfg.hostVibeDir) {
        errors.push(
            'VIBE_CONFIG_PATH is set but HOST_VIBE_DIR is not. Set HOST_VIBE_DIR to the host path of your .vibe directory.'
        );
    }
    const vibeEnabled = Boolean(cfg.hostVibeDir || cfg.mistralApiKey);
    if (vibeEnabled && !cfg.hostVibePromptCacheDir) {
        const vibeSource = cfg.hostVibeDir ? 'HOST_VIBE_DIR' : 'MISTRAL_API_KEY';
        errors.push(
            `Vibe support is enabled (via ${vibeSource}) but HOST_VIBE_PROMPT_CACHE_DIR is missing. ` +
            'Set it to a host-visible directory path (e.g. /tmp/propr-vibe-prompts).'
        );
    }
    if (vibeEnabled || cfg.hostVibePromptCacheDir) {
        const invalid = validateDockerBindPath('HOST_VIBE_PROMPT_CACHE_DIR', cfg.hostVibePromptCacheDir)
            || validateDockerBindPath('VIBE_PROMPT_CACHE_DIR', cfg.vibePromptCacheDir, { containerPath: true });
        if (invalid) {
            errors.push(invalid);
        } else if (cfg.hostVibePromptCacheDir && cfg.validateHostPaths) {
            if (!existsSync(cfg.hostVibePromptCacheDir)) {
                errors.push(`HOST_VIBE_PROMPT_CACHE_DIR (${cfg.hostVibePromptCacheDir}) does not exist. Create it: mkdir -p ${cfg.hostVibePromptCacheDir}`);
            } else {
                try {
                    accessSync(cfg.hostVibePromptCacheDir, fsConstants.W_OK);
                } catch {
                    errors.push(`HOST_VIBE_PROMPT_CACHE_DIR (${cfg.hostVibePromptCacheDir}) is not writable.`);
                }
            }
        }
    }

    const credentialDirs = [
        ['HOST_CLAUDE_DIR', cfg.hostClaudeDir],
        ['HOST_CODEX_DIR', cfg.hostCodexDir],
        ['HOST_ANTIGRAVITY_DIR', cfg.hostAntigravityDir],
        ['HOST_OPENCODE_LEGACY_DIR', cfg.hostOpencodeLegacyDir],
        ['HOST_OPENCODE_XDG_DIR', cfg.hostOpencodeXdgDir],
        ['HOST_OPENCODE_DATA_DIR', cfg.hostOpencodeDataDir],
        ['HOST_VIBE_DIR', cfg.hostVibeDir],
    ];
    const invalidCredential = credentialDirs
        .map(([name, value]) => (value ? validateDockerBindPath(name, value) : null))
        .find(Boolean);
    if (invalidCredential) errors.push(invalidCredential);

    if (cfg.hostGhPrivateKey) {
        const invalidKeyPath = validateDockerBindPath('HOST_GH_PRIVATE_KEY', cfg.hostGhPrivateKey);
        if (invalidKeyPath) {
            errors.push(invalidKeyPath);
        } else if (cfg.validateHostPaths && !isReadableFile(cfg.hostGhPrivateKey)) {
            errors.push(`HOST_GH_PRIVATE_KEY (${cfg.hostGhPrivateKey}) is not a readable file.`);
        }
    }

    const hasOpenCodeConfig = Boolean(cfg.hostOpencodeXdgDir || cfg.hostOpencodeLegacyDir);
    if (hasOpenCodeConfig && !cfg.hostOpencodeDataDir) {
        warnings.push(
            'OpenCode config is mounted but HOST_OPENCODE_DATA_DIR is not set. ' +
            'Set it to ~/.local/share/opencode if authenticated runs cannot see credentials.'
        );
    }

    return { ok: errors.length === 0, errors, warnings };
}

/**
 * Pull every image from the manifest that is not already present locally.
 * Mirrors the launcher's agent-image leniency (skip/strict via env flags).
 */
export function pullImages(cfg, { onLog = () => {}, env = process.env } = {}) {
    const skipAgentPull = env.PROPR_SKIP_AGENT_PULL === 'true' || env.PROPR_SKIP_AGENT_PULL === '1';
    const strictAgentPull = env.PROPR_STRICT_AGENT_PULL !== 'false' && env.PROPR_STRICT_AGENT_PULL !== '0';
    onLog('pulling images…');
    const failedAgentImages = [];

    for (const [key, tag] of Object.entries(cfg.images)) {
        if (key === 'docs' && !cfg.docsEnabled) continue;

        if (key.startsWith('agent-') && skipAgentPull) {
            if (imagePresentLocally(tag)) {
                onLog(`  · ${tag} (local, pull skipped via PROPR_SKIP_AGENT_PULL)`);
                tagAgentLatest(key, tag);
            } else {
                onLog(`  · ${tag} (not found locally, pull skipped via PROPR_SKIP_AGENT_PULL)`);
            }
            continue;
        }

        const freshness = inspectImageFreshness(tag);

        if (freshness.status === 'current') {
            onLog(`  · ${tag} (local, current)`);
            tagAgentLatest(key, tag);
            continue;
        }

        if (freshness.status === 'unknown') {
            onLog(`  · ${tag} (local, freshness not verified: ${freshness.error})`);
            tagAgentLatest(key, tag);
            continue;
        }

        if (freshness.status === 'stale') {
            onLog(`  · ${tag} (stale, pulling)`);
        } else {
            onLog(`  · ${tag}`);
        }
        const pulled = docker(['pull', tag], { capture: key.startsWith('agent-') });
        if (key.startsWith('agent-') && pulled.status !== 0) {
            failedAgentImages.push(tag);
            onLog(`  · ${tag} (pull failed — jobs using this agent will fail until the image is available)`);
            continue;
        }
        tagAgentLatest(key, tag);
    }

    return { failedAgentImages, strictAgentPull };
}
