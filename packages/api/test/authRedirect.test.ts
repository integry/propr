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

test('auth redirect allowlist permits leading-dot COOKIE_DOMAIN subdomains', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'https://app.example.org';
  process.env.COOKIE_DOMAIN = '.example.com';
  const app = express();
  setupAuth(app);

  const response = await fetchFromApp(app, '/api/auth/github?redirect_to=https%3A%2F%2Fpreview.example.com%2Fplans');

  assert.equal(response.headers.get('location'), 'https://preview.example.com/plans');
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

test('auth redirect allowlist only permits cleartext HTTP for localhost', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  process.env.AUTH_REDIRECT_ALLOWED_HOSTS = 'app.example.com';
  const app = express();
  setupAuth(app);

  const localResponse = await fetchFromApp(app, '/api/auth/github?redirect_to=http%3A%2F%2Flocalhost%3A5173%2Fplans');
  assert.equal(localResponse.headers.get('location'), 'http://localhost:5173/plans');

  const remoteResponse = await fetchFromApp(app, '/api/auth/github?redirect_to=http%3A%2F%2Fapp.example.com%2Fplans');
  assert.equal(remoteResponse.headers.get('location'), 'http://localhost:5173/');
});

test('auth redirect allowlist permits configured local IP literals', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'http://127.0.0.1:5173';
  process.env.AUTH_REDIRECT_ALLOWED_HOSTS = 'http://[::1]:5173';
  const app = express();
  setupAuth(app);

  const ipv4Response = await fetchFromApp(app, '/api/auth/github?redirect_to=http%3A%2F%2F127.0.0.1%3A5173%2Fplans');
  assert.equal(ipv4Response.headers.get('location'), 'http://127.0.0.1:5173/plans');

  const ipv6Response = await fetchFromApp(app, '/api/auth/github?redirect_to=http%3A%2F%2F%5B%3A%3A1%5D%3A5173%2Fplans');
  assert.equal(ipv6Response.headers.get('location'), 'http://[::1]:5173/plans');
});

test('auth redirect allowlist ignores malformed additional host entries', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'https://app.example.com';
  process.env.AUTH_REDIRECT_ALLOWED_HOSTS = 'https://bad host, *.valid.example.com';
  const app = express();
  setupAuth(app);

  const malformedResponse = await fetchFromApp(app, '/api/auth/github?redirect_to=https%3A%2F%2Fbad%2520host%2Fplans');
  assert.equal(malformedResponse.headers.get('location'), 'https://app.example.com/');

  const validResponse = await fetchFromApp(app, '/api/auth/github?redirect_to=https%3A%2F%2Fpr.valid.example.com%2Fplans');
  assert.equal(validResponse.headers.get('location'), 'https://pr.valid.example.com/plans');
});
