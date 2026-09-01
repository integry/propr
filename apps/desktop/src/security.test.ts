import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
  it('only accepts HTTPS and loopback HTTP API endpoints', () => {
    assert.equal(normalizeApiBaseUrl('https://propr.example.com///'), 'https://propr.example.com');
    assert.equal(normalizeApiBaseUrl('http://localhost:4000/'), 'http://localhost:4000');
    assert.equal(normalizeApiBaseUrl('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
    assert.equal(normalizeApiBaseUrl('http://[::1]:4000/'), 'http://[::1]:4000');
    assert.equal(normalizeApiBaseUrl('https://propr.example.com/base'), null);
    assert.equal(normalizeApiBaseUrl('http://[::1]:4000/api'), null);
    assert.equal(normalizeApiBaseUrl('http://propr.example.com'), null);
    assert.equal(normalizeApiBaseUrl('http://[2001:db8::1]:4000'), null);
    assert.equal(normalizeApiBaseUrl('https://user:secret@propr.example.com'), null);
    assert.equal(normalizeApiBaseUrl('file:///tmp/propr'), null);
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
    assert.equal(connectApiBaseUrlFromDeepLink(link), 'https://propr.example.com');
    assert.equal(normalizeDeepLink('propr://connect?api=http%3A%2F%2Fexample.com'), null);
    assert.equal(normalizeDeepLink('propr://connect?api=https%3A%2F%2Fpropr.example.com&token=secret'), null);
    assert.equal(normalizeDeepLink('propr://connect?api=https%3A%2F%2Fuser%3Asecret%40propr.example.com'), null);
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
    assert.match(policy, /http:\/\/\[::1\]:\*/);
    assert.match(policy, /ws:\/\/\[::1\]:\*/);
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
