import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import express from 'express';
import { setupAuth } from '../auth.js';
import { resetConfiguredDemoMode } from '../demoMode.js';

const originalDemoMode = process.env.PROPR_DEMO_MODE;
const originalFrontendUrl = process.env.FRONTEND_URL;
const originalCookieDomain = process.env.COOKIE_DOMAIN;
const originalRedirectAllowedHosts = process.env.AUTH_REDIRECT_ALLOWED_HOSTS;

async function fetchFromApp(app: express.Express, path: string): Promise<globalThis.Response> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`, { redirect: 'manual' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

afterEach(() => {
  resetConfiguredDemoMode();
  if (originalDemoMode === undefined) delete process.env.PROPR_DEMO_MODE;
  else process.env.PROPR_DEMO_MODE = originalDemoMode;
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
  if (originalCookieDomain === undefined) delete process.env.COOKIE_DOMAIN;
  else process.env.COOKIE_DOMAIN = originalCookieDomain;
  if (originalRedirectAllowedHosts === undefined) delete process.env.AUTH_REDIRECT_ALLOWED_HOSTS;
  else process.env.AUTH_REDIRECT_ALLOWED_HOSTS = originalRedirectAllowedHosts;
});

test('auth redirect allowlist treats FRONTEND_URL as exact host only', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'https://app.example.com';
  process.env.COOKIE_DOMAIN = 'example.org';
  const app = express();
  setupAuth(app);

  const allowedResponse = await fetchFromApp(app, '/api/auth/github?redirect_to=https%3A%2F%2Fapp.example.com%2Fplans');
  assert.equal(allowedResponse.headers.get('location'), 'https://app.example.com/plans');

  const subdomainResponse = await fetchFromApp(app, '/api/auth/github?redirect_to=https%3A%2F%2Fpreview.app.example.com%2Fplans');
  assert.equal(subdomainResponse.headers.get('location'), 'https://app.example.com/');
});

test('auth redirect allowlist permits subdomains only for explicit wildcard-style hosts', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'https://app.example.com';
  process.env.AUTH_REDIRECT_ALLOWED_HOSTS = '.preview.example.com';
  const app = express();
  setupAuth(app);

  const response = await fetchFromApp(app, '/api/auth/github?redirect_to=https%3A%2F%2Fpr-1.preview.example.com%2Fplans');

  assert.equal(response.headers.get('location'), 'https://pr-1.preview.example.com/plans');
});

test('auth redirect allowlist permits exact additional hosts without permitting their subdomains', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'https://app.example.com';
  process.env.AUTH_REDIRECT_ALLOWED_HOSTS = 'https://exact.example.net';
  const app = express();
  setupAuth(app);

  const exactResponse = await fetchFromApp(app, '/api/auth/github?redirect_to=https%3A%2F%2Fexact.example.net%2Fplans');
  assert.equal(exactResponse.headers.get('location'), 'https://exact.example.net/plans');

  const subdomainResponse = await fetchFromApp(app, '/api/auth/github?redirect_to=https%3A%2F%2Fpreview.exact.example.net%2Fplans');
  assert.equal(subdomainResponse.headers.get('location'), 'https://app.example.com/');
});

test('auth redirect allowlist permits wildcard entries with protocol prefixes', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'https://app.example.com';
  process.env.AUTH_REDIRECT_ALLOWED_HOSTS = 'https://*.preview.example.net';
  const app = express();
  setupAuth(app);

  const response = await fetchFromApp(app, '/api/auth/github?redirect_to=https%3A%2F%2Fpr-2.preview.example.net%2Fplans');

  assert.equal(response.headers.get('location'), 'https://pr-2.preview.example.net/plans');
});

test('auth redirect allowlist rejects invalid URLs and non-http protocols', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'https://app.example.com';
  process.env.AUTH_REDIRECT_ALLOWED_HOSTS = '*.preview.example.com';
  const app = express();
  setupAuth(app);

  const invalidResponse = await fetchFromApp(app, '/api/auth/github?redirect_to=not-a-url');
  assert.equal(invalidResponse.headers.get('location'), 'https://app.example.com/');

  const protocolResponse = await fetchFromApp(app, '/api/auth/github?redirect_to=ftp%3A%2F%2Fapp.example.com%2Fplans');
  assert.equal(protocolResponse.headers.get('location'), 'https://app.example.com/');
});
