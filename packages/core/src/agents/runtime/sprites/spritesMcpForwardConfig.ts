/**
 * Static shape of the per-run SSH reverse forward that carries ProPR MCP into a
 * Sprite when no public MCP URL is available (`ssh-reverse-forward`). Kept free
 * of the SSH client so transport planning can import it without loading ssh2.
 *
 * Inside the Sprite, sshd listens on {@link SPRITES_MCP_SSHD_PORT} on loopback
 * only and authorizes one ephemeral key for {@link SPRITES_MCP_FORWARD_USER};
 * the worker reaches it through the Sprites API proxy and asks for a remote
 * listener on `127.0.0.1:`{@link SPRITES_MCP_FORWARD_PORT}, whose connections it
 * relays to the internal ProPR API.
 */

import { isIP } from 'node:net';

export const SPRITES_MCP_SSHD_PORT = 39022;
export const SPRITES_MCP_FORWARD_PORT = 39080;
export const SPRITES_MCP_FORWARD_HOST = '127.0.0.1';
export const SPRITES_MCP_FORWARD_USER = 'propr-mcp';
/** Root-owned helper installed at provisioning (scripts/sprites-mcp-forward.sh). */
export const SPRITES_MCP_FORWARD_SCRIPT = '/opt/propr/mcp-forward.sh';
/** sshd probes a silent client every interval and drops it after this many unanswered probes. */
export const SPRITES_MCP_SSHD_CLIENT_ALIVE_INTERVAL_S = 5;
export const SPRITES_MCP_SSHD_CLIENT_ALIVE_COUNT_MAX = 2;
/** How long sshd keeps a dead client's session (and its 127.0.0.1:39080 listener) at most. */
export const SPRITES_MCP_SSHD_DEAD_PEER_MS = SPRITES_MCP_SSHD_CLIENT_ALIVE_INTERVAL_S * SPRITES_MCP_SSHD_CLIENT_ALIVE_COUNT_MAX * 1000;
/** Set to 0/false/off/no to never use the forward (runs then need a public MCP URL); any value but true/false is refused. */
export const SPRITES_MCP_FORWARD_ENV = 'PROPR_SPRITES_MCP_FORWARD';

/**
 * Which transport Sprites runs prefer: `auto` (default) uses an explicit or
 * public HTTPS MCP URL when one exists and the forward otherwise; `forward`
 * always uses the forward, keeping ProPR MCP off the public internet.
 */
export const SPRITES_MCP_TRANSPORT_ENV = 'PROPR_SPRITES_MCP_TRANSPORT';
export type SpritesMcpTransportPreference = 'auto' | 'forward';

/** The operator's transport preference; an unrecognised value is reported, never guessed. */
export function spritesMcpTransportPreference(environment: NodeJS.ProcessEnv = process.env): SpritesMcpTransportPreference | { reason: string } {
    const value = environment[SPRITES_MCP_TRANSPORT_ENV]?.trim().toLowerCase();
    if (!value || value === 'auto') return 'auto';
    if (value === 'forward') return 'forward';
    return { reason: `${SPRITES_MCP_TRANSPORT_ENV} must be "auto" or "forward"` };
}

/** Where the worker relays forwarded connections, and the URL the agent uses inside the Sprite. */
export interface SpritesMcpForwardTarget {
    protocol: 'http:';
    host: string;
    port: number;
    /** `http://127.0.0.1:<forward port><base path>/api/mcp`, the URL the agent's MCP config names. */
    url: string;
}

/**
 * Whether the forward may be used. Parsed strictly: unset, `1/true/on/yes`
 * enables it, `0/false/off/no` disables it, and anything else (`disabled`,
 * `none`, a typo) is reported so Sprites MCP runs are refused rather than
 * guessing which way the operator meant.
 */
export function spritesMcpForwardEnabled(environment: NodeJS.ProcessEnv = process.env): boolean | { reason: string } {
    const value = environment[SPRITES_MCP_FORWARD_ENV]?.trim().toLowerCase();
    if (!value || ['1', 'true', 'on', 'yes'].includes(value)) return true;
    if (['0', 'false', 'off', 'no'].includes(value)) return false;
    return { reason: `Invalid ${SPRITES_MCP_FORWARD_ENV}: must be true/false (1/0, on/off, yes/no)` };
}

/**
 * Whether `host` is an internal address where the HTTP `Host` header does not
 * route: an IP literal in a loopback, private (RFC 1918 / CGNAT), link-local
 * or IPv6 unique-local range, `localhost`, a single-label name (a Compose
 * service such as `api`), or a `.internal` / `.local` / `.localhost` name.
 */
function isInternalForwardHost(host: string): boolean {
    const version = isIP(host);
    if (version === 4) {
        const [a, b] = host.split('.').map(Number);
        return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
            || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    }
    if (version === 6) {
        const value = host.toLowerCase();
        return value === '::1' || /^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value)
            || /^::ffff:(127|10|192\.168)\./.test(value);
    }
    const name = host.toLowerCase().replace(/\.$/, '');
    return !name.includes('.') || ['localhost', 'internal', 'local'].some(zone => name === zone || name.endsWith(`.${zone}`));
}

