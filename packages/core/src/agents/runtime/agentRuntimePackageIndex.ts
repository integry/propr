import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import logger from '../../utils/logger.js';
import type { AgentRuntimePackageAvailabilityResult } from './agentRuntimePackageCatalog.js';
import { validateAgentRuntimePackages } from './agentRuntimePackageProfile.js';
import { AGENT_IMAGE_APT_SOURCES, AGENT_IMAGE_ARCHITECTURE, AGENT_IMAGE_PACKAGE_BASE, AGENT_IMAGE_PACKAGE_INDEX_NAME,
    type AgentImageAptSource, type AgentRuntimePackageBase } from './agentRuntimePackageBases.js';
import { startupStep } from './startupStep.js';

/**
 * A Docker-free package availability check: package names are resolved against
 * the apt sources of the runtime that installs them (`agentRuntimePackageBases.ts`),
 * read straight from the archive over HTTPS. Settings checks each runtime in use
 * against its own base, and the Fly Machines and Sprites runtimes re-check against
 * theirs before a new installation (a Fly derived image build, a Fly Machine start-time
 * install or a fresh Sprite); an environment already built with the list (a derived image,
 * a warm Sprite's clean checkpoint) is reused without it.
 */

export { AGENT_IMAGE_APT_SOURCES, AGENT_IMAGE_ARCHITECTURE, AGENT_IMAGE_PACKAGE_BASE, AGENT_IMAGE_PACKAGE_INDEX_NAME,
    type AgentImageAptSource, type AgentRuntimePackageBase };

const INDEX_TTL_MS = 4 * 60 * 60_000;
/** A refresh that fails keeps serving the last index for this long. */
const STALE_LIMIT_MS = 24 * 60 * 60_000;
/** After a failed load (offline host, private mirror), callers do not wait on the network again for this long. */
const FAILURE_TTL_MS = 5 * 60_000;
// Ubuntu's universe index alone is ~16 MB compressed (~77 MB plain), so a Sprite base needs room.
const FETCH_TIMEOUT_MS = 3 * 60_000;
const INDEX_SIZE_LIMIT = 128 * 1024 ** 2;

/**
 * A compact index: only what the checks need, not the parsed stanzas. `names` holds real packages and
 * every name some package `Provides` (virtual packages); `pins` holds `<name>=<version>` of real packages.
 */
export interface AgentImagePackageIndex {
    names: Set<string>;
    pins: Set<string>;
    loadedAt: number;
}
type IndexSets = Pick<AgentImagePackageIndex, 'names' | 'pins'>;

