import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { PROPR_API_ORIGIN_PARITY_CASES } from '@propr/shared';
import { up as createDesktopAuthTables } from '../../core/src/db/migrations/20260829000000_create_desktop_auth.js';
import { up as addTwoPhaseDesktopPairing } from '../../core/src/db/migrations/20260830000000_add_two_phase_desktop_pairing.js';
import {
  DesktopAuthError,
  DesktopAuthService,
  INSTANCE_TOKEN_PREFIX,
} from '../desktopAuthService.js';
import {
  createDesktopAuthRoutes,
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
const pairingBinding = (origin = 'https://app.example.test') => ({
  instanceId: 'profile-a',
  origin,
  scope: 'desktop-instance' as const,
  credentialGeneration: 'G'.repeat(22),
});
const startPairing = (
  target: DesktopAuthService,
  name: string,
  origin = 'https://app.example.test',
) => target.startPairing(name, pairingBinding(origin));

beforeEach(async () => {
  database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await createDesktopAuthTables(database);
  await addTwoPhaseDesktopPairing(database);
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
    const pairing = await startPairing(service, '  Work   Laptop  ');
    const row = await database('desktop_pairing_requests').where({ id: pairing.pairingId }).first();
    const audit = await database('desktop_auth_audit').first();

    assert.match(pairing.pairingId, /^dpr_[A-Za-z0-9_-]{22}$/);
    assert.match(pairing.deviceSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(pairing.approvalUrl, `https://app.example.test/base/desktop/pairing?pairing_id=${pairing.pairingId}`);
    assert.equal(pairing.approvalUrl.includes(pairing.deviceSecret), false);
    assert.equal(row.client_name, 'Work Laptop');
    assert.equal(row.requested_origin, 'https://app.example.test');
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
    const pairing = await startPairing(hosted, 'Windows desktop', 'https://t-instance123.propr.dev');

    assert.equal(
      pairing.approvalUrl,
      `https://t-instance123.propr.dev/api/desktop/pairings/${pairing.pairingId}/browser`,
    );
    assert.equal(
      hosted.getFrontendApprovalUrl(pairing.pairingId).toString(),
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairing.pairingId}&tunnel=t-instance123.propr.dev`,
    );
  });

  test('provisions one unusable credential, then activates it exactly once without storing plaintext', async () => {
    const binding = pairingBinding();
    const pairing = await startPairing(service, 'MacBook Pro');
    assert.deepEqual(await service.pollPairing(pairing.pairingId, pairing.deviceSecret), {
      status: 'pending',
      interval: 5,
    });
    await service.approvePairing(pairing.pairingId, owner);

    const completed = await service.pollPairing(pairing.pairingId, pairing.deviceSecret);
    assert.equal(completed.status, 'provisional');
    if (completed.status !== 'provisional') return;
    assert.match(completed.token, new RegExp(`^${INSTANCE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
    assert.equal(await service.validateToken(completed.token), null);
    assert.deepEqual(await service.pollPairing(pairing.pairingId, pairing.deviceSecret), completed);

    const activation = {
      ...binding,
      deviceSecret: pairing.deviceSecret,
      activationTicket: completed.activationTicket,
    };
    const receipt = await service.activatePairing(pairing.pairingId, activation);
    assert.deepEqual(await service.activatePairing(pairing.pairingId, activation), receipt);

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
    const pairing = await startPairing(service, 'Linux workstation');
    await service.approvePairing(pairing.pairingId, owner);

    await assert.rejects(
      service.pollPairing(pairing.pairingId, 'A'.repeat(43)),
      (error: unknown) => error instanceof DesktopAuthError
        && error.code === 'PAIRING_NOT_FOUND'
        && error.status === 404,
    );
    assert.equal((await database('desktop_pairing_requests').first()).status, 'approved');
  });

  test('binds activation and cancellation exactly and keeps cancellation idempotent', async () => {
    const binding = pairingBinding();
    const pairing = await startPairing(service, 'Cancelled desktop');
    await service.approvePairing(pairing.pairingId, owner);
    const provisional = await service.pollPairing(pairing.pairingId, pairing.deviceSecret);
    assert.equal(provisional.status, 'provisional');
    if (provisional.status !== 'provisional') return;
    const exact = {
      ...binding,
      deviceSecret: pairing.deviceSecret,
      activationTicket: provisional.activationTicket,
    };
    await assert.rejects(
      service.activatePairing(pairing.pairingId, { ...exact, instanceId: 'wrong-profile' }),
      (error: unknown) => error instanceof DesktopAuthError && error.code === 'PAIRING_NOT_FOUND',
    );
    assert.equal(await service.validateToken(provisional.token), null);

    const cancelled = await service.cancelPairing(pairing.pairingId, exact);
    assert.deepEqual(await service.cancelPairing(pairing.pairingId, exact), cancelled);
    await assert.rejects(
      service.activatePairing(pairing.pairingId, exact),
      (error: unknown) => error instanceof DesktopAuthError && error.code === 'PAIRING_CANCELLED',
    );
    assert.equal(await service.validateToken(provisional.token), null);
  });

  test('reuses one provisional across a database restart and cleans it after fixed expiry', async () => {
    const expiring = new DesktopAuthService({
      database,
      now: () => new Date(now),
      provisionalTtlMs: 1_000,
      approvalBaseUrl: 'https://app.example.test',
    });
    const pairing = await startPairing(expiring, 'Restarted desktop');
    await expiring.approvePairing(pairing.pairingId, owner);
    const first = await expiring.pollPairing(pairing.pairingId, pairing.deviceSecret);
    const restarted = new DesktopAuthService({
      database,
      now: () => new Date(now),
      provisionalTtlMs: 1_000,
      approvalBaseUrl: 'https://app.example.test',
    });
    assert.deepEqual(await restarted.pollPairing(pairing.pairingId, pairing.deviceSecret), first);
    assert.equal(await database('instance_api_tokens').where({ activation_state: 'provisional' }).count({ count: '*' }).first()
      .then(row => Number(row?.count)), 1);
    now = new Date(now.getTime() + 1_001);
    await restarted.cleanupPairings();
    assert.equal(await database('instance_api_tokens').count({ count: '*' }).first().then(row => Number(row?.count)), 0);
  });

  test('expires unapproved pairings and cleans retained expired records', async () => {
    const expiringService = new DesktopAuthService({
      database,
      now: () => new Date(now),
      pairingTtlMs: 1_000,
      approvalBaseUrl: 'https://app.example.test',
    });
    const pairing = await startPairing(expiringService, 'Old laptop');
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
    await assert.rejects(startPairing(service, 'bad\nname'), /printable characters/);
    await assert.rejects(startPairing(service, 'x'.repeat(81)), /1 to 80/);
    const insecure = new DesktopAuthService({ database, approvalBaseUrl: 'http://remote.example.test' });
    await assert.rejects(startPairing(insecure, 'Laptop'), /requires HTTPS/);
  });

  test('matches the shared canonical origin parity table for the public REST and Socket origin', async () => {
    let index = 0;
    for (const [name, input, expected] of PROPR_API_ORIGIN_PARITY_CASES) {
      const candidate = new DesktopAuthService({
        database,
        approvalBaseUrl: 'https://app.example.test',
        publicApiUrl: input,
      });
      const start = startPairing(candidate, `Parity ${index++}`, expected ?? 'https://invalid.example.test');
      if (expected === null) await assert.rejects(start, undefined, name);
      else assert.equal(new URL((await start).approvalUrl).origin, expected, name);
    }
  });
});

describe('instance token ownership and revocation', () => {
  async function issueToken(): Promise<{ token: string; tokenId: string }> {
    const binding = pairingBinding();
    const pairing = await startPairing(service, 'Desktop app');
    await service.approvePairing(pairing.pairingId, owner);
    const completed = await service.pollPairing(pairing.pairingId, pairing.deviceSecret);
    assert.equal(completed.status, 'provisional');
    if (completed.status !== 'provisional') throw new Error('token was not issued');
    await service.activatePairing(pairing.pairingId, {
      ...binding,
      deviceSecret: pairing.deviceSecret,
      activationTicket: completed.activationTicket,
    });
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

  test('lets a desktop revoke only the instance token authenticating its request', async () => {
    const { token, tokenId } = await issueToken();
    const routes = createDesktopAuthRoutes({ service, frontendUrl: 'https://app.example.test' });
    let statusCode = 200;
    let ended = false;
    const response = {
      status(value: number) { statusCode = value; return response; },
      json() { return response; },
      end() { ended = true; return response; },
    } as unknown as Response;

    await routes.revokeCurrentToken({
      user: owner,
      authenticationMethod: 'instance_token',
      instanceTokenId: tokenId,
      header(name: string) {
        if (name.toLowerCase() === 'authorization') return `Bearer ${token}`;
        if (name.toLowerCase() === 'x-propr-desktop-revocation-binding') return 'A'.repeat(22);
        return undefined;
      },
    } as unknown as Request, response);

    assert.equal(statusCode, 204);
    assert.equal(ended, true);
    assert.equal(await service.validateToken(token), null);
  });

  test('returns the versioned endpoint-bound terminal contract on repeated self-revocation', async () => {
    const { token } = await issueToken();
    const routes = createDesktopAuthRoutes({ service, frontendUrl: 'https://app.example.test' });
    const binding = 'G'.repeat(22);
    const request = {
      header(name: string) {
        if (name.toLowerCase() === 'authorization') return `Bearer ${token}`;
        if (name.toLowerCase() === 'x-propr-desktop-revocation-binding') return binding;
        return undefined;
      },
    } as unknown as Request;
    const replies: Array<{ status: number; body?: unknown }> = [];
    const makeResponse = () => {
      const reply: { status: number; body?: unknown } = { status: 200 };
      replies.push(reply);
      const response = {
        status(value: number) { reply.status = value; return response; },
        json(value: unknown) { reply.body = value; return response; },
        end() { return response; },
      } as unknown as Response;
      return response;
    };

    await routes.revokeCurrentToken(request, makeResponse());
    await routes.revokeCurrentToken(request, makeResponse());
    assert.deepEqual(replies, [
      { status: 204 },
      {
        status: 401,
        body: {
          schema: 'propr.desktop-token-revocation',
          version: 1,
          endpoint: '/api/desktop/tokens/current',
          terminal: true,
          code: 'INSTANCE_TOKEN_REVOKED',
          credentialGeneration: binding,
        },
      },
    ]);
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
