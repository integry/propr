import fs from 'node:fs';
import path from 'node:path';
import { PinnedDirectory } from './privateDirectory.js';
import { assertProviderOwner, containerUidConfigurationError, isProviderOwnershipError } from './providerOwnership.js';
import { nativeDirectoryAllowed, nativeFileClass, type DiagnosticProvider } from './providerCollector.js';

export interface NativeLogRoot { provider: DiagnosticProvider; agent: string; root: string }
export interface NativeLogInventory {
    checkedAt: number;
    bytes: Record<ReturnType<typeof nativeFileClass>, number>;
    observedBytes: number;
    capacityBytesLowerBound?: number;
    capacityBasis?: 'diagnostic';
    allocatedBytes: number;
    availableBytes: number | null;
    inventoryComplete: boolean;
    entries: number;
    reason: 'protected-unbounded' | 'unsafe-root' | 'unsafe-entry' | 'unsupported-ownership' | 'scan-limit' | 'unmeasured-directory';
}
export const NATIVE_LOG_LIMITS = Object.freeze({ roots: 128, entries: 4096, scanMs: 250, passMs: 2000,
    rootBytes: 256 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, minimumFreeBytes: 256 * 1024 * 1024 });
export type NativeLogLimits = { [K in keyof typeof NATIVE_LOG_LIMITS]: number };
const providers = new Set(['codex', 'claude', 'antigravity', 'opencode', 'vibe']);

/** OS-admin configuration, never a member setting or an inferred personal home.
 * The declaration attests ownership; it does not authorize deletion. */
export function configuredNativeLogRoots(env: NodeJS.ProcessEnv = process.env): NativeLogRoot[] {
    if (env.PROPR_MANAGED_LOGS !== '1') return [];
    const raw = env.PROPR_NATIVE_LOG_ROOTS;
    if (!raw) return [];
    if (Buffer.byteLength(raw) > 32 * 1024) throw new Error('native log root configuration exceeds bound');
    const config = JSON.parse(raw);
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(env.PROPR_INSTANCE_ID ?? '')
        || config.instance !== env.PROPR_INSTANCE_ID || config.instanceOwned !== true
        || !Array.isArray(config.roots) || config.roots.length > NATIVE_LOG_LIMITS.roots) {
        throw new Error('native log roots require explicit instance ownership');
    }
    const roots: NativeLogRoot[] = [];
    for (const value of config.roots) {
        validateNativeLogRoot(value);
        // Overlapping roots would double-count bytes and blur ownership. The
        // shared Claude UI directory cannot acquire ownership by a declaration.
        if (value.root === '/tmp/claude-logs' || value.root.startsWith('/tmp/claude-logs/')
            || roots.some(r => r.root === value.root || r.root.startsWith(value.root + '/') || value.root.startsWith(r.root + '/'))) {
            throw new Error('overlapping or unowned native log roots');
        }
        roots.push({ provider: value.provider, agent: value.agent, root: value.root });
    }
    return roots;
}

function validateNativeLogRoot(value: NativeLogRoot): void {
    if (!value || !providers.has(value.provider) || typeof value.agent !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/.test(value.agent)
        || typeof value.root !== 'string' || value.root.length > 4096 || !path.isAbsolute(value.root)
        || value.root.includes('\0') || value.root.split('/').some((part: string) => part === '..' || part === '.')
        || path.normalize(value.root) !== value.root || value.root === '/') throw new Error('unsafe native log root configuration');
}

/** Metadata only: no credential reads, content copies, scratch files or native
 * mutations. Sparse multi-GB files cost one fstat. Unknown subtrees stay unknown. */
