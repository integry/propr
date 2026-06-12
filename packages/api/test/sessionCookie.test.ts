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

test('secure session cookie follows API_PUBLIC_URL protocol', () => {
  process.env.API_PUBLIC_URL = 'https://api.example.com';
  assert.equal(shouldUseSecureSessionCookie(undefined), true);

  process.env.API_PUBLIC_URL = 'http://localhost:4000';
  assert.equal(shouldUseSecureSessionCookie('.example.com'), false);
});

test('secure session cookie defaults on in production without public URL', () => {
  delete process.env.API_PUBLIC_URL;
  delete process.env.COOKIE_DOMAIN;
  process.env.NODE_ENV = 'production';

  assert.equal(shouldUseSecureSessionCookie(undefined), true);
});
