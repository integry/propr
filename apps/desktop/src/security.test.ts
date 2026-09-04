import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROPR_API_ORIGIN_PARITY_CASES } from '@propr/shared';
import {
  createLatestRendererReloader,
  deepLinkFromArguments,
  applyDevelopmentRendererCsp,
  connectApiBaseUrlFromDeepLink,
  dashboardPathFromDeepLink,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  normalizeApiBaseUrl,
  normalizeDesktopDashboardPath,
  normalizeDeepLink,
  rendererContentSecurityPolicy,
  validatedDevServerUrl,
} from './security';

describe('desktop URL security', () => {
  it('matches the shared canonical origin parity table', () => {
    for (const [name, input, expected] of PROPR_API_ORIGIN_PARITY_CASES) {
      assert.equal(normalizeApiBaseUrl(input), expected, name);
    }
  });
  it('only accepts HTTPS and loopback HTTP API endpoints', () => {
    assert.equal(normalizeApiBaseUrl('https://propr.example.com/'), 'https://propr.example.com');
    assert.equal(normalizeApiBaseUrl('http://localhost:4000/'), 'http://localhost:4000');
    assert.equal(normalizeApiBaseUrl('http://team.localhost:4000'), 'http://team.localhost:4000');
    assert.equal(normalizeApiBaseUrl('http://127.99.2.3:4000'), 'http://127.99.2.3:4000');
    assert.equal(normalizeApiBaseUrl('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
    assert.equal(normalizeApiBaseUrl('http://[::1]:4000/'), 'http://[::1]:4000');
    assert.equal(normalizeApiBaseUrl('https://propr.example.com/base'), null);
    assert.equal(normalizeApiBaseUrl('http://[::1]:4000/api'), null);
    assert.equal(normalizeApiBaseUrl('http://propr.example.com'), null);
    assert.equal(normalizeApiBaseUrl('http://[2001:db8::1]:4000'), null);
    assert.equal(normalizeApiBaseUrl('https://user:secret@propr.example.com'), null);
    assert.equal(normalizeApiBaseUrl('https://t-instance123.propr.dev'), 'https://t-instance123.propr.dev');
    assert.equal(normalizeApiBaseUrl(' https://t-instance123.propr.dev'), null);
    assert.equal(normalizeApiBaseUrl('https://t-instance123.propr.dev '), null);
    assert.equal(normalizeApiBaseUrl('https://t-instance123.propr.dev/'), null);
    assert.equal(normalizeApiBaseUrl('HTTPS://t-instance123.propr.dev'), null);
    assert.equal(normalizeApiBaseUrl('https://T-instance123.propr.dev'), null);
    assert.equal(normalizeApiBaseUrl('https://t-instance123.propr.dev:443'), null);
    assert.equal(normalizeApiBaseUrl('https://t-instance123.propr.dev:8443'), null);
    assert.equal(normalizeApiBaseUrl('https://t-%69nstance123.propr.dev'), null);
    assert.equal(normalizeApiBaseUrl('https://t-instance123.propr%2edev'), null);
    assert.equal(normalizeApiBaseUrl('https://t-instance123.foo.propr.dev'), null);
    assert.equal(normalizeApiBaseUrl('https://x.t-instance123.propr.dev'), null);
    assert.equal(normalizeApiBaseUrl('https://t-instance123.propr.dev.'), null);
    assert.equal(normalizeApiBaseUrl(`https://example.com/${'private'.repeat(400)}`), null);
    assert.equal(normalizeApiBaseUrl('https://t-instance123.propr.dev.example.com'), 'https://t-instance123.propr.dev.example.com');
    assert.equal(normalizeApiBaseUrl('file:///tmp/propr'), null);
    assert.equal(normalizeApiBaseUrl('http://localhost.:4000'), null);
    assert.equal(normalizeApiBaseUrl('http://127.1:4000'), null);
    assert.equal(normalizeApiBaseUrl('http://0177.0.0.1:4000'), null);
    assert.equal(normalizeApiBaseUrl('http://0x7f000001:4000'), null);
    assert.equal(normalizeApiBaseUrl('http://[::ffff:127.0.0.1]:4000'), null);
    assert.equal(normalizeApiBaseUrl('https://propr.example.com///'), 'https://propr.example.com');
  });

  it('denies unsafe external browser schemes and credential-bearing URLs', () => {
    assert.equal(isSafeExternalUrl('https://github.com/integry/propr'), true);
    assert.equal(isSafeExternalUrl('http://localhost:4000/docs'), true);
    assert.equal(isSafeExternalUrl('http://[::1]:4000/docs'), true);
    assert.equal(isSafeExternalUrl('http://example.com'), false);
    assert.equal(isSafeExternalUrl('http://[2001:db8::1]:4000/docs'), false);
    assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
    assert.equal(isSafeExternalUrl('file://[::1]/tmp/propr'), false);
    assert.equal(isSafeExternalUrl('https://token@example.com'), false);
  });

  it('requires an exact loopback development origin', () => {
    assert.equal(validatedDevServerUrl('http://localhost:5173/')?.origin, 'http://localhost:5173');
    assert.equal(validatedDevServerUrl('http://[::1]:5173/')?.origin, 'http://[::1]:5173');
    assert.equal(validatedDevServerUrl('https://localhost:5173/'), null);
    assert.equal(validatedDevServerUrl('http://0.0.0.0:5173/'), null);
    assert.equal(validatedDevServerUrl('http://[2001:db8::1]:5173/'), null);
    assert.equal(validatedDevServerUrl('ws://[::1]:5173/'), null);
    assert.equal(validatedDevServerUrl('http://localhost:5173/path'), null);
    assert.equal(
      isTrustedRendererUrl('http://localhost:5173/renderer.html', 'http://localhost:5173/', '/unused'),
      true,
    );
    assert.equal(
      isTrustedRendererUrl('http://127.0.0.1:5173/renderer.html', 'http://localhost:5173/', '/unused'),
      false,
    );
    assert.equal(
      isTrustedRendererUrl('http://127.1:5173/renderer.html', 'http://127.0.0.1:5173/', '/unused'),
      false,
    );
  });

  it('retains IPC trust for hash-routed packaged renderer URLs only', () => {
    const renderer = 'propr-app://renderer/renderer.html';
    assert.equal(isTrustedRendererUrl(renderer, undefined, renderer), true);
    assert.equal(isTrustedRendererUrl(`${renderer}#/plans/123`, undefined, renderer), true);
    assert.equal(isTrustedRendererUrl(`${renderer}?profile=123#/plans/123`, undefined, renderer), false);
    assert.equal(isTrustedRendererUrl('propr-app://renderer/other.html', undefined, renderer), false);
    assert.equal(isTrustedRendererUrl('propr-app://other/renderer.html#/plans/123', undefined, renderer), false);
    assert.equal(isTrustedRendererUrl('https://propr.example.com', undefined, renderer), false);
  });

  it('allowlists custom protocol actions and extracts them from argv', () => {
    const link = 'propr://connect?api=https%3A%2F%2Fpropr.example.com';
    assert.equal(normalizeDeepLink(link), link);
    assert.equal(deepLinkFromArguments(['electron', '.', link]), link);
    assert.equal(normalizeDeepLink('propr://delete-everything'), null);
    assert.equal(normalizeDeepLink('https://propr.example.com'), null);
    assert.equal(normalizeDeepLink('propr://user:secret@connect'), null);
  });

  it('accepts only one bounded canonical Connect API candidate', () => {
    const link = 'propr://connect?api=https%3A%2F%2Fconnect.propr.dev';
    assert.equal(connectApiBaseUrlFromDeepLink(link), 'https://connect.propr.dev');
    assert.equal(normalizeDeepLink(link), link);

    const rejected = [
      'propr://connect',
      'propr://connect?api=',
      'propr://connect?api=https%3A%2F%2Fconnect.propr.dev&api=https%3A%2F%2Fother.example',
      'propr://connect?api=https%3A%2F%2Fconnect.propr.dev&token=secret',
      'propr://connect?url=https%3A%2F%2Fconnect.propr.dev',
      'propr://user:secret@connect?api=https%3A%2F%2Fconnect.propr.dev',
      'propr://connect:443?api=https%3A%2F%2Fconnect.propr.dev',
      'propr://connect/path?api=https%3A%2F%2Fconnect.propr.dev',
      'propr://connect?api=https%3A%2F%2Fconnect.propr.dev#fragment',
      'propr://connect?api=http%3A%2F%2Fconnect.propr.dev',
      'propr://connect?api=https%3A%2F%2Fuser%3Asecret%40connect.propr.dev',
      'propr://connect?api=https%3A%2F%2Fconnect.propr.dev%2Fapi',
      'propr://connect?api=https%3A%2F%2Fconnect.propr.dev%3Ftoken%3Dsecret',
      'propr://connect?api=https%3A%2F%2Fconnect.propr.dev%23secret',
      'propr://connect?api=https%253A%252F%252Fconnect.propr.dev',
    ];
    rejected.forEach(candidate => {
      assert.equal(connectApiBaseUrlFromDeepLink(candidate), null, candidate);
      assert.equal(normalizeDeepLink(candidate), null, candidate);
    });

    const oversized = `propr://connect?api=https%3A%2F%2Fexample.com&${'x'.repeat(2_048)}`;
    assert.ok(oversized.length > 2_048);
    assert.equal(connectApiBaseUrlFromDeepLink(oversized), null);
    assert.equal(normalizeDeepLink(oversized), null);

    const expandedApi = `https://${Array(300).fill('é').join('.')}.example`;
    const rawLink = `propr://connect?api=${expandedApi}`;
    const expandedCanonicalLink = new URL(rawLink).href;
    assert.ok(rawLink.length < 2_048);
    assert.ok(expandedCanonicalLink.length > 2_048);
    assert.notEqual(connectApiBaseUrlFromDeepLink(rawLink), null);
    assert.equal(normalizeDeepLink(rawLink), null);
  });

  it('does not canonicalize malformed reserved Connect origins into trusted candidates', () => {
    const rejectedOrigins = [
      'https://t-instance123.propr.dev/',
      'HTTPS://t-instance123.propr.dev',
      'https://T-instance123.propr.dev',
      'https://t-instance123.propr.dev:443',
      'https://t-instance123.propr.dev:8443',
      'https://t-%69nstance123.propr.dev',
      'https://t-instance123.propr%2edev',
      'https://t-instance123.foo.propr.dev',
      'https://x.t-instance123.propr.dev',
      'https://t-instance123.propr.dev.',
    ];
    rejectedOrigins.forEach(origin => {
      const link = `propr://connect?api=${encodeURIComponent(origin)}`;
      assert.equal(connectApiBaseUrlFromDeepLink(link), null, origin);
      assert.equal(normalizeDeepLink(link), null, origin);
    });
  });

  it('accepts a normal internal dashboard route from an open deep link', () => {
    const link = 'propr://open?path=%2Ftasks';
    const queryAndHashLink = 'propr://open?path=%2Ftasks%3Fstatus%3Dopen%23recent';
    assert.equal(dashboardPathFromDeepLink(link), '/tasks');
    assert.equal(normalizeDeepLink(link), link);
    assert.equal(normalizeDesktopDashboardPath('/tasks?status=open'), '/tasks?status=open');
    assert.equal(dashboardPathFromDeepLink(queryAndHashLink), '/tasks?status=open#recent');
    assert.equal(normalizeDesktopDashboardPath('/tasks?status=open#recent'), '/tasks?status=open#recent');
  });

  it('revalidates open links after canonical serialization', () => {
    const rawPath = `/tasks/${'é '.repeat(300)}end`;
    const rawLink = `propr://open?path=${rawPath}`;
    const expandedCanonicalLink = new URL(rawLink).href;
    assert.ok(rawLink.length < 2_048);
    assert.ok(expandedCanonicalLink.length > 2_048);
    assert.notEqual(dashboardPathFromDeepLink(rawLink), null);
    assert.equal(dashboardPathFromDeepLink(expandedCanonicalLink), null);
    assert.equal(normalizeDeepLink(rawLink), null);

    const canonicalPrefix = 'propr://open?path=%2Ftasks%2F';
    const suffix = 'a'.repeat(2_048 - canonicalPrefix.length);
    const boundaryCanonicalLink = `${canonicalPrefix}${suffix}`;
    assert.equal(boundaryCanonicalLink.length, 2_048);
    assert.equal(new URL(boundaryCanonicalLink).href, boundaryCanonicalLink);
    assert.equal(dashboardPathFromDeepLink(boundaryCanonicalLink), `/tasks/${suffix}`);
    assert.equal(normalizeDeepLink(boundaryCanonicalLink), boundaryCanonicalLink);
  });

  it('rejects encoded delimiters combined with encoded traversal', () => {
    const rejectedPaths = [
      '/tasks%23/%2e%2e/login',
      '/tasks%23/%252e%252e/login',
      '/tasks%3f/%2e%2e/login',
      '/tasks%3f/%252e%252e/login',
    ];

    rejectedPaths.forEach(path => {
      const link = `propr://open?path=${encodeURIComponent(path)}`;
      assert.equal(normalizeDesktopDashboardPath(path), null, path);
      assert.equal(dashboardPathFromDeepLink(link), null, link);
      assert.equal(normalizeDeepLink(link), null, link);
    });
  });

  it('rejects malformed and unsafe open deep-link paths', () => {
    const rejected = [
      'propr://open',
      'propr://open?path=',
      'propr://open?path=%2Ftasks&path=%2Fplans',
      'propr://open?path=%2Ftasks&extra=true',
      'propr://open?path=https%3A%2F%2Fevil.example%2Ftasks',
      'propr://open?path=%2F%2Fevil.example%2Ftasks',
      'propr://open?path=%2Ftasks%252F..%252Flogin',
      'propr://open?path=%2Ftasks%252F%252e%252e%252Flogin',
      'propr://open?path=%2Ftasks%250Anext',
      'propr://open?path=%2Ftasks%255Cnext',
      'propr://open?path=%2Flogin%3Fredirect_to%3D%252Ftasks',
      'propr://open?path=%2Fdesktop%2Fpairing%3Fpairing_id%3Dattacker',
      'propr://open?path=%2Ftasks%3Ftunnel%3Dt-attacker.propr.dev',
      'propr://open?path=%2Ftasks%3Fflow%3Dattacker',
    ];
    rejected.forEach(link => {
      assert.equal(dashboardPathFromDeepLink(link), null, link);
      assert.equal(normalizeDeepLink(link), null, link);
    });
  });

  it('publishes a restrictive production policy', () => {
    const policy = rendererContentSecurityPolicy();
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /frame-src 'none'/);
    assert.doesNotMatch(policy, /unsafe-eval/);
    assert.match(policy, /script-src 'self'(?:;|$)/);
    assert.match(policy, /connect-src 'self' https: wss:/);
    assert.doesNotMatch(policy, /(?:^|\s)http:(?:\s|;|$)/);
    assert.doesNotMatch(policy, /(?:^|\s)ws:(?:\s|;|$)/);
  });

  it('scopes packaged cleartext connections to exact normalized loopback profiles', () => {
    const connectSources = (candidate: string): string[] => {
      const policy = rendererContentSecurityPolicy(false, [candidate]);
      const directive = policy.split('; ').find(value => value.startsWith('connect-src '));
      assert.ok(directive);
      return directive.slice('connect-src '.length).split(' ');
    };

    for (const origin of [
      'http://localhost:4000',
      'http://team.localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.99.2.3:49152',
      'http://[::1]:4000',
    ]) {
      const sources = connectSources(origin);
      assert.ok(sources.includes(origin), origin);
      assert.ok(sources.includes(origin.replace(/^http:/, 'ws:')), origin);
      assert.ok(sources.includes('https:'), origin);
      assert.ok(sources.includes('wss:'), origin);
    }
  });

  it('does not admit non-loopback or deceptive cleartext CSP sources', () => {
    const rejected = [
      'http://192.168.1.20:4000',
      'http://example.test:4000',
      'http://localhost.example.test:4000',
      'http://localhost.:4000',
      'http://127.1:4000',
      'http://0177.0.0.1:4000',
      'http://0x7f000001:4000',
      'http://[::ffff:127.0.0.1]:4000',
    ];
    const policy = rendererContentSecurityPolicy(false, rejected);
    assert.match(policy, /connect-src 'self' https: wss:/);
    assert.equal(rejected.some(candidate => policy.includes(candidate)), false);
    assert.doesNotMatch(policy, /(?:^|\s)http:(?:\s|;|$)/);
    assert.doesNotMatch(policy, /(?:^|\s)ws:(?:\s|;|$)/);
  });

  it('keeps remote HTTPS and WSS scheme support without adding cleartext sources', () => {
    const policy = rendererContentSecurityPolicy(false, [
      'https://propr.example.test',
      'https://t-instance123.propr.dev',
    ]);
    assert.match(policy, /connect-src 'self' https: wss:/);
    assert.doesNotMatch(policy, /(?:^|\s)http:(?:\s|;|$)/);
    assert.doesNotMatch(policy, /(?:^|\s)ws:(?:\s|;|$)/);
  });

  it('reloads only the latest current renderer across replacement and overlapping policy changes', () => {
    const scheduled: Array<() => void> = [];
    const reloads: string[] = [];
    const renderer = (name: string) => ({
      isDestroyed: () => false,
      reload: () => { reloads.push(name); },
    });
    let currentRenderer = renderer('first');
    const reloadLatest = createLatestRendererReloader(
      () => currentRenderer,
      callback => { scheduled.push(callback); },
    );

    reloadLatest();
    currentRenderer = renderer('replacement');
    reloadLatest();
    currentRenderer = renderer('current');
    scheduled[0]();
    scheduled[1]();

    assert.deepEqual(reloads, ['current']);
  });

  it('relaxes inline scripts only while Vite serves the development renderer', () => {
    const packagedPolicy = rendererContentSecurityPolicy();
    const source = `<meta http-equiv="Content-Security-Policy" content="${packagedPolicy}">`;
    const transformed = applyDevelopmentRendererCsp(source);

    assert.match(transformed, /script-src 'self' 'unsafe-inline'/);
    assert.equal(applyDevelopmentRendererCsp(source).includes(rendererContentSecurityPolicy(true)), true);
    assert.match(packagedPolicy, /script-src 'self'(?:;|$)/);
  });
});
