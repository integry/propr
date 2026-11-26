import crypto from 'node:crypto';
import logger from '../../utils/logger.js';

/**
 * The apt "package bases" runtime package names are checked against. Each runtime installs the
 * packages from its own apt sources: Docker and Fly Machines from the agent image (`Dockerfile.agent`),
 * Sprites from Fly's Sprite base image, which is Ubuntu, not the agent image. A list is validated
 * against the base of each runtime that will install it.
 */

/** One apt source: `<url>/dists/<suite>/<component>/binary-<arch>/Packages`. */
export interface AgentImageAptSource { url: string; suite: string; component: string }

export interface AgentRuntimePackageBase {
    /** Stable identity of the sources and architecture; indexes are cached per key. */
    key: string;
    /** Human-readable distribution, e.g. "Debian 12 (bookworm)". */
    label: string;
    sources: readonly AgentImageAptSource[];
    architecture: string;
}

export function packageBase(label: string, sources: readonly AgentImageAptSource[], architecture: string): AgentRuntimePackageBase {
    const key = crypto.createHash('sha256')
        .update(JSON.stringify({ architecture, sources: sources.map(source => [source.url, source.suite, source.component]) }))
        .digest('hex').slice(0, 16);
    return { key, label, sources, architecture };
}

// node:<version>-bookworm-slim ships deb.debian.org bookworm, bookworm-updates and bookworm-security
// with the main component; Dockerfile.agent adds GitHub's own apt repository for gh. A test parses
// Dockerfile.agent and fails when it adds a source missing here.
export const AGENT_IMAGE_APT_SOURCES: readonly AgentImageAptSource[] = [
    { url: 'https://deb.debian.org/debian', suite: 'bookworm', component: 'main' },
    { url: 'https://deb.debian.org/debian', suite: 'bookworm-updates', component: 'main' },
    { url: 'https://deb.debian.org/debian-security', suite: 'bookworm-security', component: 'main' },
    { url: 'https://cli.github.com/packages', suite: 'stable', component: 'main' },
];
/** Dockerfile.agent builds linux/amd64 only (AGENT_PLATFORM). */
export const AGENT_IMAGE_ARCHITECTURE = 'amd64';
export const AGENT_IMAGE_PACKAGE_INDEX_NAME = 'Debian 12 (bookworm) package index';
export const AGENT_IMAGE_PACKAGE_BASE = packageBase('Debian 12 (bookworm)', AGENT_IMAGE_APT_SOURCES, AGENT_IMAGE_ARCHITECTURE);

const UBUNTU_COMPONENTS = ['main', 'restricted', 'universe', 'multiverse'];
const ubuntuSources = (codename: string) => [
    ...[codename, `${codename}-updates`, `${codename}-backports`].flatMap(suite =>
        UBUNTU_COMPONENTS.map(component => ({ url: 'https://archive.ubuntu.com/ubuntu', suite, component }))),
    ...UBUNTU_COMPONENTS.map(component => ({ url: 'https://security.ubuntu.com/ubuntu', suite: `${codename}-security`, component })),
];

/**
 * The Sprite base until a provisioned Sprite reports its own: Fly moved new Sprites to Ubuntu 26.04 LTS
 * (resolute) in July 2026, with Ubuntu's default sources. Provisioning reads `/etc/os-release` and the
 * apt sources of every new Sprite and records what it finds (`SPRITE_PACKAGE_BASE_CONFIG_KEY`).
 */
export const DEFAULT_SPRITE_PACKAGE_BASE = packageBase('Ubuntu 26.04 LTS (resolute)', ubuntuSources('resolute'), 'amd64');
export const SPRITE_PACKAGE_BASE_CONFIG_KEY = 'sprites_package_base';

/** Archives are read over HTTPS; a source that only serves plain HTTP leaves the index unavailable. */
function normalizeSourceUrl(url: string) {
    return url.replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
}

function pushSources(target: AgentImageAptSource[], uris: string[], suites: string[], components: string[]) {
    for (const uri of uris) {
        if (!/^https?:\/\/[^\s/]+/i.test(uri)) continue;
        for (const suite of suites) {
            // A flat repository ("./" or "suite/") has no dists/<suite>/<component> layout.
            if (!suite || suite.endsWith('/') || !/^[A-Za-z0-9._-]+$/.test(suite)) continue;
            for (const component of components) {
                if (!/^[A-Za-z0-9._/-]+$/.test(component)) continue;
                const source = { url: normalizeSourceUrl(uri), suite, component };
                if (!target.some(existing => existing.url === source.url && existing.suite === suite && existing.component === component)) target.push(source);
            }
        }
    }
}

/** Binary (`deb`) sources from one-line `sources.list` entries. */
export function parseOneLineAptSources(text: string): AgentImageAptSource[] {
    const sources: AgentImageAptSource[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        const match = /^deb\s+(?:\[[^\]]*\]\s+)?(\S+)\s+(\S+)\s+(.+)$/.exec(line);
        if (match) pushSources(sources, [match[1]], [match[2]], match[3].split(/\s+/));
    }
    return sources;
}

