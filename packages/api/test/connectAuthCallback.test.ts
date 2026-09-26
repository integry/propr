import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { createConnectCallbackHandler } from '../auth.js';
import { getValidatedRedirectTo } from '../authRedirect.js';
import type { AuthSession } from '../authSession.js';

const originalFrontendUrl = process.env.FRONTEND_URL;

after(async () => {
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
  await closeConnection();
});

test('Connect login preserves a validated redirect_to across Passport session regeneration', async () => {
  process.env.FRONTEND_URL = 'https://app.example.com';
  const app = express();
  const testPassport = new passport.Passport();
  testPassport.serializeUser((user, done) => done(null, user));
  app.use(session({
    secret: 'connect-callback-test-secret-with-sufficient-length',
    resave: false,
    saveUninitialized: false,
  }));
  app.use(testPassport.initialize());

  const redirectTo = 'https://app.example.com/plans';
  app.get('/start', (req, res) => {
    const validatedRedirect = getValidatedRedirectTo(req.query.redirect_to as string | undefined);
    assert.equal(validatedRedirect, redirectTo);
    const authSession = req.session as AuthSession;
    authSession.redirectTo = validatedRedirect;
    authSession.connectOAuthState = 'validated-state';
    req.session.save(error => {
      if (error) throw error;
      res.sendStatus(204);
    });
  });
  app.get('/callback', createConnectCallbackHandler(async () => ({
    id: '123',
    login: 'octocat',
    username: 'octocat',
    displayName: 'Octocat',
    email: null,
    avatarUrl: null,
    accessToken: 'gho_test',
  })));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const startResponse = await fetch(`${origin}/start?redirect_to=${encodeURIComponent(redirectTo)}`);
    const cookie = startResponse.headers.get('set-cookie');
    assert.ok(cookie);

    const callbackResponse = await fetch(`${origin}/callback?state=validated-state&code=one-use-code`, {
      headers: { cookie: cookie.split(';', 1)[0] },
      redirect: 'manual',
    });

    assert.equal(callbackResponse.status, 302);
    assert.equal(callbackResponse.headers.get('location'), redirectTo);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
