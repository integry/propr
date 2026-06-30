import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getSessionCookieDomain, shouldUseSecureSessionCookie } from '../auth.js';

const originalApiPublicUrl = process.env.API_PUBLIC_URL;
const originalCookieDomain = process.env.COOKIE_DOMAIN;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalApiPublicUrl === undefined) delete process.env.API_PUBLIC_URL;
  else process.env.API_PUBLIC_URL = originalApiPublicUrl;
  if (originalCookieDomain === undefined) delete process.env.COOKIE_DOMAIN;
  else process.env.COOKIE_DOMAIN = originalCookieDomain;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

test('session cookie domain only comes from COOKIE_DOMAIN', () => {
  delete process.env.COOKIE_DOMAIN;
  process.env.API_PUBLIC_URL = 'https://api.example.com';

  assert.equal(getSessionCookieDomain(), undefined);
});

test('session cookie domain uses explicit COOKIE_DOMAIN', () => {
  process.env.COOKIE_DOMAIN = '.example.com';
  process.env.API_PUBLIC_URL = 'https://api.example.com';

  assert.equal(getSessionCookieDomain(), '.example.com');
});

test('secure session cookie follows API_PUBLIC_URL protocol for HTTPS and localhost HTTP', () => {
  process.env.API_PUBLIC_URL = 'https://api.example.com';
  assert.equal(shouldUseSecureSessionCookie(undefined), true);

  process.env.API_PUBLIC_URL = 'http://localhost:4000';
  assert.equal(shouldUseSecureSessionCookie('.example.com'), false);

  process.env.API_PUBLIC_URL = 'http://[::1]:4000';
  assert.equal(shouldUseSecureSessionCookie('.example.com'), false);
});

test('secure session cookie does not downgrade for non-localhost HTTP public URL', () => {
  process.env.API_PUBLIC_URL = 'http://api.example.com';
  process.env.COOKIE_DOMAIN = '.example.com';

  assert.equal(shouldUseSecureSessionCookie('.example.com'), true);
});

test('secure session cookie defaults on in production without public URL', () => {
  delete process.env.API_PUBLIC_URL;
  delete process.env.COOKIE_DOMAIN;
  process.env.NODE_ENV = 'production';

  assert.equal(shouldUseSecureSessionCookie(undefined), true);
});

test('proxy mode keeps the session cookie host-only on the proxy hostname', () => {
  // Hosted UI on app.propr.dev, API served from the per-instance proxy host.
  // COOKIE_DOMAIN must stay unset so the cookie is scoped only to
  // t-abc123.propr.dev rather than a broad shared domain.
  delete process.env.COOKIE_DOMAIN;
  process.env.API_PUBLIC_URL = 'https://t-abc123.propr.dev';

  assert.equal(getSessionCookieDomain(), undefined);
});

test('proxy mode keeps the session cookie secure over the https proxy URL', () => {
  delete process.env.COOKIE_DOMAIN;
  process.env.API_PUBLIC_URL = 'https://t-abc123.propr.dev';

  assert.equal(shouldUseSecureSessionCookie(getSessionCookieDomain()), true);
});