/** Binary sources from deb822 `.sources` stanzas (Ubuntu 24.04 and later ship `ubuntu.sources`). */
export function parseDeb822AptSources(text: string): AgentImageAptSource[] {
    const sources: AgentImageAptSource[] = [];
    for (const stanza of text.split(/\n\s*\n/)) {
        const fields = new Map<string, string>();
        let last: string | undefined;
        for (const line of stanza.split('\n')) {
            if (/^\s*#/.test(line)) continue;
            if (/^\s/.test(line) && last) { fields.set(last, `${fields.get(last)} ${line.trim()}`); continue; }
            const colon = line.indexOf(':');
            if (colon < 1) continue;
            last = line.slice(0, colon).trim().toLowerCase();
            fields.set(last, line.slice(colon + 1).trim());
        }
        const list = (name: string) => (fields.get(name) ?? '').split(/\s+/).filter(Boolean);
        if (!list('types').includes('deb') || /^(no|false|0)$/i.test(fields.get('enabled') ?? '')) continue;
        pushSources(sources, list('uris'), list('suites'), list('components'));
    }
    return sources;
}

/** `/etc/os-release` as a label: "Ubuntu 26.04 LTS (resolute)". */
export function osReleaseLabel(text: string): string | undefined {
    const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim().replace(/^"|"$/g, '');
    const pretty = value('PRETTY_NAME') ?? [value('NAME'), value('VERSION_ID')].filter(Boolean).join(' ');
    if (!pretty) return undefined;
    const codename = value('VERSION_CODENAME');
    return codename && !pretty.toLowerCase().includes(codename.toLowerCase()) ? `${pretty} (${codename})` : pretty;
}

const PROBE_MARKERS = { arch: '@@propr-arch', list: '@@propr-list', deb822: '@@propr-deb822' };
/** argv that prints a Sprite's os-release, architecture and apt sources, both formats; read-only, no root needed. */
export const SPRITE_PACKAGE_BASE_PROBE = ['/bin/sh', '-c', [
    'cat /etc/os-release 2>/dev/null',
    `echo ${PROBE_MARKERS.arch}`, 'dpkg --print-architecture 2>/dev/null',
    `echo ${PROBE_MARKERS.list}`, 'cat /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null',
    `echo ${PROBE_MARKERS.deb822}`, 'for f in /etc/apt/sources.list.d/*.sources; do [ -f "$f" ] && cat "$f" && echo; done',
    'true',
].join('\n')];

/** The base a probe reports; undefined when it lists no usable apt source. */
export function parseSpritePackageBaseProbe(stdout: string): AgentRuntimePackageBase | undefined {
    const at = (marker: string) => stdout.indexOf(`${marker}\n`);
    const [arch, list, deb822] = [at(PROBE_MARKERS.arch), at(PROBE_MARKERS.list), at(PROBE_MARKERS.deb822)];
    if (arch < 0 || list < arch || deb822 < list) return undefined;
    const section = (start: number, marker: string, end?: number) => stdout.slice(start + marker.length + 1, end);
    const architecture = section(arch, PROBE_MARKERS.arch, list).trim() || 'amd64';
    const sources = [...parseOneLineAptSources(section(list, PROBE_MARKERS.list, deb822)), ...parseDeb822AptSources(section(deb822, PROBE_MARKERS.deb822))];
    if (!/^[a-z0-9-]+$/.test(architecture) || sources.length === 0) return undefined;
    return packageBase(osReleaseLabel(stdout.slice(0, arch)) ?? 'Sprite base image', sources, architecture);
}

function storedBase(value: unknown): AgentRuntimePackageBase | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Partial<AgentRuntimePackageBase>;
    const sources = Array.isArray(raw.sources) ? raw.sources.filter((source): source is AgentImageAptSource =>
        !!source && typeof source.url === 'string' && /^https:\/\//.test(source.url) && typeof source.suite === 'string' && typeof source.component === 'string') : [];
    if (typeof raw.label !== 'string' || typeof raw.architecture !== 'string' || sources.length === 0) return undefined;
    return packageBase(raw.label, sources, raw.architecture);
}

/** The Sprite base the last provisioned Sprite reported, or the documented default before any did. */
export async function loadSpritePackageBase(): Promise<AgentRuntimePackageBase> {
    try {
        const { getConfig } = await import('../../config/configStore.js');
        return storedBase(await getConfig<unknown>(SPRITE_PACKAGE_BASE_CONFIG_KEY, null)) ?? DEFAULT_SPRITE_PACKAGE_BASE;
    } catch {
        return DEFAULT_SPRITE_PACKAGE_BASE;
    }
}

/** Records a detected Sprite base; true when it differs from the one checks used until now. */
export async function recordSpritePackageBase(base: AgentRuntimePackageBase): Promise<boolean> {
    const previous = await loadSpritePackageBase();
    if (previous.key === base.key) return false;
    const { saveConfig } = await import('../../config/configStore.js');
    await saveConfig(SPRITE_PACKAGE_BASE_CONFIG_KEY, { label: base.label, architecture: base.architecture, sources: base.sources, detectedAt: new Date().toISOString() });
    logger.info({ label: base.label, architecture: base.architecture, sourceCount: base.sources.length, previous: previous.label }, 'Detected the Sprite base image package sources');
    return true;
}

type ProbeSprite = { execFile(cmd: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }): Promise<{ stdout: unknown; exitCode?: number | null }> };

/**
 * Reads a new Sprite's distribution and apt sources and records them as the Sprites package base.
 * True when the base changed, so a list checked against the old one must be checked again.
 */
export async function detectSpritePackageBase(sprite: ProbeSprite, signal: AbortSignal): Promise<boolean> {
    const [command, ...args] = SPRITE_PACKAGE_BASE_PROBE;
    const result = await sprite.execFile(command, args, { signal, timeout: 30_000 });
    const base = parseSpritePackageBaseProbe(String(result.stdout ?? ''));
    if (!base) return false;
    return recordSpritePackageBase(base);
}
