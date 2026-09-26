const { app, session } = require('electron');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

app.disableHardwareAcceleration();

// How long a loopback request may take to produce response headers before this
// probe calls it a stalled worker rather than a compression result. It only
// shortens the client's production deadline, which the protocol permits, and it
// keeps each stalled attempt cheap so the wall-clock budget below buys many
// retries instead of a handful.
const STALL_HEADER_DEADLINE_MS = 2_000;

// The test owns the wall-clock budget, because the same number also sizes the
// launch timeout that would otherwise kill this process mid-report.
const STALL_BUDGET_FLAG = '--pairing-stall-budget-ms=';

app.whenReady().then(async () => {
  const budgetArgument = process.argv.find(argument => argument.startsWith(STALL_BUDGET_FLAG));
  const stallBudgetMs = Number(budgetArgument?.slice(STALL_BUDGET_FLAG.length));
  if (!Number.isSafeInteger(stallBudgetMs) || stallBudgetMs < 1) {
    throw new Error('Native zstd pairing stall budget is missing or invalid');
  }

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
      }, new URL(path, endpoint), { method: 'POST' }, {
        deadlines: { headerMs: STALL_HEADER_DEADLINE_MS },
      });
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

  // A saturated CI worker does not stall one loopback request — it stalls the
  // loopback path outright and then recovers: a shared worker ran five straight
  // requests into the deadline over ~40s and served the sixth immediately. A
  // freshly launched Electron can also wait more than 40s for the default
  // session's network stack to start before its first request lands. Neither
  // is a compression result, so both draw on one shared wall-clock budget: the
  // default session must first reach the loopback server with a plain request,
  // and only then are the pairing requests measured, a stalled path being
  // retried until the same budget is spent. Every stall is reported so the
  // test can surface it. A counted retry budget cannot express that: the first
  // path to stall spends it, and the endpoints after it are then reported as
  // failures of an outage they never got to outlive.
  //
  // Only a stall is retried. Every other outcome, decode failures included, is
  // the result this probe exists to report. Each stalled attempt costs at least
  // the header deadline above, so the budget also bounds the attempt count.
  const stallDeadline = Date.now() + stallBudgetMs;
  const readinessAttemptMs = 15_000;
  const awaitReadiness = async () => {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    let attempts = 0;
    let lastFailure = '';
    while (Date.now() < stallDeadline) {
      attempts += 1;
      try {
        const response = await electronFetch(new URL('/ready', endpoint).href, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(readinessAttemptMs, stallDeadline - Date.now()))),
        });
        await response.arrayBuffer();
        if (response.ok) return { attempts, elapsedMs: elapsed(), ready: true };
        lastFailure = `status ${response.status}`;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      // A refused connection fails at once; do not spin on it.
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
    return { attempts, elapsedMs: elapsed(), lastFailure, ready: false };
  };

  const stalls = [];
  const request = async path => {
    for (;;) {
      const attempt = await requestOnce(path);
      if (attempt.kind !== 'timeout') return attempt;
      stalls.push(path);
      if (Date.now() >= stallDeadline) return attempt;
    }
  };

  const readiness = await awaitReadiness();
  process.stdout.write(`${JSON.stringify(readiness.ready ? {
    readiness,
    valid: await request('/valid'),
    decodedOverLimit: await request('/decoded-over-limit'),
    truncated: await request('/truncated'),
    stacked: await request('/stacked'),
    stalls,
  } : { readiness })}\n`);
  app.quit();
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
