import assert from 'node:assert/strict';
import { createServer } from 'node:net';

/**
 * A Redis that answers every command with `:1`.
 *
 * The counterpart to `SilentRedis`: that one is the outage, this one is the
 * healthy connection. A publisher talking to it connects, succeeds and then
 * keeps the socket for reuse - which is the state in which an idle publisher
 * must not be the thing holding a process open.
 *
 * Both the listener and each accepted socket are unref'd, so in a process that
 * uses this stub the only handle that can keep the event loop alive is the
 * publisher's own client socket. There is deliberately no teardown: this is
 * only used from a fixture whose exit is the assertion, and exiting closes
 * everything here with it.
 */
export class AnsweringRedis {
    private constructor(readonly port: number) {}

    static async listen(): Promise<AnsweringRedis> {
        const server = createServer();
        server.unref();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address === 'object', 'the stub must report a port');
        server.on('connection', socket => {
            socket.unref();
            // `:1` is a valid reply to PUBLISH (one subscriber received it) and
            // is accepted for the handshake commands ioredis may send first.
            socket.on('data', () => socket.write(':1\r\n'));
            socket.on('error', () => {});
        });
        return new AnsweringRedis(address.port);
    }
}
