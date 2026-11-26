import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import logger from '../../utils/logger.js';
import type { AgentRuntimePackageAvailabilityResult } from './agentRuntimePackageCatalog.js';
import { validateAgentRuntimePackages } from './agentRuntimePackageProfile.js';

/**
 * A Docker-free package availability check: package names are resolved against
 * the Debian apt sources the agent image (`Dockerfile.agent`) is built on, read
 * straight from the archive over HTTPS. Settings uses it when Docker is not the
 * runtime that applies the list or is unreachable, and the Fly Machines and
 * Sprites runtimes re-check against it before a new installation (a build, a
 * start-time install or a fresh Sprite); an environment already built with the
 * list is reused without it.
 */

/** One apt source of the agent image: `<url>/dists/<suite>/<component>/binary-<arch>/Packages`. */
export interface AgentImageAptSource { url: string; suite: string; component: string }

// node:<version>-bookworm-slim ships deb.debian.org bookworm, bookworm-updates
// and bookworm-security with the main component; Dockerfile.agent enables no
// other Debian suite or component. Keep this in step with its FROM line.
export const AGENT_IMAGE_APT_SOURCES: readonly AgentImageAptSource[] = [
    { url: 'https://deb.debian.org/debian', suite: 'bookworm', component: 'main' },
    { url: 'https://deb.debian.org/debian', suite: 'bookworm-updates', component: 'main' },
    { url: 'https://deb.debian.org/debian-security', suite: 'bookworm-security', component: 'main' },
];
/** Dockerfile.agent builds linux/amd64 only (AGENT_PLATFORM). */
export const AGENT_IMAGE_ARCHITECTURE = 'amd64';
export const AGENT_IMAGE_PACKAGE_INDEX_NAME = 'Debian 12 (bookworm) package index';

const INDEX_TTL_MS = 4 * 60 * 60_000;
/** A refresh that fails keeps serving the last index for this long. */
const STALE_LIMIT_MS = 24 * 60 * 60_000;
/** After a failed load (offline host, private mirror), callers do not wait on the network again for this long. */
const FAILURE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const INDEX_SIZE_LIMIT = 64 * 1024 ** 2;

