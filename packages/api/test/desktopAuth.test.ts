import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up as createDesktopAuthTables } from '../../core/src/db/migrations/20260829000000_create_desktop_auth.js';
import {
  DesktopAuthError,
  DesktopAuthService,
  INSTANCE_TOKEN_PREFIX,
} from '../desktopAuthService.js';
import {
  isTrustedPairingApprovalOrigin,
  requireBrowserPairingSession,
} from '../routes/desktopAuthRoutes.js';
import type { GitHubUser } from '../authTypes.js';
import { ensureAuthenticated } from '../auth.js';

const owner: GitHubUser = {
  id: '101',
  login: 'desktop-owner',
  username: 'desktop-owner',
  displayName: 'Desktop Owner',
  email: 'owner@example.test',
  avatarUrl: 'https://avatars.example.test/101',
  accessToken: 'github-secret-that-must-not-be-stored',
};

let database: Knex;
let now: Date;
let service: DesktopAuthService;

beforeEach(async () => {
  database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await createDesktopAuthTables(database);
  now = new Date('2026-08-29T14:00:00.000Z');
  service = new DesktopAuthService({
    database,
    now: () => new Date(now),
    approvalBaseUrl: 'https://app.example.test/base/',
  });
});

afterEach(async () => database.destroy());
after(async () => closeConnection());

