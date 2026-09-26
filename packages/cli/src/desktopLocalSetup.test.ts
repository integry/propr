import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY } from '@propr/shared';
import { checkDesktopRuntimeCompatibility, createDesktopSetupHost } from './desktopLocalSetup.js';
import type { CapturedCommandRunner } from './auth/githubLogin.js';

const fixtureDirectory = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-desktop-host-')));

const image = `propr/app:${'a'.repeat(40)}@sha256:${'b'.repeat(64)}`;
const discovery = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  product: 'ProPR',
  version: '0.8.16',
  apiCompatibility: PROPR_API_COMPATIBILITY,
  uiCompatibility: PROPR_UI_COMPATIBILITY,
  desktopAuthentication: {
    protocolVersion: 2,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
  canonicalEndpoint: null,
  publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
  ...overrides,
});
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('desktop local runtime compatibility gate', () => {
  test('accepts only complete compatible desktop discovery', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => response(discovery()),
    });
    assert.equal(result.compatible, true);
    assert.match(result.detail, new RegExp(PROPR_API_COMPATIBILITY));
  });

  test('rejects the legacy compatibility-only runtime before setup completion', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => response({
        version: '0.8.15',
        apiCompatibility: '2026-06-27',
        uiCompatibility: '2026-06-27',
      }),
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, /discovery, identity, and desktop authentication contract/);
    assert.match(result.nextAction ?? '', /desktop:runtime:build/);
  });

  test('rejects a valid document when any secure transport capability is disabled', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => response(discovery({ desktopAuthentication: {
        protocolVersion: 2,
        browserPairing: true,
        instanceBearerTokens: true,
        socketIoBearerAuthentication: false,
      } })),
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, /Socket.IO bearer authentication/);
  });

  test('rejects a truncated discovery response with a mismatched declared length', async () => {
    const body = JSON.stringify(discovery());
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body) + 1),
        },
      }),
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, /response length is invalid/);
  });

  test('reports the selected app image and exact recovery contract for an old API', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => response(discovery({
        apiCompatibility: '2025-01-01',
        uiCompatibility: '2025-01-01',
      })),
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, new RegExp(image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.nextAction ?? '', new RegExp(PROPR_API_COMPATIBILITY));
    assert.equal(result.recoveryAction, 'replace-running-stack');
  });

  test('keeps throttling and identity persistence failures resumable without diagnosing an incompatible image', async () => {
    for (const [status, body] of [
      [429, { code: 'RATE_LIMITED' }],
      [503, { schemaVersion: 1, code: 'IDENTITY_UNAVAILABLE' }],
    ] as const) {
      const result = await checkDesktopRuntimeCompatibility({
        baseUrl: 'http://127.0.0.1:14000', image,
        fetch: async () => response(body, status),
      });
      assert.equal(result.compatible, false);
      assert.match(result.detail, new RegExp(`could not be verified.*HTTP ${status}`));
      assert.match(result.nextAction ?? '', /Retry local setup/);
      assert.match(result.nextAction ?? '', /identity persistence health/);
      assert.doesNotMatch(result.nextAction ?? '', /Install the app image|desktop:runtime:build/);
      assert.equal(result.recoveryAction, undefined);
    }
  });

  test('keeps connection failures resumable without prescribing another image', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => { throw new TypeError('connection refused'); },
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, /could not be verified.*could not be reached/);
    assert.match(result.nextAction ?? '', /Retry local setup/);
    assert.doesNotMatch(result.nextAction ?? '', /Install the app image|desktop:runtime:build/);
    assert.equal(result.recoveryAction, undefined);
  });

  test('keeps discovery timeouts resumable without prescribing another image', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image, timeoutMs: 1,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, /could not be verified.*timed out/);
    assert.match(result.nextAction ?? '', /Retry local setup/);
    assert.doesNotMatch(result.nextAction ?? '', /Install the app image|desktop:runtime:build/);
    assert.equal(result.recoveryAction, undefined);
  });

  test('treats a missing public discovery endpoint as a definitive contract failure', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => response({ code: 'NOT_FOUND' }, 404),
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, /incompatible.*HTTP 404/);
    assert.match(result.nextAction ?? '', new RegExp(PROPR_API_COMPATIBILITY));
    assert.equal(result.recoveryAction, 'replace-running-stack');
  });

  test('offers owned-stack replacement for the exact discovery-401 legacy compatibility runtime', async () => {
    const requests: Array<{ url: string; authorization: string | null; credentials?: RequestInit['credentials'] }> = [];
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image: 'propr/app:0.8.15',
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          authorization: new Headers(init?.headers).get('authorization'),
          credentials: init?.credentials,
        });
        return input.toString().endsWith('/api/desktop/discovery')
          ? response({ error: 'Authentication required' }, 401)
          : response({
              version: '0.8.15',
              apiCompatibility: '2026-06-27',
              uiCompatibility: '2026-06-27',
            });
      },
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, /legacy ProPR 0\.8\.15/);
    assert.equal(result.recoveryAction, 'replace-running-stack');
    assert.deepEqual(requests, [
      { url: 'http://127.0.0.1:14000/api/desktop/discovery', authorization: null, credentials: 'omit' },
      { url: 'http://127.0.0.1:14000/api/compatibility', authorization: null, credentials: 'omit' },
    ]);
  });

  test('does not classify an arbitrary discovery 401 as an incompatible image', async () => {
    for (const compatibility of [
      { service: 'not-propr' },
      { ...discovery(), schemaVersion: undefined },
      { version: '0.8.15', apiCompatibility: '2026-06-27', uiCompatibility: '2026-06-27', unexpected: true },
      { version: '0.8.15', apiCompatibility: '2025-01-01', uiCompatibility: '2025-01-01' },
    ]) {
      const result = await checkDesktopRuntimeCompatibility({
        baseUrl: 'http://127.0.0.1:14000', image,
        fetch: async input => input.toString().endsWith('/api/desktop/discovery')
          ? response({ error: 'Authentication required' }, 401)
          : response(compatibility),
      });
      assert.equal(result.compatible, false);
      assert.match(result.detail, /could not be verified.*HTTP 401/);
      assert.equal(result.recoveryAction, undefined);
      assert.match(result.nextAction ?? '', /existing runtime and data have been retained/);
    }
  });
});

