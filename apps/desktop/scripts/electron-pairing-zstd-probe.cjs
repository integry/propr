const { app, session } = require('electron');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let endpoint;
  try {
    endpoint = new URL(process.argv.at(-1));
  } catch {
    throw new Error('Native zstd pairing endpoint is missing');
  }
  if (endpoint.protocol !== 'http:'
    || endpoint.hostname !== '127.0.0.1'
    || !endpoint.port
    || endpoint.username
    || endpoint.password
    || endpoint.pathname !== '/valid'
    || endpoint.search
    || endpoint.hash) throw new Error('Native zstd pairing endpoint is invalid');

  const clientModuleUrl = pathToFileURL(resolve(
    __dirname,
    '../../../packages/client/dist/pairingProtocol.js',
  )).href;
  const { requestPairingProtocol } = await import(clientModuleUrl);
  const electronFetch = session.defaultSession.fetch.bind(session.defaultSession);
  const requestOnce = async path => {
    let responseEncoding;
    let responseLength;
    try {
      const value = await requestPairingProtocol(async (...args) => {
        const response = await electronFetch(...args);
        responseEncoding = response.headers.get('content-encoding');
        responseLength = response.headers.get('content-length');
        return response;
      }, new URL(path, endpoint), { method: 'POST' });
      return { kind: 'success', responseEncoding, responseLength, value };
    } catch (error) {
      return {
        kind: error && typeof error.kind === 'string' ? error.kind : 'unexpected',
        message: error instanceof Error ? error.message : '',
        responseEncoding,
        responseLength,
      };
    }
  };

  // A saturated CI worker can stall one loopback request past the client's
  // fixed header deadline. That is a worker hiccup rather than a compression
  // result, so a stalled path is retried once and every stall is reported so
  // the test can surface it. Retries stay bounded to keep the run inside the
  // fixture budget; beyond that the timeout is reported as the outcome.
  const maximumStallRetries = 2;
  const stalls = [];
  const request = async path => {
    const attempt = await requestOnce(path);
    if (attempt.kind !== 'timeout') return attempt;
    stalls.push(path);
    if (stalls.length > maximumStallRetries) return attempt;
    return requestOnce(path);
  };

  process.stdout.write(`${JSON.stringify({
    valid: await request('/valid'),
    decodedOverLimit: await request('/decoded-over-limit'),
    truncated: await request('/truncated'),
    stacked: await request('/stacked'),
    stalls,
  })}\n`);
  app.quit();
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
