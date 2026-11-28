import net from 'node:net';
import type { TestContext } from 'node:test';

/**
 * Route the extension transport's TCP dials to a local fixture. Production dials only the vetted addresses (Happy
 * Eyeballs over `net.connect`); tests that answer a vetted public address from a local TLS server map every dial to
 * `host`, keeping the port the request chose. Restored with the test's mocks.
 */
export function redirectDials(t: TestContext, host: string): string[] {
  const dialed: string[] = [];
  const connect = net.connect;
  t.mock.method(net, 'connect', (options: net.NetConnectOpts) => {
    dialed.push(String((options as net.TcpNetConnectOpts).host));
    return connect({ ...options, host } as net.NetConnectOpts);
  });
  return dialed;
}