describe('desktop setup host authentication boundary', () => {
  test('hands unauthenticated GitHub startup to a visible asynchronous host action', async () => {
    const configDir = fixtureDirectory();
    const calls: string[] = [];
    let tokenChecks = 0;
    const capturedCommand: CapturedCommandRunner = async (command, args) => {
      calls.push([command, ...args].join(' '));
      if (args[0] === '--version') return { status: 0, stdout: 'gh version fixture' };
      tokenChecks += 1;
      return { status: tokenChecks === 1 ? 1 : 0, stdout: tokenChecks === 1 ? '' : 'fixture-token\n' };
    };
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const admitted = new Promise<void>(resolve => { release = resolve; });
    try {
      const host = await createDesktopSetupHost({
        configDir,
        capturedCommand,
        authenticationHandoff: async (command, args) => {
          calls.push(`visible:${[command, ...args].join(' ')}`);
          markStarted();
          await admitted;
          return { status: 0 };
        },
      });
      assert.equal(host.actions.hasGithubToken(), false);
      const login = host.actions.loginWithGithub();
      await started;
      assert.match(calls.at(-1) ?? '', /^visible:gh auth login/);
      assert.equal(host.actions.hasGithubToken(), false);
      release();
      assert.equal(await login, true);
      assert.equal(host.actions.hasGithubToken(), true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('aborts and reaps a production Docker operation without waiting for its natural exit', async () => {
    const directory = fixtureDirectory();
    const docker = join(directory, 'docker');
    const pidPath = join(directory, 'docker.pid');
    const originalPath = process.env.PATH;
    let pid: number | undefined;
    writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.PROPR_TEST_DOCKER_PID, String(process.pid));
process.on('SIGTERM', () => undefined);
setInterval(() => undefined, 1000);
`, { mode: 0o700 });
    chmodSync(docker, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.PROPR_TEST_DOCKER_PID = pidPath;
    const controller = new AbortController();
    let operation: Promise<unknown> | undefined;
    try {
      const rootDir = join(directory, 'root');
      mkdirSync(rootDir, { mode: 0o700 });
      const host = await createDesktopSetupHost({
        configDir: join(directory, 'config'),
        capturedCommand: async () => ({ status: 1, stdout: '' }),
        authenticationHandoff: async () => ({ status: 1 }),
      });
      operation = host.actions.pullImages({ rootDir, agentTypes: [], signal: controller.signal });
      const deadline = Date.now() + 2_000;
      while (!existsSync(pidPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(existsSync(pidPath), true, 'fixture Docker process did not start');
      pid = Number(readFileSync(pidPath, 'utf8'));

      controller.abort();
      await Promise.race([
        assert.rejects(operation, error => (error as Error).name === 'AbortError'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Docker cancellation did not settle')), 2_000)),
      ]);
      assert.throws(() => process.kill(pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
    } finally {
      process.env.PATH = originalPath;
      delete process.env.PROPR_TEST_DOCKER_PID;
      if (pid) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
      }
      await operation?.catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('cancels an admitted desktop authentication handoff without blocking the host', async () => {
    const configDir = fixtureDirectory();
    const controller = new AbortController();
    let admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    try {
      const host = await createDesktopSetupHost({
        configDir,
        capturedCommand: async (_command, args) => ({ status: args[0] === '--version' ? 0 : 1, stdout: '' }),
        authenticationHandoff: async (_command, _args, options) => new Promise((_resolve, reject) => {
          admitted();
          options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
        }),
      });
      const login = host.actions.loginWithGithub({ signal: controller.signal });
      await started;
      controller.abort();
      await assert.rejects(login, error => (error as Error).name === 'AbortError');
      assert.equal(host.actions.hasGithubToken(), false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
