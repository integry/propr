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

// Hosted UI tunnel naming. These mirror the shared TypeScript constants in
// packages/shared/src/proprServiceUrls.ts (PROPR_UI_PROXY_SUFFIX,
// DEFAULT_CLOUDFLARED_IMAGE) — kept as plain literals here because this module
// is dependency-free .mjs (Node stdlib only) and cannot import the TS package.
// Change one, change the other; test/orchestratorProprUrlsDrift.test.ts guards
// against the two copies diverging.
export const PROPR_UI_PROXY_SUFFIX = 'proxy.propr.dev';
export const DEFAULT_CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:latest';

// Whether an instance id is a valid single DNS label for the proxy hostname
// (<id>.proxy.propr.dev): 1–63 chars, ASCII letters/digits/hyphens only, no
// leading/trailing hyphen. Mirrors isValidProprInstanceId() in the shared pkg.
export function isValidProprInstanceId(instanceId) {
    const id = (instanceId ?? '').trim();
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(id);
}

// Derive the per-instance public API/UI URL (https://<instanceId>.proxy.propr.dev)
// from an instance id; returns undefined for a missing/blank or invalid id (so a
// malformed hostname is never emitted). Mirrors proprInstanceProxyUrl() in
// packages/shared/src/proprServiceUrls.ts.
export function proprInstanceProxyUrl(instanceId) {
    const id = (instanceId ?? '').trim();
    return isValidProprInstanceId(id) ? `https://${id}.${PROPR_UI_PROXY_SUFFIX}` : undefined;
}

// Broad truthy parse for env flags, mirroring parseTruthyEnvValue() in
// packages/shared/src/demoMode.ts so `1`/`TRUE`/whitespace are accepted like
// elsewhere in the repo (kept local because this module imports no TS package).
function parseTruthyEnvValue(value) {
    const normalized = value?.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
}

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

