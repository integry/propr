import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { closeConnection } from '@propr/core';
import {
  isTrustedPairingApprovalOrigin,
  requireBrowserPairingSession,
} from '../routes/desktopAuthRoutes.js';
import type { GitHubUser } from '../authTypes.js';

const owner: GitHubUser = {
  id: '101',
  login: 'desktop-owner',
  username: 'desktop-owner',
  displayName: 'Desktop Owner',
  email: 'owner@example.test',
  avatarUrl: 'https://avatars.example.test/101',
  accessToken: 'github-secret-that-must-not-be-stored',
};

after(async () => closeConnection());

describe('pairing approval request protection', () => {
  test('accepts only the exact HTTPS frontend origin', () => {
    assert.equal(isTrustedPairingApprovalOrigin('https://app.example.test', 'https://app.example.test/path'), true);
    assert.equal(isTrustedPairingApprovalOrigin('https://preview.app.example.test', 'https://app.example.test'), false);
    assert.equal(isTrustedPairingApprovalOrigin('http://app.example.test', 'https://app.example.test'), false);
    assert.equal(isTrustedPairingApprovalOrigin('http://127.1:3000', 'http://127.0.0.1:3000'), false);
    assert.equal(isTrustedPairingApprovalOrigin('http://local%68ost:3000', 'http://localhost:3000'), false);
    assert.equal(isTrustedPairingApprovalOrigin(undefined, 'https://app.example.test'), false);
  });

  test('requires a browser session even when another authentication method supplied the user', () => {
    const guard = requireBrowserPairingSession();
    const calls: Array<{ status?: number; body?: unknown }> = [];
    const response = {
      status(value: number) { calls.push({ status: value }); return response; },
      json(value: unknown) { calls[calls.length - 1].body = value; return response; },
    } as unknown as Response;
    let nextCalls = 0;
    const next = (() => { nextCalls++; }) as NextFunction;

    guard({
      authenticationMethod: 'instance_token',
      user: owner,
      isAuthenticated: () => false,
      header: () => 'https://app.example.test',
    } as unknown as Request, response, next);
    assert.equal(calls[0].status, 403);

    guard({
      authenticationMethod: 'session',
      user: owner,
      isAuthenticated: () => true,
      header: () => 'https://app.example.test',
    } as unknown as Request, response, next);
    assert.equal(nextCalls, 1);
  });
});