/** An index of `{ name: versions }` and provided names; for tests and fixtures. */
export function createAgentImagePackageIndex(packages: Record<string, readonly string[]>, provides: readonly string[] = []): AgentImagePackageIndex {
    const names = new Set([...Object.keys(packages), ...provides]);
    const pins = new Set(Object.entries(packages).flatMap(([name, versions]) => versions.map(version => `${name}=${version}`)));
    return { names, pins, loadedAt: Date.now() };
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

/** Some configured package is not in the installing runtime's apt sources. The message lists every bad name. */
export class AgentRuntimePackageUnavailableError extends Error {
    constructor(readonly unknown: string[], readonly errors: string[], base: AgentRuntimePackageBase = AGENT_IMAGE_PACKAGE_BASE, runtime?: string) {
        super(`Agent runtime packages are not available ${runtime ? `to ${runtime} ` : ''}from the ${base.label} apt sources (${sourcesLabel(base.sources)}): ${errors.join('; ')}. `
            + 'The run was not started; correct the package list in Settings.');
        this.name = 'AgentRuntimePackageUnavailableError';
    }
}

function sourcesLabel(sources: readonly AgentImageAptSource[]) {
    const suites = [...new Set(sources.map(source => source.suite))];
    return suites.map(suite => `${suite} ${sources.filter(source => source.suite === suite).map(source => source.component).join('/')}`).join(', ');
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
export async function addPackagesToIndex(lines: AsyncIterable<Buffer | string>, index: IndexSets) {
    let name: string | undefined;
    let version: string | undefined;
    let field: string | undefined;
    const flush = () => {
        if (name) {
            index.names.add(name);
            if (version) index.pins.add(`${name}=${version}`);
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
    const addProvide = (part: string) => { const provided = relationName(part); if (provided) index.names.add(provided); };
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

function mergeIndex(index: IndexSets, part: IndexSets) {
    for (const name of part.names) index.names.add(name);
    for (const pin of part.pins) index.pins.add(pin);
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
                const scratch: IndexSets = { names: new Set(), pins: new Set() };
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
    const index: AgentImagePackageIndex = { names: new Set(), pins: new Set(), loadedAt: Date.now() };
    const unxz = options.unxz ?? HOST_XZ_DECODERS;
    for (const source of options.sources ?? AGENT_IMAGE_APT_SOURCES)
        await loadSource(source, options.architecture ?? AGENT_IMAGE_ARCHITECTURE, index, { fetcher, signal, unxz });
    if (index.names.size === 0) throw new AgentImagePackageIndexUnavailableError('The package index is empty');
    return index;
}

/** Loads the index of one package base; the default fetches it from the base's archives. */
type IndexLoader = (signal: AbortSignal | undefined, base: AgentRuntimePackageBase) => Promise<AgentImagePackageIndex>;
const fetchBase: IndexLoader = (signal, base) => fetchAgentImagePackageIndex({ signal, sources: base.sources, architecture: base.architecture });
let loader: IndexLoader = fetchBase;
interface CacheEntry { cached?: AgentImagePackageIndex; loading?: Promise<AgentImagePackageIndex>; failure?: { error: unknown; at: number } }
const caches = new Map<string, CacheEntry>();

/**
 * The cached index of `base` (the agent image's by default), refreshed after four hours. Concurrent
 * callers share one download. A failed refresh keeps the previous index for a day; without one, the
 * failure is replayed for five minutes so an offline host does not wait on the network for every request.
 */
export async function getAgentImagePackageIndex(signal?: AbortSignal, base: AgentRuntimePackageBase = AGENT_IMAGE_PACKAGE_BASE): Promise<AgentImagePackageIndex> {
    let entry = caches.get(base.key);
    if (!entry) caches.set(base.key, entry = {});
    const now = Date.now();
    const { cached, failure } = entry;
    if (cached && now - cached.loadedAt < INDEX_TTL_MS) return cached;
    if (failure && now - failure.at < FAILURE_TTL_MS) {
        if (cached && now - cached.loadedAt < STALE_LIMIT_MS) return cached;
        throw failure.error;
    }
    // The shared download is not tied to one caller's signal; each caller stops waiting on its own.
    const owner = entry;
    owner.loading ??= loader(undefined, base).then(index => { owner.cached = index; owner.failure = undefined; return index; }, error => {
        owner.failure = { error, at: Date.now() };
        logger.warn({ err: error, base: base.label }, 'Could not fetch the agent runtime package index');
        throw error;
    }).finally(() => { owner.loading = undefined; });
    const pending = owner.loading;
    try {
        return await (signal ? startupStep(signal, () => pending) : pending);
    } catch (error) {
        const stale = owner.cached;
        // A caller's deadline (a timeout reason) still gets the previous index; an explicit cancellation does not.
        const cancelled = signal?.aborted && !(signal.reason instanceof Error && signal.reason.name === 'TimeoutError');
        if (!cancelled && stale && Date.now() - stale.loadedAt < STALE_LIMIT_MS) return stale;
        throw error;
    }
}

/** Starts loading the indexes of `bases` in the background (worker start), so the first check does not wait on it. */
export function warmAgentRuntimePackageIndexes(bases: readonly AgentRuntimePackageBase[]): void {
    for (const base of new Map(bases.map(candidate => [candidate.key, candidate])).values())
        void getAgentImagePackageIndex(undefined, base).catch(() => { /* Logged by the loader; checks retry on demand. */ });
}

/** Test seam: replace the index source and forget every cached index. */
export function setAgentImagePackageIndexLoader(next?: (signal?: AbortSignal, base?: AgentRuntimePackageBase) => Promise<AgentImagePackageIndex>) {
    loader = next ?? fetchBase;
    caches.clear();
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
        if (!index.names.has(name)) { unknown.push(spec); errors.push(`Unknown package: ${name}`); }
        else if (version !== undefined && !index.pins.has(`${name}=${version}`)) { unknown.push(spec); errors.push(`Unknown version: ${spec}`); }
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

/**
 * The runtimes that install from one package base, e.g. Sprites from the Sprite base image, or Docker
 * and Fly Machines from the agent image. Their names prefix each error ("Sprites (Ubuntu …): …").
 */
export interface AgentRuntimePackageTarget { runtimes: readonly string[]; base: AgentRuntimePackageBase }

/** Merges targets that share a base, so each index is read once and its errors name every runtime. */
function groupTargets(targets: readonly AgentRuntimePackageTarget[]): AgentRuntimePackageTarget[] {
    const grouped = new Map<string, { runtimes: string[]; base: AgentRuntimePackageBase }>();
    for (const target of targets) {
        const entry = grouped.get(target.base.key) ?? { runtimes: [], base: target.base };
        for (const runtime of target.runtimes) if (!entry.runtimes.includes(runtime)) entry.runtimes.push(runtime);
        grouped.set(target.base.key, entry);
    }
    return [...grouped.values()];
}

const targetName = (target: AgentRuntimePackageTarget) => target.runtimes.length ? `${target.runtimes.join(' and ')} (${target.base.label})` : undefined;

/** The signal index waits observe: the caller's, bounded by `deadlineMs` when given. */
function indexWait(signal: AbortSignal | undefined, deadlineMs: number | undefined) {
    if (deadlineMs === undefined) return { wait: signal, timedOut: () => false };
    const deadline = AbortSignal.timeout(Math.max(0, deadlineMs));
    return { wait: signal ? AbortSignal.any([signal, deadline]) : deadline, timedOut: () => deadline.aborted };
}

/**
 * Checks `packages` against every target's index; with no targets, against the agent image's index
 * with unprefixed errors (`Unknown package: <name>`). `deadlineMs` bounds the wait on index downloads
 * for the whole call (a request handler passes less than its own deadline): an index not loaded by
 * then is reported with the `could not verify availability` warning, like one that cannot be fetched,
 * and keeps loading in the background for later checks. Aborting `signal` still rejects.
 */
export async function validateAgentRuntimePackagesWithIndex(packages: unknown, signal?: AbortSignal,
    targets: readonly AgentRuntimePackageTarget[] = [], { deadlineMs }: { deadlineMs?: number } = {}): Promise<AgentRuntimePackageIndexValidation> {
    const syntax = validateAgentRuntimePackages(packages);
    if (!syntax.valid || syntax.packages.length === 0) return { ...syntax, availability: [], sources: [], warnings: [] };
    const { wait, timedOut } = indexWait(signal, deadlineMs);
    const groups = targets.length ? groupTargets(targets) : [{ runtimes: [], base: AGENT_IMAGE_PACKAGE_BASE }];
    const errors: string[] = [];
    const warnings: string[] = [];
    const unavailableOn = new Map(syntax.packages.map(spec => [spec, [] as string[]]));
    const sources: AgentRuntimePackageAvailabilityResult['sources'] = [];
    for (const target of groups) {
        const name = targetName(target);
        const indexName = target.base.key === AGENT_IMAGE_PACKAGE_BASE.key ? AGENT_IMAGE_PACKAGE_INDEX_NAME : `${target.base.label} package index`;
        let index: AgentImagePackageIndex;
        try { index = await getAgentImagePackageIndex(wait, target.base); }
        catch (error) {
            if (signal?.aborted) throw error;
            const reason = timedOut() ? `not loaded within ${deadlineMs}ms` : error instanceof Error ? error.message : String(error);
            warnings.push(`${AGENT_RUNTIME_PACKAGE_INDEX_WARNING}${name ? ` for ${name}` : ''}: the ${indexName} could not be fetched (${reason})`);
            continue;
        }
        sources.push({ packageManager: 'apt', osName: name ?? indexName, images: [] });
        const found = findUnavailableAgentRuntimePackages(index, syntax.packages);
        errors.push(...found.errors.map(error => name ? `${name}: ${error}` : error));
        for (const spec of found.unknown) unavailableOn.get(spec)?.push(name ?? indexName);
    }
    const availability = syntax.packages.map(spec => ({ package: spec, available: unavailableOn.get(spec)!.length === 0, unavailableOn: unavailableOn.get(spec)! }));
    return { valid: errors.length === 0, packages: syntax.packages, errors, availability, sources, warnings };
}

/**
 * Before a Fly derived image build, a Fly Machine start-time install or Sprite provisioning: throws
 * `AgentRuntimePackageUnavailableError` for names the base's index lacks, so no Machine or Sprite is
 * created to install them. An index that cannot be fetched lets the run go ahead; the apt
 * install itself still reports a bad name then.
 */
export async function assertAgentRuntimePackagesInIndex(packages: readonly string[], signal?: AbortSignal,
    base: AgentRuntimePackageBase = AGENT_IMAGE_PACKAGE_BASE, runtime?: string): Promise<void> {
    if (packages.length === 0) return;
    let index: AgentImagePackageIndex;
    try { index = await getAgentImagePackageIndex(signal, base); }
    catch (error) {
        if (signal?.aborted) throw error;
        logger.warn({ err: error, base: base.label, runtime }, 'Could not verify agent runtime packages against the package index; continuing without the check');
        return;
    }
    const { unknown, errors } = findUnavailableAgentRuntimePackages(index, packages);
    if (errors.length) throw new AgentRuntimePackageUnavailableError(unknown, errors, base, runtime);
}

export type AgentRuntimePackageAvailabilityCheck = (packages: readonly string[], signal?: AbortSignal) => Promise<void>;

/**
 * Reads the configured runtime package list. `checkAvailability`, when present, is the archive check a
 * runtime runs only before a new installation (a Fly derived image build, a Fly Machine start-time install
 * or a fresh Sprite): an environment already built with the list (a derived image, a warm Sprite's clean
 * checkpoint) has the packages, even if the archive has since dropped a name or a pinned version.
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