function defaultHostVibePromptCacheDir() {
    return `/tmp/propr-vibe-prompts-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`;
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

// Wrap a value in single quotes for safe copy-paste into a POSIX shell, so a
// path containing spaces or shell metacharacters in a suggested recovery command
// stays a single literal argument. Embedded single quotes are closed, escaped,
// and reopened ('\'').
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
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
    // resolve the same path end-to-end).
    const hostClaudeDir = get('HOST_CLAUDE_DIR');
    const hostCodexDir = get('HOST_CODEX_DIR');
    const hostAntigravityDir = get('HOST_ANTIGRAVITY_DIR');
    const hostOpencodeXdgDir = get('HOST_OPENCODE_XDG_DIR');
    const hostOpencodeDataDir = get('HOST_OPENCODE_DATA_DIR');
    const hostVibeDir = get('HOST_VIBE_DIR');
    const mistralApiKey = get('MISTRAL_API_KEY');

    const vibePromptCacheDir = get('VIBE_PROMPT_CACHE_DIR') || '/tmp/propr-vibe-prompts';
    // The host bind path defaults to a per-user private /tmp location when Vibe
    // is enabled, so prompt files are not exposed through a shared 0777 cache.
    // An explicit HOST_VIBE_PROMPT_CACHE_DIR is still honored and validated.
    const vibeEnabled = Boolean(hostVibeDir || mistralApiKey);
    const hostVibePromptCacheDir = get('HOST_VIBE_PROMPT_CACHE_DIR') || (vibeEnabled ? defaultHostVibePromptCacheDir() : undefined);

    // Host path to the GitHub App private key (.pem). When set, the key is
    // bind-mounted into the app containers (HOST:HOST, read-only) and
    // GH_PRIVATE_KEY_PATH is overridden to that path so the daemon/worker can
    // read it without the user having to stage it under data/.
    const hostGhPrivateKey = get('HOST_GH_PRIVATE_KEY');

    const manifestPath = overrides.manifestPath ?? resolve(__dirname, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    // Hosted UI tunnel: expose this local stack's UI/API to the hosted control
    // plane (https://app.propr.dev) via a Cloudflare Tunnel. A token alone is
    // enough to enable it; PROPR_UI_TUNNEL_ENABLED=true also turns it on.
    const uiTunnelToken = get('PROPR_UI_TUNNEL_TOKEN') || undefined;
    const uiTunnelEnabled = Boolean(uiTunnelToken) || parseTruthyEnvValue(get('PROPR_UI_TUNNEL_ENABLED'));
    const proprInstanceId = get('PROPR_INSTANCE_ID') || undefined;
    // Cloudflared image for the optional tunnel sidecar: an explicit env override
    // wins, then the manifest's pinned tag, with DEFAULT_CLOUDFLARED_IMAGE as a
    // final fallback for manifests without a cloudflared entry.
    const cloudflaredImage = get('PROPR_CLOUDFLARED_IMAGE') || manifest.images.cloudflared || DEFAULT_CLOUDFLARED_IMAGE;
    // Explicit URL wins; otherwise derive from the instance id's proxy hostname.
    // Falls back to undefined for local development (no instance id), where
    // API_PUBLIC_URL / FRONTEND_URL keep their localhost defaults below.
    const uiPublicApiUrl = get('PROPR_UI_PUBLIC_API_URL') || proprInstanceProxyUrl(proprInstanceId);

    return Object.freeze({
        stack, network, envFileLocal, envFileHost,
        validateHostPaths: overrides.validateHostPaths === true,
        hostData, hostLogs, hostRepos,
        apiPort, uiPort, docsPort, redisExternalPort, docsEnabled,
        hostClaudeDir, hostCodexDir, hostAntigravityDir,
        hostOpencodeXdgDir, hostOpencodeDataDir,
        hostVibeDir, vibePromptCacheDir, hostVibePromptCacheDir,
        hostGhPrivateKey,
        // Hosted UI tunnel settings (see resolution above). Defaults keep local
        // development unaffected: no instance id ⇒ no derived public URL.
        uiTunnelEnabled, uiTunnelToken, proprInstanceId, uiPublicApiUrl, cloudflaredImage,
        // misc -e overrides the launcher computed from ports/env
        apiPublicUrl: get('API_PUBLIC_URL') || `http://localhost:${apiPort}`,
        frontendUrl: get('FRONTEND_URL') || `http://localhost:${uiPort}`,
        ghOauthCallbackUrl: get('GH_OAUTH_CALLBACK_URL') || `http://localhost:${apiPort}/api/auth/github/callback`,
        githubBotUsername: get('GITHUB_BOT_USERNAME') || 'propr.dev[bot]',
        indexingScanInterval: get('INDEXING_SCAN_INTERVAL_MS') || '300000',
        indexingReindexInterval: get('INDEXING_REINDEX_INTERVAL_MS') || '86400000',
        mistralApiKey,
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
export function agentCredentialArgs(cfg, { opencodeDataReadWrite = false } = {}) {
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
    if (cfg.hostOpencodeXdgDir) {
        args.push('-v', `${cfg.hostOpencodeXdgDir}:${cfg.hostOpencodeXdgDir}`);
        args.push('-e', `OPENCODE_CONFIG_PATH=${cfg.hostOpencodeXdgDir}`);
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

const REMOTE_IMAGE_CHECK_TIMEOUT_MS = 5000;

export function docker(args, { capture = false, timeout } = {}) {
    const res = spawnSync('docker', args, {
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        encoding: 'utf8',
        timeout,
    });
    if (res.status !== 0 && !capture) {
        const detail = res.error?.message || (res.signal ? `signal ${res.signal}` : `code ${res.status}`);
        throw new Error(`docker ${args.join(' ')} failed with ${detail}`);
    }
    return res;
}

/**
 * Async, captured docker exec. Mirrors `docker(..., { capture: true })`'s result
 * shape ({ status, stdout, stderr, error }) but keeps the event loop free, so
 * callers can run several probes concurrently and animate UI while they wait.
 * On timeout it kills the child and reports an ETIMEDOUT error, matching the
 * spawnSync timeout contract that `dockerError` inspects.
 */
export function dockerAsync(args, { timeout } = {}) {
    return new Promise((resolveResult) => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timeoutError = null;
        const finish = (res) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolveResult(res);
        };
        const timer = timeout
            ? setTimeout(() => {
                  timeoutError = Object.assign(new Error('docker command timed out'), { code: 'ETIMEDOUT' });
                  child.kill('SIGKILL');
              }, timeout)
            : null;
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (error) => finish({ status: null, stdout, stderr, error }));
        child.on('close', (code, signal) => finish({ status: code, stdout, stderr, signal, error: timeoutError || undefined }));
    });
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

export function tagAgentLatest(key, imageTag) {
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

export function normalizeDigest(value) {
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

export function remoteDigestFromManifestInspectOutput(output) {
    return remoteDigestsFromManifestInspectOutput(output)[0] ?? null;
}

export function remoteDigestsFromManifestInspectOutput(output) {
    const parsed = JSON.parse(output);
    const digests = new Set();
    if (Array.isArray(parsed)) {
        for (const entry of parsed) {
            const refDigest = normalizeDigest(entry?.Ref);
            if (refDigest) digests.add(refDigest);
            const descriptor = entry?.Descriptor;
            const descriptorDigest = normalizeDigest(descriptor?.digest || descriptor?.Digest || entry?.digest || entry?.Digest);
            if (descriptorDigest) digests.add(descriptorDigest);
        }
        return [...digests];
    }
    const descriptor = parsed?.Descriptor;
    const digest = normalizeDigest(descriptor?.digest || descriptor?.Digest || parsed?.digest || parsed?.Digest);
    return digest ? [digest] : [];
}

export function remoteDigestFromImagetoolsInspectOutput(output) {
    const match = output.match(/^\s*Digest:\s*([^\s]+)\s*$/im);
    return match ? match[1] : null;
}

function appendDigest(digests, digest) {
    const normalized = normalizeDigest(digest);
    return normalized && !digests.includes(normalized) ? [...digests, normalized] : digests;
}

function dockerError(res, fallback) {
    if (res.error?.code === 'ETIMEDOUT') {
        return `remote image check timed out after ${REMOTE_IMAGE_CHECK_TIMEOUT_MS / 1000}s; set PROPR_SKIP_REMOTE_IMAGE_CHECK=1 to skip registry probes`;
    }
    return firstLine(res.stderr || res.stdout || fallback);
}

function remoteManifestDigest(tag) {
    // Older Docker CLIs may require experimental manifest support. Treat those
    // failures like any other registry issue so callers can warn or skip.
    const res = docker(['manifest', 'inspect', '--verbose', tag], { capture: true, timeout: REMOTE_IMAGE_CHECK_TIMEOUT_MS });
    if (res.status !== 0) {
        return { ok: false, error: dockerError(res, 'docker manifest inspect failed') };
    }

    try {
        const digests = remoteDigestsFromManifestInspectOutput(res.stdout);
        if (digests.length > 0) {
            let allDigests = digests;
            if (res.stdout.trim().startsWith('[')) {
                const buildx = docker(['buildx', 'imagetools', 'inspect', tag], { capture: true, timeout: REMOTE_IMAGE_CHECK_TIMEOUT_MS });
                if (buildx.status === 0) allDigests = appendDigest(allDigests, remoteDigestFromImagetoolsInspectOutput(buildx.stdout));
            }
            return { ok: true, digests: allDigests, digest: allDigests[0] };
        }

        // Older Docker manifest output may omit digest fields. buildx can still
        // expose the tag's index digest, which is useful when the local daemon
        // recorded that digest in RepoDigests.
        const buildx = docker(['buildx', 'imagetools', 'inspect', tag], { capture: true, timeout: REMOTE_IMAGE_CHECK_TIMEOUT_MS });
        if (buildx.status !== 0) {
            return { ok: false, error: dockerError(buildx, 'docker buildx imagetools inspect failed') };
        }
        const buildxDigest = remoteDigestFromImagetoolsInspectOutput(buildx.stdout);
        if (buildxDigest) return { ok: true, digests: [buildxDigest], digest: buildxDigest };

        return { ok: false, error: 'remote manifest digest was not available from docker manifest inspect or docker buildx imagetools inspect' };
    } catch {
        return { ok: false, error: 'could not parse docker manifest inspect output' };
    }
}

function classifyImageFreshness(tag, localDigests, remote) {
    if (!remote.ok) {
        return { status: 'unknown', tag, localDigests, error: remote.error };
    }

    const remoteDigests = (remote.digests ?? [remote.digest]).map(normalizeDigest).filter(Boolean);
    if (remoteDigests.length === 0) {
        return { status: 'unknown', tag, localDigests, error: 'remote manifest digest was empty' };
    }

    const digestFields = remoteDigests.length > 1
        ? { remoteDigest: remoteDigests[0], remoteDigests }
        : { remoteDigest: remoteDigests[0] };
    return localDigests.some((digest) => remoteDigests.includes(digest))
        ? { status: 'current', tag, localDigests, ...digestFields }
        : { status: 'stale', tag, localDigests, ...digestFields };
}

function skipRemoteImageCheck(env = process.env) {
    return env.PROPR_SKIP_REMOTE_IMAGE_CHECK === 'true' || env.PROPR_SKIP_REMOTE_IMAGE_CHECK === '1';
}

function isProprPublishedImage(cfg, tag) {
    const registry = typeof cfg.manifest?.registry === 'string' ? cfg.manifest.registry : 'propr';
    return tag.startsWith(`${registry}/`);
}

/**
 * Inspect whether a local image tag is current with the remote registry tag.
 * Registry and metadata errors are reported as "unknown" so callers can warn
 * without treating offline/air-gapped environments as hard failures.
 */
export function inspectImageFreshness(tag, { skipRemoteCheck = false } = {}) {
    if (!imagePresentLocally(tag)) {
        return { status: 'missing', tag };
    }

    const localDigests = localRepoDigests(tag);
    if (!localDigests) {
        return { status: 'unknown', tag, error: 'local image metadata could not be inspected' };
    }

    if (skipRemoteCheck) {
        return { status: 'unknown', tag, localDigests, skipped: true, error: 'remote image check skipped' };
    }

    if (localDigests.length === 0) {
        return { status: 'unknown', tag, localDigests, localOnly: true, error: 'local image has no registry digest; pull the tag to verify freshness' };
    }

    return classifyImageFreshness(tag, localDigests, remoteManifestDigest(tag));
}

/** Async mirror of remoteManifestDigest using non-blocking docker exec. */
async function remoteManifestDigestAsync(tag) {
    const res = await dockerAsync(['manifest', 'inspect', '--verbose', tag], { timeout: REMOTE_IMAGE_CHECK_TIMEOUT_MS });
    if (res.status !== 0) {
        return { ok: false, error: dockerError(res, 'docker manifest inspect failed') };
    }
    try {
        const digests = remoteDigestsFromManifestInspectOutput(res.stdout);
        if (digests.length > 0) {
            let allDigests = digests;
            if (res.stdout.trim().startsWith('[')) {
                const buildx = await dockerAsync(['buildx', 'imagetools', 'inspect', tag], { timeout: REMOTE_IMAGE_CHECK_TIMEOUT_MS });
                if (buildx.status === 0) allDigests = appendDigest(allDigests, remoteDigestFromImagetoolsInspectOutput(buildx.stdout));
            }
            return { ok: true, digests: allDigests, digest: allDigests[0] };
        }

        const buildx = await dockerAsync(['buildx', 'imagetools', 'inspect', tag], { timeout: REMOTE_IMAGE_CHECK_TIMEOUT_MS });
        if (buildx.status !== 0) {
            return { ok: false, error: dockerError(buildx, 'docker buildx imagetools inspect failed') };
        }
        const buildxDigest = remoteDigestFromImagetoolsInspectOutput(buildx.stdout);
        if (buildxDigest) return { ok: true, digests: [buildxDigest], digest: buildxDigest };

        return { ok: false, error: 'remote manifest digest was not available from docker manifest inspect or docker buildx imagetools inspect' };
    } catch {
        return { ok: false, error: 'could not parse docker manifest inspect output' };
    }
}

/**
 * Async mirror of inspectImageFreshness. The local (fast) docker calls stay
 * synchronous; only the remote registry probe is awaited, so many tags can be
 * checked concurrently without blocking the event loop.
 */
export async function inspectImageFreshnessAsync(tag, { skipRemoteCheck = false } = {}) {
    if (!imagePresentLocally(tag)) {
        return { status: 'missing', tag };
    }

    const localDigests = localRepoDigests(tag);
    if (!localDigests) {
        return { status: 'unknown', tag, error: 'local image metadata could not be inspected' };
    }

    if (skipRemoteCheck) {
        return { status: 'unknown', tag, localDigests, skipped: true, error: 'remote image check skipped' };
    }

    if (localDigests.length === 0) {
        return { status: 'unknown', tag, localDigests, localOnly: true, error: 'local image has no registry digest; pull the tag to verify freshness' };
    }

    return classifyImageFreshness(tag, localDigests, await remoteManifestDigestAsync(tag));
}

function cachedImageFreshness(cache, tag, opts) {
    if (!cache) return inspectImageFreshness(tag, opts);
    const key = `${opts.skipRemoteCheck ? 'skip' : 'remote'}\0${tag}`;
    if (!cache.has(key)) cache.set(key, inspectImageFreshness(tag, opts));
    return cache.get(key);
}

/** Pull a single non-agent service image if it is not already present locally or is stale. */
export function ensureServiceImage(cfg, service, onLog, { freshnessCache } = {}) {
    const tag = imageTagForService(cfg, service);
    if (!tag) return;
    const skipFreshness = skipRemoteImageCheck() || !isProprPublishedImage(cfg, tag);
    const freshness = cachedImageFreshness(freshnessCache, tag, { skipRemoteCheck: skipFreshness });
    if (freshness.status === 'current') return;
    if (freshness.status === 'unknown') {
        if (freshness.skipped) return;
        if (freshness.localOnly) {
            onLog?.(`  · ${tag} (local-only, pulling)`);
        } else {
            onLog?.(`  · ${tag} (local, freshness not verified: ${freshness.error})`);
            return;
        }
    } else {
        onLog?.(`  · pulling ${tag}`);
    }
    const res = docker(['pull', tag], { capture: true });
    if (res.status !== 0) {
        throw new Error(`Failed to pull ${tag}: ${(res.stderr || '').trim()}`);
    }
}

// ---------------------------------------------------------------------------
// service registry
// ---------------------------------------------------------------------------

export const CORE_SERVICES = ['redis', 'daemon', 'worker', 'analysis-worker', 'indexing-worker', 'api'];
export const TOGGLE_SERVICES = ['ui', 'docs', 'tunnel'];
export const SERVICES = [...CORE_SERVICES, ...TOGGLE_SERVICES];

function imageTagForService(cfg, service) {
    if (service === 'redis') return cfg.images.redis;
    if (service === 'ui') return cfg.images.ui;
    if (service === 'docs') return cfg.images.docs;
    if (service === 'tunnel') return cfg.cloudflaredImage;
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
        case 'tunnel':
            // Optional Cloudflare Tunnel sidecar running the official cloudflared
            // image (its entrypoint is `cloudflared`). It dials out to Cloudflare's
            // edge, so no local ports are published. The token is injected only
            // here — no other container receives PROPR_UI_TUNNEL_TOKEN — and is
            // also passed on the run command so cloudflared authenticates the run.
            return {
                image: cfg.cloudflaredImage,
                args: ['-e', `PROPR_UI_TUNNEL_TOKEN=${cfg.uiTunnelToken}`],
                command: ['tunnel', '--no-autoupdate', 'run', '--token', cfg.uiTunnelToken],
            };
        default:
            throw new Error(`unknown service: ${service}`);
    }
}

/**
 * Start a single service container (removing any stale instance first). Pulls
 * the service image if it is missing so toggles (`propr docs on`) work even when
 * the image was skipped at startup.
 */
export function startService(cfg, service, { onLog, pull = true, freshnessCache } = {}) {
    const name = `${cfg.stack}-${service}`;
    if (pull) ensureServiceImage(cfg, service, onLog, { freshnessCache });
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
export function startStack(cfg, { ui = true, docs = cfg.docsEnabled, tunnel = cfg.uiTunnelEnabled, onLog } = {}) {
    const toStart = [...CORE_SERVICES, ...(ui ? ['ui'] : []), ...(docs ? ['docs'] : []), ...(tunnel ? ['tunnel'] : [])];
    const started = [];
    const freshnessCache = new Map();
    try {
        for (const service of toStart) {
            startService(cfg, service, { onLog, freshnessCache });
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

// ---------------------------------------------------------------------------
// async start path
//
// The synchronous startStack/startService/ensureNetwork above drive `propr
// start`, where all the work finishes before any live UI is rendered. The
// interactive `propr setup` wizard is different: an Ink TUI is on screen while
// the stack comes up, so a blocking spawnSync would freeze the spinner and
// swallow keystrokes for the many seconds a cold start can take. These async
// mirrors do the identical work through dockerAsync(), keeping the event loop
// free so the wizard keeps animating and streaming progress. Their logic is
// intentionally kept in lockstep with the synchronous versions above — change
// one, change the other.
// ---------------------------------------------------------------------------

async function containerExistsAsync(cfg, name) {
    const res = await dockerAsync(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']);
    return res.stdout.trim() === name;
}

async function removeIfExistsAsync(cfg, name, onLog) {
    if (await containerExistsAsync(cfg, name)) {
        onLog?.(`  · removing stale ${name}`);
        await dockerAsync(['rm', '-f', name]);
    }
}

async function dockerRunDetachedAsync(cfg, name, service, args) {
    const full = [
        'run', '-d', '--init', '--name', name,
        '--network', cfg.network, '--restart', 'unless-stopped',
        '--label', `propr.stack=${cfg.stack}`,
        '--label', `propr.service=${service}`,
        ...args,
    ];
    const res = await dockerAsync(full);
    if (res.status !== 0) {
        throw new Error(`Failed to start ${name}: ${res.stderr}`);
    }
}

/** Async mirror of ensureNetwork. */
export async function ensureNetworkAsync(cfg, onLog) {
    const res = await dockerAsync(['network', 'inspect', cfg.network]);
    if (res.status !== 0) {
        onLog?.(`creating network ${cfg.network}`);
        await dockerAsync(['network', 'create', cfg.network]);
    }
}

/** Async, memoized image-freshness lookup mirroring cachedImageFreshness. */
async function cachedImageFreshnessAsync(cache, tag, opts) {
    if (!cache) return inspectImageFreshnessAsync(tag, opts);
    const key = `${opts.skipRemoteCheck ? 'skip' : 'remote'}\0${tag}`;
    if (!cache.has(key)) cache.set(key, await inspectImageFreshnessAsync(tag, opts));
    return cache.get(key);
}

/** Async mirror of ensureServiceImage — pulls a missing/stale image, awaited. */
async function ensureServiceImageAsync(cfg, service, onLog, { freshnessCache } = {}) {
    const tag = imageTagForService(cfg, service);
    if (!tag) return;
    const skipFreshness = skipRemoteImageCheck() || !isProprPublishedImage(cfg, tag);
    const freshness = await cachedImageFreshnessAsync(freshnessCache, tag, { skipRemoteCheck: skipFreshness });
    if (freshness.status === 'current') return;
    if (freshness.status === 'unknown') {
        if (freshness.skipped) return;
        if (freshness.localOnly) {
            onLog?.(`  · ${tag} (local-only, pulling)`);
        } else {
            onLog?.(`  · ${tag} (local, freshness not verified: ${freshness.error})`);
            return;
        }
    } else {
        onLog?.(`  · pulling ${tag}`);
    }
    const res = await dockerAsync(['pull', tag]);
    if (res.status !== 0) {
        throw new Error(`Failed to pull ${tag}: ${(res.stderr || '').trim()}`);
    }
}

/** Async mirror of startService. */
export async function startServiceAsync(cfg, service, { onLog, pull = true, freshnessCache } = {}) {
    const name = `${cfg.stack}-${service}`;
    if (pull) await ensureServiceImageAsync(cfg, service, onLog, { freshnessCache });
    const spec = buildServiceSpec(cfg, service);
    await removeIfExistsAsync(cfg, name, onLog);
    const runArgs = [...spec.args, spec.image, ...(spec.command || [])];
    await dockerRunDetachedAsync(cfg, name, service, runArgs);
    onLog?.(`  [ok] started ${name}`);
    return getServiceStateAsync(cfg, service);
}

/** Async mirror of stopService (used by startStackAsync's rollback). */
async function stopServiceAsync(cfg, service, { remove = true, onLog } = {}) {
    const name = `${cfg.stack}-${service}`;
    if (!(await containerExistsAsync(cfg, name))) return;
    const stopped = await dockerAsync(['stop', '-t', '10', name]);
    if (stopped.status !== 0) {
        throw new Error(`Failed to stop ${name}: ${(stopped.stderr || '').trim()}`);
    }
    if (remove) {
        const removed = await dockerAsync(['rm', name]);
        if (removed.status !== 0) {
            throw new Error(`Stopped ${name} but failed to remove it: ${(removed.stderr || '').trim()}`);
        }
    }
    onLog?.(`  [ok] stopped ${name}`);
}

/**
 * Async mirror of startStack — starts the full stack in dependency order
 * without blocking the event loop, rolling back already-started services on a
 * mid-startup failure (best effort) before rethrowing.
 */
export async function startStackAsync(cfg, { ui = true, docs = cfg.docsEnabled, tunnel = cfg.uiTunnelEnabled, onLog } = {}) {
    const toStart = [...CORE_SERVICES, ...(ui ? ['ui'] : []), ...(docs ? ['docs'] : []), ...(tunnel ? ['tunnel'] : [])];
    const started = [];
    const freshnessCache = new Map();
    try {
        for (const service of toStart) {
            await startServiceAsync(cfg, service, { onLog, freshnessCache });
            started.push(service);
        }
    } catch (err) {
        onLog?.(`  ! startup failed (${err.message}) — rolling back already-started services`);
        for (const service of started.reverse()) {
            try {
                await stopServiceAsync(cfg, service, { onLog });
            } catch (stopErr) {
                onLog?.(`  ! rollback: ${stopErr.message}`);
            }
        }
        throw err;
    }
    return getStackStatusAsync(cfg);
}

/** Async mirror of getStackStatus. */
export async function getStackStatusAsync(cfg) {
    const res = await dockerAsync(STACK_STATUS_PS_ARGS);
    return parseStackStatus(cfg, res.stdout);
}

/** Async mirror of getServiceState. */
async function getServiceStateAsync(cfg, service) {
    return (await getStackStatusAsync(cfg)).services.find((s) => s.service === service);
}

/** Async mirror of isStackRunning. */
export async function isStackRunningAsync(cfg) {
    const status = await getStackStatusAsync(cfg);
    return status.services.some((s) => CORE_SERVICES.includes(s.service) && s.running);
}

/**
 * Stop every container belonging to this stack, discovered by the stack label.
 * Returns `{ failed }` listing containers that could not be stopped/removed so
 * callers can surface partial failures.
 */
export function stopStack(cfg, { remove = true, removeNetwork = false, onLog } = {}) {
    const res = docker(['ps', '-a', '--filter', `label=propr.stack=${cfg.stack}`, '--format', '{{.Names}}'], { capture: true });
    const names = new Set(res.stdout.split('\n').map((s) => s.trim()).filter(Boolean));

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

/** Parse the `docker ps` table into per-service stack status (shared by sync/async). */
function parseStackStatus(cfg, stdout) {
    const expectedNames = new Set(SERVICES.map((service) => `${cfg.stack}-${service}`));
    const byName = new Map();
    for (const line of stdout.split('\n').filter(Boolean)) {
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

const STACK_STATUS_PS_ARGS = ['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}'];

/** Per-service state for the whole stack, discovered by canonical container name. */
export function getStackStatus(cfg) {
    const res = docker(STACK_STATUS_PS_ARGS, { capture: true });
    return parseStackStatus(cfg, res.stdout);
}

export function getServiceState(cfg, service) {
    return getStackStatus(cfg).services.find((s) => s.service === service);
}

// Best-effort GET <publicApiUrl>/health behind a hard timeout. Resolves true on
// a 2xx response, false on any non-2xx / network error / timeout. Never throws:
// tunnel reachability is a diagnostic, not a gate, so a slow or down proxy must
// not fail `propr status`.
async function probeTunnelReachable(publicApiUrl, timeoutMs = 3000) {
    const base = publicApiUrl.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}/health`, { signal: controller.signal, redirect: 'follow' });
        return res.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Tunnel diagnostics for `propr status`. The Cloudflare tunnel is a local
 * managed service, so its health belongs in local status:
 *   - enabled:      tunnel turned on by resolved config (token present or the
 *                   explicit PROPR_UI_TUNNEL_ENABLED flag)
 *   - configured:   a tunnel token is present
 *   - running:      the cloudflared sidecar container is running
 *   - publicApiUrl: the expected public proxy URL (null when not derivable)
 *   - reachable:    best-effort <publicApiUrl>/health probe — true/false when a
 *                   URL is known, null when there is nothing to probe
 *
 * Pass a precomputed stack status to reuse a single `docker ps`.
 */
export async function getTunnelStatus(cfg, stackStatus) {
    const status = stackStatus ?? await getStackStatusAsync(cfg);
    const tunnel = status.services.find((s) => s.service === 'tunnel');
    const publicApiUrl = cfg.uiPublicApiUrl ?? null;
    const reachable = publicApiUrl ? await probeTunnelReachable(publicApiUrl) : null;
    return {
        enabled: Boolean(cfg.uiTunnelEnabled),
        configured: Boolean(cfg.uiTunnelToken),
        running: Boolean(tunnel && tunnel.running),
        publicApiUrl,
        reachable,
    };
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
    if (vibeEnabled || cfg.hostVibePromptCacheDir) {
        // Only validate the host path when it is actually set — a missing value is
        // already reported above, so this avoids a misleading second "must be an
        // absolute path" error for the same root cause.
        const invalid = (cfg.hostVibePromptCacheDir
                ? validateDockerBindPath('HOST_VIBE_PROMPT_CACHE_DIR', cfg.hostVibePromptCacheDir)
                : null)
            || validateDockerBindPath('VIBE_PROMPT_CACHE_DIR', cfg.vibePromptCacheDir, { containerPath: true });
        if (invalid) {
            errors.push(invalid);
        } else if (cfg.hostVibePromptCacheDir && cfg.validateHostPaths) {
            if (!existsSync(cfg.hostVibePromptCacheDir)) {
                // A missing prompt cache is trivially recoverable — `propr init
                // stack`, `propr start`, or Docker's bind-mount setup will create
                // it — so only fail when its parent location is not writable and
                // it therefore cannot be created.
                const parent = dirname(cfg.hostVibePromptCacheDir);
                let creatable = false;
                try { accessSync(parent, fsConstants.W_OK); creatable = true; } catch { /* parent not writable */ }
                if (!creatable) {
                    errors.push(`HOST_VIBE_PROMPT_CACHE_DIR (${cfg.hostVibePromptCacheDir}) does not exist and ${parent} is not writable. Create it manually: mkdir -p ${shellQuote(cfg.hostVibePromptCacheDir)}`);
                }
            } else {
                try {
                    accessSync(cfg.hostVibePromptCacheDir, fsConstants.W_OK);
                } catch {
                    // Usually means a previous run let Docker auto-create the dir
                    // as root on first bind-mount. Reclaim ownership or remove it
                    // (it is a regenerable cache) so the user can write to it again.
                    errors.push(`HOST_VIBE_PROMPT_CACHE_DIR (${cfg.hostVibePromptCacheDir}) is not writable. It is likely owned by root from a previous run; reclaim it with \`sudo chown -R $(id -u):$(id -g) ${shellQuote(cfg.hostVibePromptCacheDir)}\` or remove it (it is a regenerable cache) with \`sudo rm -rf ${shellQuote(cfg.hostVibePromptCacheDir)}\`.`);
                }
            }
        }
    }

    const credentialDirs = [
        ['HOST_CLAUDE_DIR', cfg.hostClaudeDir],
        ['HOST_CODEX_DIR', cfg.hostCodexDir],
        ['HOST_ANTIGRAVITY_DIR', cfg.hostAntigravityDir],
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

    // The tunnel sidecar cannot authenticate without a token. uiTunnelEnabled is
    // true whenever a token is present, so this only trips when the tunnel was
    // turned on via PROPR_UI_TUNNEL_ENABLED=true without PROPR_UI_TUNNEL_TOKEN.
    if (cfg.uiTunnelEnabled && !cfg.uiTunnelToken) {
        errors.push('The UI tunnel is enabled (PROPR_UI_TUNNEL_ENABLED=true) but PROPR_UI_TUNNEL_TOKEN is not set. Set PROPR_UI_TUNNEL_TOKEN to your Cloudflare Tunnel token, or unset PROPR_UI_TUNNEL_ENABLED to disable the tunnel.');
    }

    const hasOpenCodeConfig = Boolean(cfg.hostOpencodeXdgDir);
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
    const skipFreshnessCheck = skipRemoteImageCheck(env);
    const freshnessCache = new Map();
    onLog('pulling images…');
    const failedAgentImages = [];

    for (const [key, tag] of Object.entries(cfg.images)) {
        if (key === 'docs' && !cfg.docsEnabled) continue;
        if (key === 'cloudflared' && !cfg.uiTunnelEnabled) continue;

        if (key.startsWith('agent-') && skipAgentPull) {
            if (imagePresentLocally(tag)) {
                onLog(`  · ${tag} (local, pull skipped via PROPR_SKIP_AGENT_PULL)`);
                tagAgentLatest(key, tag);
            } else {
                onLog(`  · ${tag} (not found locally, pull skipped via PROPR_SKIP_AGENT_PULL)`);
            }
            continue;
        }

        const skipFreshnessForImage = skipFreshnessCheck || !isProprPublishedImage(cfg, tag);
        const freshness = cachedImageFreshness(freshnessCache, tag, { skipRemoteCheck: skipFreshnessForImage });

        if (freshness.status === 'current') {
            onLog(`  · ${tag} (local, current)`);
            tagAgentLatest(key, tag);
            continue;
        }

        if (freshness.status === 'unknown') {
            if (freshness.localOnly) {
                onLog(`  · ${tag} (local-only, pulling)`);
                // fall through and pull once; do not print the generic line too.
            } else if (freshness.skipped) {
                const reason = skipFreshnessCheck ? 'remote check skipped via PROPR_SKIP_REMOTE_IMAGE_CHECK' : 'third-party image';
                onLog(`  · ${tag} (local, ${reason})`);
                tagAgentLatest(key, tag);
                continue;
            } else {
                onLog(`  · ${tag} (local, freshness not verified: ${freshness.error})`);
                tagAgentLatest(key, tag);
                continue;
            }
        }

        if (freshness.status === 'stale') {
            onLog(`  · ${tag} (stale, pulling)`);
        } else if (!(freshness.status === 'unknown' && freshness.localOnly)) {
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
