import path from 'node:path';
import { PinnedDirectory } from './privateDirectory.js';
import { collectProvider, type DiagnosticProvider } from './providerCollector.js';
import { managedDiagnostics } from './managedLogRuntime.js';
import { digest } from './managedLogSpool.js';
import { UNSUPPORTED_OWNERSHIP_REASON } from './nativeLogPolicy.js';
import { containerUidConfigurationError, isProviderOwnershipError } from './providerOwnership.js';

const targets: Record<string, DiagnosticProvider> = {
    '/home/node/.codex': 'codex', '/home/node/.claude': 'claude',
    '/home/node/.gemini': 'antigravity', '/home/node/.gemini-source': 'antigravity',
    '/home/node/.local/share/opencode-source': 'opencode',
    '/home/node/.local/share/opencode': 'opencode', '/home/node/.vibe': 'vibe',
};
const suffixes: Record<DiagnosticProvider, string> = {
    codex: '.codex', claude: '.claude', antigravity: '.gemini',
    opencode: '.local/share/opencode', vibe: '.vibe',
};

/** Docker arguments alone do not prove ownership. No inferred personal HOME. */
function rootAgent(root: string, provider: DiagnosticProvider): string | undefined {
    if (!path.isAbsolute(root) || root.includes('\0') || root.split('/').includes('..')) return undefined;
    const managed = process.env.PROPR_MANAGED_CREDENTIALS_DIR;
    if (managed && path.isAbsolute(managed)) {
        const relative = path.relative(managed, root);
        const match = relative.match(/^([a-zA-Z0-9._:-]{1,128})\/(.*)$/);
        if (match && match[1] !== '.' && match[1] !== '..' && match[2] === suffixes[provider]) return match[1];
    }
    const configured: Record<DiagnosticProvider, (string | undefined)[]> = {
        codex: [process.env.CODEX_CONFIG_PATH, process.env.HOST_CODEX_DIR],
        claude: [process.env.CLAUDE_CONFIG_PATH, process.env.HOST_CLAUDE_DIR],
        antigravity: [process.env.ANTIGRAVITY_CONFIG_PATH, process.env.HOST_ANTIGRAVITY_DIR],
        opencode: [process.env.HOST_OPENCODE_DATA_DIR],
        vibe: [process.env.VIBE_CONFIG_PATH, process.env.HOST_VIBE_DIR],
    };
    return configured[provider].includes(root) ? `mount:${digest(root)}` : undefined;
}

/** Shared physical launch gate, also used without Hosted/Redis admission.
 * Refusal never signals or removes an already-running container. */
export function assertNativeLogAdmission(args: readonly string[]): void {
    if (process.env.PROPR_MANAGED_LOGS !== '1' || args[0] !== 'run') return;
    const spool = managedDiagnostics()!;
    spool.assertFilesystemCapacity();
    let mounts = 0;
    const seen = new Set<string>();
    for (let i = 1; i < args.length; i++) {
        if (args[i] !== '-v' && args[i] !== '--volume') continue;
        const [root, target] = (args[++i] ?? '').split(':');
        const provider = targets[target];
        if (!provider || seen.has(root)) continue;
        seen.add(root);
        if (++mounts > 16) throw new Error('managed diagnostics: native mount inventory capacity');
        const agent = rootAgent(root, provider);
        if (!agent) {
            spool.report({ provider, agent: 'unknown', source: 'unmapped-native-state' }, 'ownership-unverified');
            continue;
        }
        let pinned: PinnedDirectory | undefined;
        try {
            pinned = PinnedDirectory.open(root);
            spool.assertFilesystemCapacity(pinned);
            collectProvider(spool, { provider, agent, root, credentials: [], measureOnly: true, pinnedRoot: pinned, rejectUnsafe: true });
        } catch (error) {
            if (isProviderOwnershipError(error)) throw new Error(`managed diagnostics: ${containerUidConfigurationError() ?? UNSUPPORTED_OWNERSHIP_REASON}`);
            throw new Error('managed diagnostics: native capacity unavailable; operator action required');
        } finally { pinned?.close(); }
    }
    // Incomplete measurements are lower bounds, never proof of a writer cap.
    spool.assertCapacity();
}
