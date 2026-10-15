import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import knex from 'knex';
import { verifyProof } from '../../../docs/contracts/extension-authority-v2/verifier.mjs';
test('SIGKILL at every dispatch boundary: SQLite recovers mutation and receipt together', async t => {
  const transcript: string[] = [];
  const { spawn } = await import('node:child_process');
  for (const action of ['profile.create', 'profile.update', 'profile.delete', 'profile.disable', 'skill.import']) for (const fault of (action === 'profile.create' ? ['intent-before', 'intent-after', 'nonce-before', 'nonce-after', 'native-intent-before', 'native-intent-after', 'mutation-before', 'mutation-after', 'decision-before', 'decision-after', 'result-before', 'result-after', 'reply-before', 'reply-after'] : ['mutation-after', 'result-before', 'result-after', 'reply-before'])) await t.test(`${action}/${fault}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-crash-parent-'));
    const metadata = path.join(dir, 'metadata.json');
    let root: string | undefined;
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', 'packages/core/test/helpers/extensionAuthorityV2Crash.ts', fault, metadata, action], { stdio: ['ignore', 'ignore', 'pipe'] });
        let error = ''; child.stderr.on('data', data => { error += data; }); child.on('error', reject);
        child.on('exit', (code, signal) => signal === 'SIGKILL' ? resolve({ code, signal }) : reject(Error(error || `Unexpected exit ${code}`)));
      });
      assert.equal(exit.signal, 'SIGKILL');
      const m = JSON.parse(await fs.readFile(metadata, 'utf8')); root = m.root;
      const db = knex({ client: 'better-sqlite3', connection: { filename: path.join(root!, 'db.sqlite') }, useNullAsDefault: true });
      try {
        const committed = fault === 'result-after' || fault.startsWith('reply');
        const profiles = await db('extension_profiles'), revisions = await db('extension_profile_revisions'), bundles = await db('extension_skill_bundles');
        if (!committed) assert.deepEqual({ profiles, revisions, bundles }, m.before);
        else if (action === 'skill.import') {
          assert.deepEqual(profiles, m.before.profiles); assert.deepEqual(revisions, m.before.revisions);
          assert.equal(bundles.length, 1);
          const bundle = JSON.parse(bundles[0].descriptor);
          assert.equal(bundle.name, 'atomic-skill');
          assert.deepEqual(bundle.source, { kind: 'github', repository: 'synthetic/skills', commit: 'a'.repeat(40), directory: 'skills/demo' });
          assert.equal(JSON.parse(bundles[0].files_json).length, 1);
        } else {
          assert.equal(profiles.length, 1); assert.deepEqual(bundles, []);
          assert.equal(revisions.length, ['profile.update', 'profile.disable'].includes(action) ? 2 : 1);
          assert.equal(profiles[0].revision, revisions.length);
          assert.equal(Boolean(profiles[0].deleted), action === 'profile.delete');
          assert.equal(Boolean(profiles[0].enabled), false);
          if (action === 'profile.update') assert.equal(JSON.parse(revisions.find(row => row.revision === 2).snapshot).name, 'UPDATED-PROFILE');
          if (action === 'profile.delete') {
            assert.deepEqual(revisions, m.before.revisions);
            assert.equal(profiles[0].deleted_by, '100'); assert.ok(profiles[0].deleted_at);
          }
        }
        const receipt = await db('extension_authority_v2_receipts').where({ challenge: m.r.challenge }).first();
        assert.equal(Boolean(receipt), committed);
        assert.equal(Boolean(await db('extension_authority_v2_intents').where({ challenge: m.r.challenge }).first()), fault !== 'intent-before');
        if (receipt) verifyProof(receipt.response, m.r, m.envelope.routing, m.trust, m.coreSPKI, Date.now(), new Set());
        assert.deepEqual(await db.raw('PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
        if (action === 'profile.create') transcript.push(`SIGKILL/${fault}: intent=${Number(fault !== 'intent-before')} mutation=${Number(committed)} receipt=${Number(committed)} integrity=ok\n`);
      } finally { await db.destroy(); }
    } finally { if (root) await fs.rm(root, { recursive: true, force: true }); await fs.rm(dir, { recursive: true, force: true }); }
  });
  assert.equal(transcript.join(''), await fs.readFile('docs/contracts/extension-authority-v2/crash-transcript.txt', 'utf8'));
});
