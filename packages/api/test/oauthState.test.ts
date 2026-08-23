import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Request } from 'express';
import { closeConnection } from '@propr/core';
import { createGitHubOAuthStrategy } from '../auth.js';

after(async () => {
  await closeConnection();
});

interface TestStrategy {
  authenticate(request: Request, options?: object): void;
  redirect(location: string): void;
  fail(challenge: unknown, status?: number): void;
  error(error: Error): void;
}

function createStrategy(): TestStrategy {
  return createGitHubOAuthStrategy({
    clientID: 'client-id',
    clientSecret: 'client-secret',
    callbackURL: 'http://localhost:4000/api/auth/github/callback',
  }) as unknown as TestStrategy;
}

test('GitHub OAuth authorization stores and sends a random state nonce', () => {
  const strategy = createStrategy();
  const session: Record<string, unknown> = {};
  let redirect: string | undefined;
  strategy.redirect = location => { redirect = location; };
  strategy.error = error => { throw error; };

  strategy.authenticate({ query: {}, session } as unknown as Request);

  assert.ok(redirect);
  const state = new URL(redirect).searchParams.get('state');
  assert.ok(state);
  assert.match(state, /^[A-Za-z0-9_-]{24,}$/);
  assert.ok(Object.keys(session).some(key => key.startsWith('oauth2:')));
});

test('GitHub OAuth callback rejects a mismatched state before token exchange', () => {
  const strategy = createStrategy();
  const session: Record<string, unknown> = {};
  let redirect: string | undefined;
  strategy.redirect = location => { redirect = location; };
  strategy.error = error => { throw error; };
  strategy.authenticate({ query: {}, session } as unknown as Request);
  assert.ok(redirect);

  let failure: unknown;
  strategy.fail = challenge => { failure = challenge; };
  strategy.authenticate({
    query: { code: 'untrusted-code', state: 'wrong-state' },
    session,
  } as unknown as Request);

  assert.deepEqual(failure, { message: 'Invalid authorization request state.' });
});