export interface AgentImagePackageIndex {
    /** Real package name -> versions in the index. */
    packages: Map<string, Set<string>>;
    /** Names some package `Provides` (virtual packages). */
    provides: Set<string>;
    loadedAt: number;
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface AgentImagePackageIndexOptions {
    fetch?: FetchLike;
    sources?: readonly AgentImageAptSource[];
    architecture?: string;
    signal?: AbortSignal;
    /**
     * Decoders tried in turn for `Packages.xz` (Node has none built in): by default the host's `xz`,
     * `xzcat` (busybox) or Python's `lzma`. An empty list uses `Packages.gz` or `Packages` only.
     */
    unxz?: ReadonlyArray<(data: Buffer) => AsyncIterable<Buffer>>;
}

/** Thrown when the index cannot be fetched or does not verify; callers do not block on it. */
export class AgentImagePackageIndexUnavailableError extends Error {}

/** Some configured package is not in the agent image's apt sources. The message lists every bad name. */
export class AgentRuntimePackageUnavailableError extends Error {
    constructor(readonly unknown: string[], readonly errors: string[]) {
        super(`Agent runtime packages are not available from the agent image's apt sources (${sourcesLabel()}): ${errors.join('; ')}. `
            + 'The run was not started; correct the package list in Settings.');
        this.name = 'AgentRuntimePackageUnavailableError';
    }
}

function sourcesLabel(sources: readonly AgentImageAptSource[] = AGENT_IMAGE_APT_SOURCES) {
    return sources.map(source => `${source.suite} ${source.component}`).join(', ');
}

/** `<hash> <size> <path>` entries of the InRelease SHA256 section. */
export function parseInReleaseSha256(text: string): Map<string, { sha256: string; size: number }> {
    const entries = new Map<string, { sha256: string; size: number }>();
    let inSection = false;
    for (const line of text.split('\n')) {
        if (/^\S/.test(line)) { inSection = line.trimEnd() === 'SHA256:'; continue; }
        if (!inSection) continue;
        const match = /^\s+([0-9a-f]{64})\s+(\d+)\s+(\S+)\s*$/.exec(line);
        if (match) entries.set(match[3], { sha256: match[1], size: Number(match[2]) });
    }
    return entries;
}

/** The package name of a `Provides` or `Package` entry: no version constraint, no architecture qualifier. */
function relationName(value: string) {
    return value.trim().split(/[\s(]/, 1)[0].split(':', 1)[0].toLowerCase();
}

/** Streams a Packages file into the index: only `Package`, `Version` and `Provides` fields are kept. */
export async function addPackagesToIndex(lines: AsyncIterable<Buffer | string>, index: Pick<AgentImagePackageIndex, 'packages' | 'provides'>) {
    let name: string | undefined;
    let version: string | undefined;
    let field: string | undefined;
    const flush = () => {
        if (name) {
            const versions = index.packages.get(name) ?? new Set<string>();
            if (version) versions.add(version);
            index.packages.set(name, versions);
        }
        name = version = field = undefined;
    };
    const handle = (line: string) => {
        if (line === '' || line === '\r') { flush(); return; }
        if (/^\s/.test(line)) {
            if (field === 'provides') for (const part of line.split(',')) addProvide(part);
            return;
        }
        const colon = line.indexOf(':');
        if (colon < 1) { field = undefined; return; }
        field = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (field === 'package') name = value.toLowerCase();
        else if (field === 'version') version = value;
        else if (field === 'provides') for (const part of value.split(',')) addProvide(part);
    };
    const addProvide = (part: string) => { const provided = relationName(part); if (provided) index.provides.add(provided); };
    let rest = '';
    for await (const chunk of lines) {
        rest += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let newline: number;
        while ((newline = rest.indexOf('\n')) !== -1) {
            handle(rest.slice(0, newline));
            rest = rest.slice(newline + 1);
        }
    }
    if (rest) handle(rest);
    flush();
}

async function fetchBytes(fetcher: FetchLike, url: string, signal: AbortSignal, limit: number): Promise<Buffer> {
    const response = await fetcher(url, { signal });
    if (!response.ok) throw new AgentImagePackageIndexUnavailableError(`${url} returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new AgentImagePackageIndexUnavailableError(`${url} is larger than expected`);
    return bytes;
}

/** Streams `data` through a host decompressor; a missing binary or a non-zero exit is an error. */
function spawnDecoder(command: string, args: string[]) {
    return (data: Buffer): AsyncIterable<Buffer> => {
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
        const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        closed.catch(() => {});
        child.stdin.on('error', () => {});
        child.stdin.end(data);
        return (async function* () {
            for await (const chunk of child.stdout) yield chunk as Buffer;
            const code = await closed;
            if (code !== 0) throw new Error(`${command} exited with code ${code}`);
        })();
    };
}

const HOST_XZ_DECODERS = [
    spawnDecoder('xz', ['-dc']),
    spawnDecoder('xzcat', []),
    spawnDecoder('python3', ['-I', '-c', 'import lzma, shutil, sys; shutil.copyfileobj(lzma.open(sys.stdin.buffer), sys.stdout.buffer)']),
];

function mergeIndex(index: AgentImagePackageIndex, part: Pick<AgentImagePackageIndex, 'packages' | 'provides'>) {
    for (const [name, versions] of part.packages) {
        const existing = index.packages.get(name);
        if (existing) for (const version of versions) existing.add(version);
        else index.packages.set(name, versions);
    }
    for (const name of part.provides) index.provides.add(name);
}

async function loadSource(source: AgentImageAptSource, architecture: string, index: AgentImagePackageIndex,
    { fetcher, signal, unxz }: { fetcher: FetchLike; signal: AbortSignal; unxz: NonNullable<AgentImagePackageIndexOptions['unxz']> }) {
    const dist = `${source.url}/dists/${source.suite}`;
    const release = parseInReleaseSha256((await fetchBytes(fetcher, `${dist}/InRelease`, signal, 4 * 1024 ** 2)).toString('utf8'));
    const base = `${source.component}/binary-${architecture}/Packages`;
    // InRelease also lists files the archive no longer serves (an uncompressed Packages), so each listed form is tried.
    const forms: Array<{ suffix: string; decoders: ReadonlyArray<(data: Buffer) => AsyncIterable<Buffer>> }> = [
        { suffix: '.xz', decoders: unxz },
        { suffix: '.gz', decoders: [data => Readable.from([data]).pipe(createGunzip())] },
        { suffix: '', decoders: [data => Readable.from([data])] },
    ];
    let lastError: unknown;
    for (const { suffix, decoders } of forms) {
        const entry = release.get(base + suffix);
        if (!entry || entry.size > INDEX_SIZE_LIMIT || decoders.length === 0) continue;
        const url = `${dist}/${base}${suffix}`;
        let data: Buffer;
        try {
            data = await fetchBytes(fetcher, url, signal, entry.size);
            if (data.length !== entry.size || crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256)
                throw new AgentImagePackageIndexUnavailableError(`${url} does not match its InRelease checksum`);
        } catch (error) {
            signal.throwIfAborted();
            lastError = error;
            continue;
        }
        for (const decode of decoders) {
            try {
                // Parse into a scratch index, so a decoder that fails halfway adds nothing.
                const scratch = { packages: new Map<string, Set<string>>(), provides: new Set<string>() };
                await addPackagesToIndex(decode(data), scratch);
                mergeIndex(index, scratch);
                return;
            } catch (error) {
                signal.throwIfAborted();
                lastError = error;
            }
        }
    }
    throw new AgentImagePackageIndexUnavailableError(`No usable ${base} index in ${dist}`, { cause: lastError });
}

/** Downloads and parses the index of every apt source; verified against each suite's InRelease SHA256 list. */
export async function fetchAgentImagePackageIndex(options: AgentImagePackageIndexOptions = {}): Promise<AgentImagePackageIndex> {
    const fetcher = options.fetch ?? (fetch as unknown as FetchLike);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const index: AgentImagePackageIndex = { packages: new Map(), provides: new Set(), loadedAt: Date.now() };
    const unxz = options.unxz ?? HOST_XZ_DECODERS;
    for (const source of options.sources ?? AGENT_IMAGE_APT_SOURCES)
        await loadSource(source, options.architecture ?? AGENT_IMAGE_ARCHITECTURE, index, { fetcher, signal, unxz });
    if (index.packages.size === 0) throw new AgentImagePackageIndexUnavailableError('The package index is empty');
    return index;
}

type IndexLoader = (signal?: AbortSignal) => Promise<AgentImagePackageIndex>;
let loader: IndexLoader = signal => fetchAgentImagePackageIndex({ signal });
let cached: AgentImagePackageIndex | undefined;
let loading: Promise<AgentImagePackageIndex> | undefined;
let failure: { error: unknown; at: number } | undefined;

/**
 * The cached index, refreshed after four hours. Concurrent callers share one download. A failed
 * refresh keeps the previous index for a day; without one, the failure is replayed for five
 * minutes so an offline host does not wait on the network for every request.
 */
export async function getAgentImagePackageIndex(signal?: AbortSignal): Promise<AgentImagePackageIndex> {
    const now = Date.now();
    if (cached && now - cached.loadedAt < INDEX_TTL_MS) return cached;
    if (failure && now - failure.at < FAILURE_TTL_MS) {
        if (cached && now - cached.loadedAt < STALE_LIMIT_MS) return cached;
        throw failure.error;
    }
    // The shared download is not tied to one caller's signal; each caller stops waiting on its own.
    loading ??= loader().then(index => { cached = index; failure = undefined; return index; }, error => {
        failure = { error, at: Date.now() };
        logger.warn({ err: error }, 'Could not fetch the agent image package index');
        throw error;
    }).finally(() => { loading = undefined; });
    const pending = loading;
    try {
        return await (signal ? Promise.race([pending, new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })]) : pending);
    } catch (error) {
        if (!signal?.aborted && cached && Date.now() - cached.loadedAt < STALE_LIMIT_MS) return cached;
        throw error;
    }
}

/** Test seam: replace the index source and forget the cache. */
export function setAgentImagePackageIndexLoader(next?: IndexLoader) {
    loader = next ?? (signal => fetchAgentImagePackageIndex({ signal }));
    cached = undefined;
    loading = undefined;
    failure = undefined;
}

function specParts(spec: string) {
    const separator = spec.indexOf('=');
    const unpinned = separator === -1 ? spec : spec.slice(0, separator);
    return { name: unpinned.split(':', 1)[0], version: separator === -1 ? undefined : spec.slice(separator + 1) };
}

/**
 * The errors for specs the index cannot satisfy: `Unknown package: <name>` for a name that is
 * neither a package nor provided by one, and `Unknown version: <name>=<version>` for a pin the
 * index does not carry (apt cannot pin a virtual package).
 */
export function findUnavailableAgentRuntimePackages(index: AgentImagePackageIndex, packages: readonly string[]) {
    const unknown: string[] = [];
    const errors: string[] = [];
    for (const spec of packages) {
        const { name, version } = specParts(spec);
        const versions = index.packages.get(name);
        if (!versions && !index.provides.has(name)) { unknown.push(spec); errors.push(`Unknown package: ${name}`); }
        else if (version !== undefined && !versions?.has(version)) { unknown.push(spec); errors.push(`Unknown version: ${spec}`); }
    }
    return { unknown, errors };
}

export const AGENT_RUNTIME_PACKAGE_INDEX_WARNING = 'could not verify availability';

/**
 * Settings and CLI validation without Docker. Syntax errors and names the index lacks make the list
 * invalid; an index that cannot be fetched leaves it valid with a `could not verify availability`
 * warning, since the runtime's own apt install still reports a bad name.
 */
export type AgentRuntimePackageIndexValidation = AgentRuntimePackageAvailabilityResult & { warnings: string[] };

export async function validateAgentRuntimePackagesWithIndex(packages: unknown, signal?: AbortSignal): Promise<AgentRuntimePackageIndexValidation> {
    const syntax = validateAgentRuntimePackages(packages);
    const sources = [{ packageManager: 'apt' as const, osName: AGENT_IMAGE_PACKAGE_INDEX_NAME, images: [] as string[] }];
    if (!syntax.valid || syntax.packages.length === 0) return { ...syntax, availability: [], sources: [], warnings: [] };
    let index: AgentImagePackageIndex;
    try { index = await getAgentImagePackageIndex(signal); }
    catch (error) {
        if (signal?.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        return { ...syntax, availability: [], sources: [], warnings: [`${AGENT_RUNTIME_PACKAGE_INDEX_WARNING}: the ${AGENT_IMAGE_PACKAGE_INDEX_NAME} could not be fetched (${reason})`] };
    }
    const { unknown, errors } = findUnavailableAgentRuntimePackages(index, syntax.packages);
    const availability = syntax.packages.map(spec => ({ package: spec, available: !unknown.includes(spec), unavailableOn: unknown.includes(spec) ? [AGENT_IMAGE_PACKAGE_INDEX_NAME] : [] }));
    return { valid: errors.length === 0, packages: syntax.packages, errors, availability, sources, warnings: [] };
}

/**
 * Before a Fly build, a Fly Machine start-time install or Sprite provisioning: throws
 * `AgentRuntimePackageUnavailableError` for names the index lacks, so no Machine or Sprite is
 * created to install them. An index that cannot be fetched lets the run go ahead; the build or
 * provisioning failure cache is the safety net then.
 */
export async function assertAgentRuntimePackagesInIndex(packages: readonly string[], signal?: AbortSignal): Promise<void> {
    if (packages.length === 0) return;
    let index: AgentImagePackageIndex;
    try { index = await getAgentImagePackageIndex(signal); }
    catch (error) {
        if (signal?.aborted) throw error;
        logger.warn({ err: error }, 'Could not verify agent runtime packages against the package index; continuing without the check');
        return;
    }
    const { unknown, errors } = findUnavailableAgentRuntimePackages(index, packages);
    if (errors.length) throw new AgentRuntimePackageUnavailableError(unknown, errors);
}

export type AgentRuntimePackageAvailabilityCheck = (packages: readonly string[], signal?: AbortSignal) => Promise<void>;

/**
 * Reads the configured runtime package list. `checkAvailability`, when present, is the archive check a
 * runtime runs only before a new installation (a build, a start-time install or a fresh Sprite): an
 * environment already built with the list (a derived image, a clean Sprite checkpoint) has the packages,
 * even if the archive has since dropped a pinned version.
 */
export type AgentRuntimePackageLoader = (() => Promise<readonly string[]>) & { checkAvailability?: AgentRuntimePackageAvailabilityCheck };

/** A package source whose list is checked against the index before each new installation (not on every read). */
export function indexCheckedAgentRuntimePackages(load: () => Promise<readonly string[]>,
    check: AgentRuntimePackageAvailabilityCheck = assertAgentRuntimePackagesInIndex): AgentRuntimePackageLoader {
    return Object.assign(() => load(), { checkAvailability: check });
}

/** Runs the source's availability check before a new installation of `packages`; nothing to install, nothing to check. */
export async function checkAgentRuntimePackagesBeforeInstall(source: AgentRuntimePackageLoader, packages: readonly string[], signal?: AbortSignal) {
    if (packages.length > 0 && source.checkAvailability) await source.checkAvailability(packages, signal);
}
