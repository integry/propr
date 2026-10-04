import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';

/**
 * A Redis that accepts connections and then says nothing.
 *
 * This is the outage the publisher has to survive: not a refused connection,
 * which fails fast on its own, but a server that takes the command and never
 * answers. Its callers have already committed their database write by the time
 * they publish, so the wait has to end whether Redis comes back or not.
 *
 * Shared by the publisher's own bounds tests and by the notification flush
 * tests, which need the same already-connected-then-silent server.
 */
export class SilentRedis {
    private readonly sockets = new Set<Socket>();
    private constructor(private readonly server: Server, readonly port: number) {}

    static async listen(): Promise<SilentRedis> {
        const server = createServer();
        server.unref();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address === 'object', 'the stub must report a port');
        const stub = new SilentRedis(server, address.port);
        server.on('connection', socket => {
            socket.unref();
            stub.sockets.add(socket);
            socket.on('close', () => stub.sockets.delete(socket));
        });
        return stub;
    }

    /** Take the server away, the way a Redis restart or a network cut does. */
    async goAway(): Promise<void> {
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
}
