// Real process death, never a simulated exception or graceful database close.
import fs from 'node:fs/promises';
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalFleetJson as canonical } from '@propr/shared';
import { fixture, create } from './extensionAuthorityV2Fixture.js';
const [fault, metadata, action = 'profile.create'] = process.argv.slice(2);
if (action === 'skill.import') {
  const skill = Buffer.from('---\nname: atomic-skill\ndescription: Atomic import regression\n---\nSynthetic declaration.');
  const sha = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${skill.length}\0`), skill])).digest('hex');
  // Replace only GitHub I/O; retain exact blob validation and the real store path.
  mock.module('../../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({ request: async (route: string) => {
    if (route.includes('/git/commits/')) return { data: { sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) } } };
    if (route.includes('/git/trees/')) return { data: { truncated: false, tree: [{ path: 'skills/demo/SKILL.md', type: 'blob', mode: '100644', sha, size: skill.length }] } };
    return { data: { encoding: 'base64', content: skill.toString('base64') } };
  } }) } });
}
const f = await fixture({ after() {} });
let native: any = create;
if (['profile.update', 'profile.delete', 'profile.disable'].includes(action)) {
  const profile = await f.extensions.store.save('100', { ...create.input, version: 1, enabled: true });
  const selection = { instanceId: profile.instanceId, profileId: profile.profileId, revision: profile.revision };
  native = action === 'profile.update' ? { action, selection, input: { ...create.input, name: 'UPDATED-PROFILE' }, sealed: [] } : { action, selection };
} else if (action === 'skill.import') native = { action, repository: 'synthetic/skills', commit: 'a'.repeat(40), directory: 'skills/demo' };
const before = { profiles: await f.db('extension_profiles'), revisions: await f.db('extension_profile_revisions'), bundles: await f.db('extension_skill_bundles') };
const work = await f.newWork(native);
await f.invoke(f.request(work));
const r = f.request(work, 'dispatch'), envelope = f.envelope(r, native);
await fs.writeFile(metadata, JSON.stringify({ root: f.root, before, r, envelope, trust: f.trust, coreSPKI: f.spki(f.core) }));
const die = (): never => { process.kill(process.pid, 'SIGKILL'); throw Error('unreachable'); };
const conn = await f.db.client.acquireConnection(); await f.db.client.releaseConnection(conn);
const exec = conn.exec.bind(conn); let commits = 0;
conn.exec = (sql: string) => {
  const boundary = fault.startsWith('intent') ? 1 : fault.startsWith('result') ? 2 : 0;
  if (sql === 'COMMIT' && ++commits === boundary) { if (fault.endsWith('after')) exec(sql); die(); }
  return exec(sql);
};
const createFile = f.fleet.files.create.bind(f.fleet.files);
f.fleet.files.create = async (name, value) => {
  const prefix = name.startsWith('extension-nonce-') ? 'nonce' : 'native-intent';
  if (fault === `${prefix}-before`) die();
  await createFile(name, value);
  if (fault === `${prefix}-after`) die();
};
const prepare = conn.prepare.bind(conn);
conn.prepare = (sql: string) => {
  const statement = prepare(sql);
  if (sql.startsWith('INSERT INTO extension_authority_v2_receipts')) {
    const run = statement.run.bind(statement);
    statement.run = (...args: unknown[]) => {
      if (fault === 'decision-before') die();
      const result = run(...args);
      if (fault === 'decision-after') die();
      return result;
    };
  }
  return statement;
};
const dispatch = f.extensions.dispatchAtomic.bind(f.extensions);
f.extensions.dispatchAtomic = async (...args) => {
  if (fault === 'mutation-before') die();
  const result = await dispatch(...args);
  if (fault === 'mutation-after') die();
  return result;
};
await f.plane.invoke(canonical(envelope), response => {
  if (fault === 'reply-before') die();
  // A serialized reply may have left Core without reaching Fleet.
  canonical(response);
  if (fault === 'reply-after') die();
});
throw Error('Fault boundary was not reached');
