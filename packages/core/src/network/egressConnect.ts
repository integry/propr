import net from 'node:net';

/**
 * How long a direct connection waits on one vetted address before also trying
 * the next (RFC 8305's "connection attempt delay"). An earlier attempt keeps
 * running; the first to connect wins.
 */
export const EGRESS_CONNECT_ATTEMPT_DELAY_MS = 250;

export interface EgressConnectAttempt {
    /** The first socket that connected; rejects once every address has failed or the attempt was aborted. */
    readonly connected: Promise<net.Socket>;
    /** Stops trying: destroys every pending socket. A no-op once settled. */
    abort(error?: Error): void;
}

/**
 * Orders vetted addresses the way RFC 8305 does: the resolver's first family
 * leads, then the families alternate, so a worker without (say) an IPv6 route
 * reaches the IPv4 records after one attempt delay instead of none at all.
 */
export function interleaveAddressFamilies(addresses: readonly string[]): string[] {
    const unique = [...new Set(addresses)];
    const leading = net.isIP(unique[0] ?? '');
    const first = unique.filter(address => net.isIP(address) === leading);
    const second = unique.filter(address => net.isIP(address) !== leading);
    const ordered: string[] = [];
    for (let index = 0; index < Math.max(first.length, second.length); index++) {
        if (index < first.length) ordered.push(first[index]);
        if (index < second.length) ordered.push(second[index]);
    }
    return ordered;
}

/**
 * Connects to the first of the already-vetted addresses that answers. Only
 * these addresses are ever dialled: there is no second lookup. An attempt
 * that fails starts the next at once; one that hangs is joined by the next
 * after `attemptDelayMs`. The caller bounds the whole attempt (its handshake
 * deadline) by calling `abort`.
 */
export function connectToFirstAddress(
    port: number,
    addresses: readonly string[],
    { connect, attemptDelayMs = EGRESS_CONNECT_ATTEMPT_DELAY_MS, track }: {
        connect: (port: number, host: string) => net.Socket;
        attemptDelayMs?: number;
        track?: (socket: net.Socket) => void;
    },
): EgressConnectAttempt {
    const queue = interleaveAddressFamilies(addresses);
    const pending = new Set<net.Socket>();
    let settled = false;
    let lastError: Error = new Error('no address to connect to');
    let timer: NodeJS.Timeout | undefined;
    let resolve!: (socket: net.Socket) => void, reject!: (error: Error) => void;
    const connected = new Promise<net.Socket>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });

    const finish = (winner?: net.Socket, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const socket of pending) if (socket !== winner) socket.destroy();
        pending.clear();
        if (winner) resolve(winner);
        else reject(error ?? lastError);
    };
    const failed = (socket: net.Socket, error?: Error): void => {
        if (settled || !pending.delete(socket)) return;
        if (error) lastError = error;
        socket.destroy();
        if (queue.length) attemptNext();
        else if (!pending.size) finish();
    };
    const attemptNext = (): void => {
        clearTimeout(timer);
        const address = queue.shift();
        if (address === undefined || settled) return;
        let socket: net.Socket;
        try { socket = connect(port, address); } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (queue.length) attemptNext(); else if (!pending.size) finish();
            return;
        }
        pending.add(socket);
        track?.(socket);
        // Kept after settling: a losing socket's late error must not go unhandled.
        socket.on('error', error => failed(socket, error));
        socket.once('close', () => failed(socket));
        socket.once('connect', () => { if (!settled) { pending.delete(socket); finish(socket); } });
        if (queue.length) {
            timer = setTimeout(attemptNext, attemptDelayMs);
            timer.unref?.();
        }
    };

    attemptNext();
    return { connected, abort: error => finish(undefined, error ?? new Error('connection attempt aborted')) };
}