describe('desktop browser pairing', () => {
  test('stores only a device-secret hash and builds a fixed trusted approval URL', async () => {
    const pairing = await service.startPairing('  Work   Laptop  ');
    const row = await database('desktop_pairing_requests').where({ id: pairing.pairingId }).first();
    const audit = await database('desktop_auth_audit').first();

    assert.match(pairing.pairingId, /^dpr_[A-Za-z0-9_-]{22}$/);
    assert.match(pairing.deviceSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(pairing.approvalUrl, `https://app.example.test/base/desktop/pairing?pairing_id=${pairing.pairingId}`);
    assert.equal(pairing.approvalUrl.includes(pairing.deviceSecret), false);
    assert.equal(row.client_name, 'Work Laptop');
    assert.notEqual(row.device_secret_hash, pairing.deviceSecret);
    assert.equal(JSON.stringify(row).includes(pairing.deviceSecret), false);
    assert.equal(JSON.stringify(audit).includes(pairing.deviceSecret), false);
  });

  test('uses the configured API browser entry and preserves only a managed hosted tunnel selector', async () => {
    const hosted = new DesktopAuthService({
      database,
      now: () => new Date(now),
      approvalBaseUrl: 'https://app.propr.dev',
      publicApiUrl: 'https://t-instance123.propr.dev',
    });
    const pairing = await hosted.startPairing('Windows desktop');

    assert.equal(
      pairing.approvalUrl,
      `https://t-instance123.propr.dev/api/desktop/pairings/${pairing.pairingId}/browser`,
    );
    assert.equal(
      hosted.getFrontendApprovalUrl(pairing.pairingId).toString(),
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairing.pairingId}&tunnel=t-instance123.propr.dev`,
    );
  });

  test('does not place a Connect selector in hosted approval URLs for lookalike API hosts', async () => {
    const lookalike = new DesktopAuthService({
      database,
      now: () => new Date(now),
      approvalBaseUrl: 'https://app.propr.dev',
      publicApiUrl: 'https://t-instance123.propr.dev.example.com',
    });
    const pairing = await lookalike.startPairing('Lookalike test');

    assert.equal(
      lookalike.getFrontendApprovalUrl(pairing.pairingId).toString(),
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairing.pairingId}`,
    );
  });

  test('rejects noncanonical reserved API_PUBLIC_URL spellings before starting pairing', async () => {
    for (const publicApiUrl of [
      ' https://t-instance123.propr.dev',
      'https://t-instance123.propr.dev ',
      'https://t-instance123.propr.dev/',
      'https://t-instance123.propr.dev//',
      'HTTPS://t-instance123.propr.dev',
      'https://T-instance123.propr.dev',
      'https://user:secret@t-instance123.propr.dev',
      'https://t-instance123.propr.dev:443',
      'https://t-instance123.propr.dev?query=secret',
      'https://t-instance123.propr.dev#fragment',
      'https://t-%69nstance123.propr.dev',
      'https://t-%zz.propr.dev',
      'https://x.t-instance123.propr.dev',
      'https://nested.t-instance123.propr.dev',
      `https://t-instance123.propr.dev${' '.repeat(2049)}`,
    ]) {
      const invalidConnect = new DesktopAuthService({
        database,
        now: () => new Date(now),
        approvalBaseUrl: 'https://app.propr.dev',
        publicApiUrl,
      });

      await assert.rejects(
        invalidConnect.startPairing('Invalid Connect test'),
        (error: unknown) => error instanceof DesktopAuthError
          && error.code === 'PAIRING_CONFIGURATION_INVALID'
          && error.status === 503
          && error.message === 'Desktop pairing is unavailable because the public API URL is invalid',
      );
    }

    assert.equal(await database('desktop_pairing_requests').count<{ count: number }>('* as count').first()
      .then(result => Number(result?.count)), 0);
  });

  test('issues an opaque token once, resolves its owner, and never stores plaintext credentials', async () => {
    const pairing = await service.startPairing('MacBook Pro');
    assert.deepEqual(await service.pollPairing(pairing.pairingId, pairing.deviceSecret), {
      status: 'pending',
      interval: 5,
    });
    await service.approvePairing(pairing.pairingId, owner);

    const completed = await service.pollPairing(pairing.pairingId, pairing.deviceSecret);
    assert.equal(completed.status, 'complete');
    if (completed.status !== 'complete') return;
    assert.match(completed.token, new RegExp(`^${INSTANCE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
    assert.equal(completed.expiresAt, null);

    const tokenRow = await database('instance_api_tokens').first();
    const pairingRow = await database('desktop_pairing_requests').first();
    const databaseDump = JSON.stringify({ tokenRow, pairingRow });
    assert.equal(databaseDump.includes(completed.token), false);
    assert.equal(databaseDump.includes(pairing.deviceSecret), false);
    assert.equal(databaseDump.includes(owner.accessToken!), false);
    assert.equal(tokenRow.owner_github_user_id, owner.id);
    assert.equal(pairingRow.status, 'consumed');

    await assert.rejects(
      service.pollPairing(pairing.pairingId, pairing.deviceSecret),
      (error: unknown) => error instanceof DesktopAuthError && error.code === 'PAIRING_ALREADY_CONSUMED',
    );

    const identity = await service.validateToken(completed.token);
    assert.equal(identity?.user.id, owner.id);
    assert.equal(identity?.user.accessToken, undefined);
    assert.equal((await database('instance_api_tokens').first()).last_used_at, now.toISOString());
  });

  test('rejects the wrong secret without revealing pairing state', async () => {
    const pairing = await service.startPairing('Linux workstation');
    await service.approvePairing(pairing.pairingId, owner);

    await assert.rejects(
      service.pollPairing(pairing.pairingId, 'A'.repeat(43)),
      (error: unknown) => error instanceof DesktopAuthError
        && error.code === 'PAIRING_NOT_FOUND'
        && error.status === 404,
    );
    assert.equal((await database('desktop_pairing_requests').first()).status, 'approved');
  });

  test('expires unapproved pairings and cleans retained expired records', async () => {
    const expiringService = new DesktopAuthService({
      database,
      now: () => new Date(now),
      pairingTtlMs: 1_000,
      approvalBaseUrl: 'https://app.example.test',
    });
    const pairing = await expiringService.startPairing('Old laptop');
    now = new Date(now.getTime() + 1_001);

    await assert.rejects(
      expiringService.pollPairing(pairing.pairingId, pairing.deviceSecret),
      (error: unknown) => error instanceof DesktopAuthError && error.code === 'PAIRING_EXPIRED',
    );
    assert.equal(await expiringService.cleanupPairings(), 0, 'recent expired rows remain briefly for stable errors');
    now = new Date(now.getTime() + 24 * 60 * 60_000);
    assert.equal(await expiringService.cleanupPairings(), 1);
  });

  test('rejects unsafe names and non-HTTPS approval origins', async () => {
    await assert.rejects(service.startPairing('bad\nname'), /printable characters/);
    await assert.rejects(service.startPairing('x'.repeat(81)), /1 to 80/);
    const insecure = new DesktopAuthService({ database, approvalBaseUrl: 'http://remote.example.test' });
    await assert.rejects(insecure.startPairing('Laptop'), /requires HTTPS/);
  });
});

describe('instance token ownership and revocation', () => {
  async function issueToken(): Promise<{ token: string; tokenId: string }> {
    const pairing = await service.startPairing('Desktop app');
    await service.approvePairing(pairing.pairingId, owner);
    const completed = await service.pollPairing(pairing.pairingId, pairing.deviceSecret);
    assert.equal(completed.status, 'complete');
    if (completed.status !== 'complete') throw new Error('token was not issued');
    const tokenId = (await service.listTokens(owner.id))[0].id;
    return { token: completed.token, tokenId };
  }

  test('lists safe metadata only and limits revocation to the owner', async () => {
    const { token, tokenId } = await issueToken();
    const listed = await service.listTokens(owner.id);

    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes(token), false);
    assert.deepEqual(await service.listTokens('someone-else'), []);
    await assert.rejects(
      service.revokeToken(tokenId, { ...owner, id: 'someone-else' }),
      (error: unknown) => error instanceof DesktopAuthError && error.code === 'TOKEN_NOT_FOUND',
    );
    assert.notEqual(await service.validateToken(token), null);

    await service.revokeToken(tokenId, owner);
    assert.equal(await service.validateToken(token), null);
    assert.notEqual((await service.listTokens(owner.id))[0].revokedAt, null);
  });

  test('honors optional token expiry', async () => {
    service = new DesktopAuthService({
      database,
      now: () => new Date(now),
      tokenTtlMs: 1_000,
      approvalBaseUrl: 'https://app.example.test',
    });
    const { token } = await issueToken();
    now = new Date(now.getTime() + 1_001);
    assert.equal(await service.validateToken(token), null);
  });

  test('REST authentication accepts instance tokens while optional GitHub bearer auth is disabled', async () => {
    const original = process.env.ENABLE_BEARER_AUTH;
    process.env.ENABLE_BEARER_AUTH = 'false';
    const request = {
      headers: { authorization: `Bearer ${INSTANCE_TOKEN_PREFIX}${'A'.repeat(43)}` },
      isAuthenticated: () => false,
    } as unknown as Request;
    let nextCalls = 0;
    const response = {} as Response;
    try {
      await ensureAuthenticated(request, response, (() => { nextCalls++; }) as NextFunction, async () => ({
        tokenId: 'token-1',
        user: owner,
      }));
    } finally {
      if (original === undefined) delete process.env.ENABLE_BEARER_AUTH;
      else process.env.ENABLE_BEARER_AUTH = original;
    }

    assert.equal(nextCalls, 1);
    assert.equal(request.authenticationMethod, 'instance_token');
    assert.equal(request.instanceTokenId, 'token-1');
    assert.equal(request.user?.id, owner.id);
  });
});

describe('pairing approval request protection', () => {
  test('accepts only the exact HTTPS frontend origin', () => {
    assert.equal(isTrustedPairingApprovalOrigin('https://app.example.test', 'https://app.example.test/path'), true);
    assert.equal(isTrustedPairingApprovalOrigin('https://preview.app.example.test', 'https://app.example.test'), false);
    assert.equal(isTrustedPairingApprovalOrigin('http://app.example.test', 'https://app.example.test'), false);
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
