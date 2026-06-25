import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCorsOriginValidator } from '../corsValidation.js';

// Helper that runs the validator synchronously and reports whether the origin
// was allowed.
function isAllowed(validate: ReturnType<typeof createCorsOriginValidator>, origin: string | undefined): boolean {
  let allowed = false;
  validate(origin, (err, allow) => {
    allowed = !err && allow === true;
  });
  return allowed;
}

test('CORS allows the hosted UI origin under proxy mode', () => {
  // app.propr.dev is the hosted UI; cookies live on the per-instance proxy host,
  // so COOKIE_DOMAIN is intentionally unset.
  const validate = createCorsOriginValidator('https://app.propr.dev', undefined);

  assert.equal(isAllowed(validate, 'https://app.propr.dev'), true);
});

test('CORS rejects unrelated origins under proxy mode', () => {
  const validate = createCorsOriginValidator('https://app.propr.dev', undefined);

  assert.equal(isAllowed(validate, 'https://evil.example.com'), false);
  // A look-alike subdomain of the hosted UI is not the exact origin and must be
  // rejected when COOKIE_DOMAIN is unset.
  assert.equal(isAllowed(validate, 'https://app.propr.dev.evil.example.com'), false);
});

test('CORS allows requests with no origin', () => {
  const validate = createCorsOriginValidator('https://app.propr.dev', undefined);

  assert.equal(isAllowed(validate, undefined), true);
});

test('CORS allows localhost for development', () => {
  const validate = createCorsOriginValidator('https://app.propr.dev', undefined);

  assert.equal(isAllowed(validate, 'http://localhost:5173'), true);
  assert.equal(isAllowed(validate, 'http://127.0.0.1:5173'), true);
});

test('CORS allows COOKIE_DOMAIN subdomains for preview environments', () => {
  const validate = createCorsOriginValidator('https://app.example.com', '.example.com');

  assert.equal(isAllowed(validate, 'https://app.example.com'), true);
  assert.equal(isAllowed(validate, 'https://pr-1.example.com'), true);
  assert.equal(isAllowed(validate, 'https://example.com'), true);
  assert.equal(isAllowed(validate, 'https://other.example.org'), false);
});

test('CORS validator factory throws on an invalid FRONTEND_URL', () => {
  assert.throws(() => createCorsOriginValidator('not-a-url', undefined));
});
