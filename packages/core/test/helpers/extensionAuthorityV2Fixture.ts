import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import knex from 'knex';
import { canonicalFleetJson as canonical, EXTENSION_AUTHORITY_V2 as contract, EXTENSION_AUTHORITY_V2_PATH as route,
  FLEET_EXTENSION_CONTRACT, FLEET_EXTENSION_SCOPE, QUALIFIED_EXTENSION_PIN, EXTENSION_AUTHORITY_V2_SCHEMA } from '@propr/shared';
import { up as profiles } from '../../src/db/migrations/20261013210000_extension_profiles.js';
import { up as epoch } from '../../src/db/migrations/20261015070000_extension_authority_epoch.js';
import { up as dual } from '../../src/db/migrations/20261015130000_extension_authority_v2.js';
import { FleetExtensionPlane } from '../../src/fleet/extensions.js';
import { FleetDataPlane } from '../../src/fleet/dataPlane.js';
import { ExtensionProfileStore } from '../../src/extensions/extensionProfileStore.js';
import { ExtensionAuthorityV2Plane, extensionAuthorityV2Pin as contractPin } from '../../src/fleet/extensionAuthorityV2.js';
import { InstanceStorageService } from '../../src/storage/service.js';
import { StorageLifecycle } from '../../src/storage/lifecycle.js';
import { listenFleetData, refusePublicFleetData } from '../../../api/fleetDataListener.js';
import { verifyProof } from '../../../../docs/contracts/extension-authority-v2/verifier.mjs';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const digest = (v: unknown) => hash(canonical(v));
const secret = 'SENTINEL-V2-TRANSPORT-SECRET-NEVER-RETAIN';
export const input = { version: 1, name: 'SENTINEL-PROFILE-BODY', enabled: false, agentScope: [], repositoryScope: [], mcpServers: [], skillBundleIds: [] };
export const create = { action: 'profile.create', input, sealed: [] };
export async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-authority-'));
  const open = () => knex({ client: 'better-sqlite3', connection: { filename: path.join(root, 'db.sqlite') }, useNullAsDefault: true });
  let db = open();
  await db.schema.createTable('instance_members', tb => { tb.text('github_user_id').primary(); tb.text('role'); tb.text('source'); });
  await db.schema.createTable('config', tb => { tb.text('key').primary(); tb.text('value'); });
  await db.schema.createTable('agent_definitions', tb => { tb.text('id').primary(); });
  await profiles(db); await epoch(db); await dual(db);
  await db('instance_members').insert({ github_user_id: '100', role: 'admin', source: 'local' });
  const control = path.join(root, 'fleet'); await fs.mkdir(control, { mode: 0o700 });
  await fs.writeFile(path.join(control, 'authority.json'), canonical({ hostedInstanceId: 'synthetic', placementGeneration: 'placement-1', scope: 'hosted_customer_data', secretSha256: hash(secret) }), { mode: 0o600 });
  const core = generateKeyPairSync('ed25519'); const routingKey = generateKeyPairSync('ed25519');
  const spki = (k: typeof core) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  await fs.writeFile(path.join(control, 'native-authority-key.pem'), core.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const trust = { contract, keyId: 'routing', keyEpoch: '1', authorityEpoch: '1', publicKey: spki(routingKey), producerRevision: 'a'.repeat(64), producerEpoch: '1' };
  const writeTrust = (v: unknown) => fs.writeFile(path.join(control, 'routing-extension-authority-v2.json'), canonical(v), { mode: 0o600 });
  await writeTrust(trust);
  const storage = new InstanceStorageService({ lifecycle: new StorageLifecycle(path.join(root, 'storage')), clonesRoot: root, roots: [], hasPendingTasks: async () => false });
  await storage.initialize();
  const fleet = new FleetDataPlane(storage, control, () => secret, async (id, database = db) => {
    const row = await database('instance_members').where({ github_user_id: String(id) }).first();
    return { role: row?.role, source: row?.source, permissions: row?.role === 'admin' ? ['instance.manage_settings'] : [] };
  });
  await fleet.initialize();
  let extensions = new FleetExtensionPlane(fleet, new ExtensionProfileStore(db, { SYSTEM_TASK_SECRET: 'synthetic-v2-test-custody' }));
  let plane = new ExtensionAuthorityV2Plane(extensions);
  let listener = await listenFleetData(fleet, extensions);
  const send = (raw: string | Buffer, url = route) => new Promise<any>((resolve, reject) => {
    const req = httpRequest({ socketPath: listener.address()!, path: url, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let body = ''; res.on('data', b => { body += b; });
      res.on('end', () => {
        const wire = JSON.parse(body);
        // Existing receipt tests keep their original assertions. Delivery tests
        // inspect the exact unmodified wire bytes and outer envelope separately.
        resolve({ status: res.statusCode, deliveryRaw: body, wire,
          raw: wire.receipt ? canonical(wire.receipt) : body, body: wire.receipt ?? wire });
      });
    }); req.on('error', reject); req.end(raw);
  });
  const runtime = await fleet.runtime();
  const work = (native: any = create) => ({
    extension: { contract: FLEET_EXTENSION_CONTRACT, contractPin: QUALIFIED_EXTENSION_PIN, scope: FLEET_EXTENSION_SCOPE,
      hostedInstanceId: runtime.hostedInstanceId, storageInstanceId: runtime.storageInstanceId, runtimeGeneration: runtime.runtimeGeneration,
      storageGeneration: runtime.storageGeneration, placementGeneration: runtime.placementGeneration, githubActorId: 100,
      action: native.action, requestDigest: digest(native), operationId: randomUUID(), nonce: randomBytes(32).toString('hex'), issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 30 },
    extensionInstanceId: '', workDigest: hash('original'), acquisitionOperationId: null, coreAuthorityEpoch: '2',
    scope: { accountId: 'account', installationId: 'installation', tenantId: 'tenant', targetId: 'target', actorEpoch: '1', membershipEpoch: '1', securityEpoch: '1', passkeyEpoch: '1', accountEpoch: '1', installationEpoch: '1', tenantEpoch: '1', targetEpoch: '1', placementEpoch: '1', runtimeEpoch: '1', storageEpoch: '1', extensionEpoch: '1' },
  });
  const newWork = async (native: any = create) => ({ ...work(native), extensionInstanceId: await extensions.store.instanceId() });
  const request = (work: any, phase = 'request') => ({ contract, contractPin, work, phase, challenge: randomBytes(32).toString('hex'), issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 30 });
  const authorization = (r: any, changes: any = {}, signingKey = routingKey.privateKey) => {
    const { publicKey, contract: _, ...fields } = trust;
    const statement = { contract: 'propr.routing-extension-authorization.v2', request: r, decision: 'allow', ...fields, checkedAt: r.issuedAt, expiresAt: r.expiresAt, ...changes };
    return { statement, signature: sign(null, Buffer.from(canonical(statement)), signingKey).toString('base64url') };
  };
  const envelope = (r: any, native?: any, routing = authorization(r)) => ({ request: r, routing, mac: createHmac('sha256', secret).update(canonical({ request: r, routing })).digest('hex'), ...(native ? { native } : {}) });
  const invoke = async (r: any, native?: any) => {
    const e = envelope(r, native); const response = await send(canonical(e));
    assert.equal(response.status, 200, response.raw);
    verifyProof(response.raw, r, e.routing, trust, spki(core), Date.now(), new Set());
    return response.body;
  };
  t.after(async () => { await listener.shutdown(); plane.shutdown(); extensions.shutdown(); await db.destroy(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, control, trust, writeTrust, routingKey, core, spki, fleet, storage, send, request, newWork, envelope, authorization, invoke,
    get db() { return db; }, get extensions() { return extensions; }, get plane() { return plane; },
    restart: async () => { await listener.shutdown(); plane.shutdown(); await db.destroy(); db = open(); extensions = new FleetExtensionPlane(fleet, new ExtensionProfileStore(db, { SYSTEM_TASK_SECRET: 'synthetic-v2-test-custody' })); plane = new ExtensionAuthorityV2Plane(extensions); listener = await listenFleetData(fleet, extensions); } };
}
