import { isIP } from 'node:net';
import type { AgentType } from '../agents/types.js';

/**
 * Hostname allowlists for restricted agent networking. Entries are exact
 * hostnames (`registry.npmjs.org`), single-level-or-deeper wildcards
 * (`*.example.com`, which matches `a.example.com` and `a.b.example.com` but not
 * `example.com`), or IP literals. Any entry may end in `:port`; without one,
 * only ports 80 and 443 are allowed.
 */

export const DEFAULT_EGRESS_PORTS: readonly number[] = [80, 443];

const COMMON_HOSTS = [
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'uploads.github.com',
    'objects.githubusercontent.com',
    'raw.githubusercontent.com',
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    'pypi.org',
    'files.pythonhosted.org',
];

/** Provider API and sign-in hosts each agent needs for its own traffic. */
export const AGENT_EGRESS_BASE_HOSTS: Record<AgentType, readonly string[]> = {
    claude: ['api.anthropic.com', 'console.anthropic.com', 'platform.claude.com'],
    codex: ['api.openai.com', 'auth.openai.com', 'chatgpt.com'],
    antigravity: ['generativelanguage.googleapis.com', 'cloudcode-pa.googleapis.com', 'oauth2.googleapis.com'],
    opencode: ['opencode.ai', 'models.dev', 'api.anthropic.com', 'api.openai.com', 'openrouter.ai', 'generativelanguage.googleapis.com'],
    vibe: ['api.mistral.ai'],
};

/**
 * Whether each agent CLI is known to send its provider API traffic through
 * `HTTPS_PROXY`. An agent marked unsupported runs with open networking (and a
 * timeline warning) instead of failing every request, unless the instance
 * enforces restricted mode, in which case its run is refused.
 */
export const AGENT_EGRESS_PROXY_SUPPORT: Record<AgentType, { supported: boolean; note: string }> = {
    claude: { supported: true, note: 'Claude Code honours HTTPS_PROXY and HTTP_PROXY for API traffic.' },
    codex: { supported: true, note: 'Codex CLI honours HTTPS_PROXY and HTTP_PROXY for API traffic.' },
    opencode: { supported: true, note: 'OpenCode runs on Bun, whose HTTP client honours HTTPS_PROXY and HTTP_PROXY.' },
    vibe: { supported: true, note: 'Vibe uses httpx, which honours HTTPS_PROXY and HTTP_PROXY.' },
    antigravity: {
        supported: false,
        note: 'Antigravity CLI has not been verified to send its Google sign-in and API traffic through HTTPS_PROXY.',
    },
};

export function baseEgressAllowlist(agentType: AgentType): string[] {
    return [...new Set([...COMMON_HOSTS, ...AGENT_EGRESS_BASE_HOSTS[agentType]])];
}

interface ParsedEntry { host: string; wildcard: boolean; port?: number }

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Lowercases and strips one trailing dot and IPv6 brackets. */
export function normalizeEgressHost(host: string): string {
    let value = host.trim().toLowerCase();
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
    if (value.endsWith('.')) value = value.slice(0, -1);
    return value;
}

function isHostname(host: string): boolean {
    const labels = host.split('.');
    return host.length <= 253 && labels.length >= 2 && labels.every(label => LABEL.test(label));
}

/** Parses one allowlist entry, or returns an error message. */
export function parseEgressAllowEntry(entry: string): ParsedEntry | string {
    if (typeof entry !== 'string' || !entry.trim()) return 'must be a nonempty hostname';
    let value = entry.trim().toLowerCase();
    let port: number | undefined;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (bracketed) {
        value = bracketed[1];
        if (bracketed[2] !== undefined) port = Number(bracketed[2]);
    } else if (isIP(value) !== 6) {
        const portMatch = /^(.*):(\d+)$/.exec(value);
        if (portMatch) { value = portMatch[1]; port = Number(portMatch[2]); }
    }
    if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) return 'has an invalid port';
    value = normalizeEgressHost(value);
    if (isIP(value)) return { host: value, wildcard: false, port };
    const wildcard = value.startsWith('*.');
    const host = wildcard ? value.slice(2) : value;
    if (host.includes('*')) return 'may only use a leading "*." wildcard';
    // At least two labels, so `*.com` cannot open a whole top-level domain.
    if (!isHostname(host)) return 'must be a hostname with at least two labels, such as "registry.npmjs.org" or "*.example.com"';
    return { host, wildcard, port };
}

export function validateEgressAllowlist(entries: unknown, field: string): string | undefined {
    if (!Array.isArray(entries) || entries.length > 500) return `${field} must be an array of at most 500 hostnames`;
    for (const [index, entry] of entries.entries()) {
        const parsed = parseEgressAllowEntry(entry as string);
        if (typeof parsed === 'string') return `${field}[${index}] ${parsed}`;
    }
    return undefined;
}

export interface EgressAllowlist {
    readonly entries: readonly string[];
    allows(host: string, port: number): boolean;
}

/** Invalid entries are ignored here; callers validate configuration before it reaches a run. */
export function compileEgressAllowlist(entries: readonly string[]): EgressAllowlist {
    const parsed = entries.map(parseEgressAllowEntry).filter((entry): entry is ParsedEntry => typeof entry !== 'string');
    return {
        entries: [...new Set(entries.map(entry => entry.trim().toLowerCase()))],
        allows(rawHost, port) {
            const host = normalizeEgressHost(rawHost);
            if (!host) return false;
            const ipLiteral = isIP(host) !== 0;
            return parsed.some(entry => {
                if (entry.port !== undefined ? entry.port !== port : !DEFAULT_EGRESS_PORTS.includes(port)) return false;
                // Wildcards name DNS zones; they never match an IP literal.
                if (entry.wildcard) return !ipLiteral && host.endsWith(`.${entry.host}`);
                return host === entry.host;
            });
        },
    };
}
