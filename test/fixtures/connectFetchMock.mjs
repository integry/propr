const realSetTimeout = globalThis.setTimeout;
if (process.env.PROPR_TEST_PLATFORM === 'win32') {
  Object.defineProperty(process, 'platform', { value: 'win32' });
}
globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(
  callback,
  delay === 5000 ? 20 : delay,
  ...args,
);

const endpoint = 'https://t-abc123.propr.dev';
const identity = process.env.PROPR_TEST_PUBLIC_IDENTITY;
const discovery = {
  schemaVersion: 1,
  product: 'ProPR',
  canonicalEndpoint: endpoint,
  publicInstanceIdentity: identity,
  version: '0.8.15',
  apiCompatibility: '2026-06-27',
  uiCompatibility: '2026-06-27',
  desktopAuthentication: {
    protocolVersion: 1,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
};

const endless = (status, contentType = 'application/json') => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('{'));
  },
}), { status, headers: { 'content-type': contentType } });

globalThis.fetch = async () => {
  switch (process.env.PROPR_TEST_DISCOVERY_MODE) {
    case 'ready':
      return new Response(JSON.stringify(discovery), { headers: { 'content-type': 'application/json' } });
    case 'restart-required':
      return new Response(JSON.stringify({ ...discovery, canonicalEndpoint: null }), {
        headers: { 'content-type': 'application/json' },
      });
    case 'identity-mismatch':
      return new Response(JSON.stringify({
        ...discovery,
        publicInstanceIdentity: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }), { headers: { 'content-type': 'application/json' } });
    case 'oversized':
      return new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '9000' },
      });
    case 'invalid':
      return new Response(JSON.stringify({ ...discovery, desktopAuthentication: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    case 'invalid-utf8':
      return new Response(Uint8Array.from([0xc3, 0x28]), {
        headers: { 'content-type': 'application/json' },
      });
    case 'unsupported':
      return endless(404);
    case 'unreachable':
      throw new Error('transport-SENTINEL must remain private');
    case 'secret-sentinel':
      throw new Error('connector-token-SENTINEL relay-token-SENTINEL private-path-SENTINEL');
    case 'timeout':
      return endless(200);
    default:
      throw new Error('unexpected discovery fixture mode');
  }
};