/**
 * The internal API the worker reaches (`PROPR_INTERNAL_API_URL`, default
 * `http://api:4000`) as a forward target: one host and port, nothing else.
 *
 * The relay passes raw bytes, so requests arrive with the agent's
 * `Host: 127.0.0.1:39080`. That is harmless for a plain-HTTP API on an
 * internal address, but a vhost- or SNI-routed HTTPS target would answer
 * 404/421, so only `http://` on a loopback, private or internal name is
 * accepted and anything else is refused with what to set.
 */
export function spritesMcpForwardTarget(environment: NodeJS.ProcessEnv = process.env): SpritesMcpForwardTarget | { reason: string } {
    const raw = environment.PROPR_INTERNAL_API_URL?.trim() || 'http://api:4000';
    let url: URL;
    try { url = new URL(raw); } catch { return { reason: 'PROPR_INTERNAL_API_URL is not a valid URL' }; }
    if (url.protocol !== 'http:') {
        return { reason: 'PROPR_INTERNAL_API_URL must be a plain http:// URL on a loopback, private or internal address for the SSH reverse forward (the relay keeps the agent\'s Host header, which an https or vhost-routed target would reject)' };
    }
    if (url.username || url.password || url.search || url.hash) return { reason: 'PROPR_INTERNAL_API_URL must not carry credentials, a query or a fragment' };
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (!host) return { reason: 'PROPR_INTERNAL_API_URL has no host' };
    if (!isInternalForwardHost(host)) {
        return { reason: `PROPR_INTERNAL_API_URL host ${host} is not a loopback, private or internal address; the SSH reverse forward relays only to an internal plain-HTTP API, where the Host header does not route` };
    }
    const port = url.port ? Number(url.port) : 80;
    let end = url.pathname.length;
    while (end > 0 && url.pathname[end - 1] === '/') end--;
    const path = url.pathname.slice(0, end);
    return { protocol: 'http:', host, port, url: `http://${SPRITES_MCP_FORWARD_HOST}:${SPRITES_MCP_FORWARD_PORT}${path}/api/mcp` };
}

/** Whether `url` is the loopback forward listener (any base path). */
export function isSpritesMcpForwardUrl(url: string | undefined): boolean {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' && parsed.hostname === SPRITES_MCP_FORWARD_HOST
            && parsed.port === String(SPRITES_MCP_FORWARD_PORT) && !parsed.username && !parsed.password;
    } catch { return false; }
}

/**
 * The sshd configuration for one run. sshd binds loopback only (the Sprites
 * proxy is its only way in), accepts exactly one public key for one user, and
 * permits nothing but a remote listener on the forward port: no password,
 * keyboard-interactive or host-based auth, no sessions, shells, TTYs, agent,
 * X11, tunnel or stream-local forwarding, and no local (`-L`) forwarding.
 */
export function spritesMcpSshdConfig(dir: string): string {
    return [
        `ListenAddress ${SPRITES_MCP_FORWARD_HOST}:${SPRITES_MCP_SSHD_PORT}`,
        'AddressFamily inet',
        `HostKey ${dir}/host_key`,
        `PidFile ${dir}/sshd.pid`,
        `AuthorizedKeysFile ${dir}/authorized_keys`,
        'AuthorizedKeysCommand none',
        'AuthorizedPrincipalsFile none',
        `AllowUsers ${SPRITES_MCP_FORWARD_USER}`,
        'AuthenticationMethods publickey',
        'PubkeyAuthentication yes',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'HostbasedAuthentication no',
        'PermitEmptyPasswords no',
        'PermitRootLogin no',
        'UsePAM no',
        'StrictModes yes',
        'MaxAuthTries 2',
        'MaxSessions 0',
        'MaxStartups 4:50:8',
        'LoginGraceTime 30',
        `ClientAliveInterval ${SPRITES_MCP_SSHD_CLIENT_ALIVE_INTERVAL_S}`,
        `ClientAliveCountMax ${SPRITES_MCP_SSHD_CLIENT_ALIVE_COUNT_MAX}`,
        'AllowTcpForwarding remote',
        `PermitListen ${SPRITES_MCP_FORWARD_HOST}:${SPRITES_MCP_FORWARD_PORT}`,
        'PermitOpen none',
        'GatewayPorts no',
        'AllowAgentForwarding no',
        'AllowStreamLocalForwarding no',
        'X11Forwarding no',
        'PermitTunnel no',
        'PermitTTY no',
        'PermitUserEnvironment no',
        'PermitUserRC no',
        'PrintMotd no',
        'Banner none',
        'LogLevel INFO',
        '',
    ].join('\n');
}

/** The single authorized key, restricted to the one remote listener. */
export function spritesMcpAuthorizedKey(publicKey: string): string {
    const key = publicKey.trim().split(/\s+/).slice(0, 2).join(' ');
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+=*$/.test(key)) throw new Error('Invalid ProPR MCP forward key');
    return `restrict,port-forwarding,permitlisten="${SPRITES_MCP_FORWARD_HOST}:${SPRITES_MCP_FORWARD_PORT}" ${key} propr-mcp-forward\n`;
}