export function inspectNativeLogRoot(input: NativeLogRoot, limits: NativeLogLimits = NATIVE_LOG_LIMITS): NativeLogInventory {
    const result: NativeLogInventory = { checkedAt: Date.now(), bytes: { diagnostic: 0, session: 0, database: 0, 'auth-config': 0, unknown: 0 },
        observedBytes: 0, allocatedBytes: 0, availableBytes: null, inventoryComplete: true, entries: 0, reason: 'protected-unbounded' };
    const incomplete = (reason: NativeLogInventory['reason']) => {
        result.inventoryComplete = false;
        // A later scan bound or unknown directory cannot erase unsafe evidence.
        if (result.reason !== 'unsafe-entry' && result.reason !== 'unsafe-root' && result.reason !== 'unsupported-ownership') result.reason = reason;
    };
    const deadline = performance.now() + limits.scanMs;
    let root: PinnedDirectory | undefined;
    const inspectDirectory = (dir: PinnedDirectory, name: string, relative: string, stat: fs.Stats): void => {
        // Mixed ownership inside a supported root is an unsafe entry, not a UID mapping.
        if (stat.uid !== fs.fstatSync(root!.fd).uid) { incomplete('unsafe-entry'); return; }
        if (!nativeDirectoryAllowed(input.provider, relative)) { incomplete('unmeasured-directory'); return; }
        let child: PinnedDirectory | undefined;
        try {
            child = dir.child(name);
            const actual = fs.fstatSync(child.fd);
            if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error('replaced directory');
            assertProviderOwner(actual.uid, fs.fstatSync(root!.fd).uid);
            walk(child, relative + '/');
        } catch { incomplete('unsafe-entry'); }
        finally { child?.close(); }
    };
    const inspectFile = (dir: PinnedDirectory, name: string, relative: string, stat: fs.Stats): void => {
        let fd: number | undefined;
        try {
            fd = dir.file(name);
            const actual = fs.fstatSync(fd);
            if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error('replaced native entry');
            result.bytes[nativeFileClass(input.provider, relative)] += actual.size;
            result.observedBytes += actual.size;
            result.allocatedBytes += actual.blocks * 512;
        } catch { incomplete('unsafe-entry'); }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    };
    const walk = (dir: PinnedDirectory, prefix: string): void => {
        const listing = fs.opendirSync(`/proc/self/fd/${dir.fd}`);
        try {
            let entry: fs.Dirent | null;
            while ((entry = listing.readSync())) {
                if (result.entries >= limits.entries || performance.now() > deadline) { incomplete('scan-limit'); break; }
                result.entries++;
                const relative = prefix + entry.name;
                // lstat never follows the entry. Opening and fstat then validate
                // the actual object, including malicious replacement races.
                const stat = fs.lstatSync(dir.path(entry.name));
                if (stat.isDirectory()) inspectDirectory(dir, entry.name, relative, stat);
                else inspectFile(dir, entry.name, relative, stat);
                if (result.reason === 'scan-limit') break;
            }
        } finally { listing.closeSync(); }
    };
    try {
        root = PinnedDirectory.open(input.root);
        const capacity = fs.statfsSync(`/proc/self/fd/${root.fd}`);
        result.availableBytes = capacity.bavail * capacity.bsize;
        assertProviderOwner(fs.fstatSync(root.fd).uid);
        walk(root, '');
    } catch (e) { if (isProviderOwnershipError(e)) incomplete('unsupported-ownership'); else incomplete(root ? 'unsafe-entry' : 'unsafe-root'); }
    finally { root?.close(); }
    return result;
}

export const UNSUPPORTED_OWNERSHIP_REASON = 'provider file ownership unsupported; align worker and agent container UIDs; operator action required (docs/operations/managed-diagnostics.md)';
export function nativeAdmissionReason(inventories: NativeLogInventory[], limits: NativeLogLimits = NATIVE_LOG_LIMITS): string | null {
    if (inventories.some(i => i.reason === 'unsupported-ownership')) return containerUidConfigurationError() ?? UNSUPPORTED_OWNERSHIP_REASON;
    if (inventories.some(i => i.reason === 'unsafe-root' || i.reason === 'unsafe-entry' || i.availableBytes === null)) return 'native log inventory incomplete; operator action required';
    if (inventories.some(i => i.availableBytes! < limits.minimumFreeBytes)) return 'native log filesystem reserve exhausted; operator action required';
    // Legacy high-water marks counted every class; only classified diagnostic
    // evidence may contribute to this gate. Disk reserves cover session growth.
    const bytes = inventories.map(i => i.capacityBasis === 'diagnostic'
        ? i.capacityBytesLowerBound ?? i.bytes.diagnostic : i.bytes.diagnostic);
    if (bytes.some(value => value >= limits.rootBytes)
        || bytes.reduce((sum, value) => sum + value, 0) >= limits.totalBytes) return 'protected native state capacity; operator action required; after storage remediation use private CLI reset-native-capacity (docs/operations/managed-diagnostics.md)';
    return null;
}

export function inspectNativeLogRoots(roots: NativeLogRoot[]): NativeLogInventory[] {
    const deadline = performance.now() + NATIVE_LOG_LIMITS.passMs;
    return roots.map(root => inspectNativeLogRoot(root, { ...NATIVE_LOG_LIMITS,
        scanMs: Math.max(0, Math.min(NATIVE_LOG_LIMITS.scanMs, deadline - performance.now())) }));
}
