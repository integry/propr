import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  automationExtensionsSchema, extensionLibraryInputSchema, resolveExtensionSet,
  type ExtensionLibraryServer, type ExtensionLibrarySkill, type ExtensionSkillBundle,
} from '../src/extensionLibrary.js';

const server = (name: string, extra: Partial<ExtensionLibraryServer> = {}): ExtensionLibraryServer => ({
  kind: 'https', name, url: `https://${name}.example.com/mcp`, enabled: true, tools: ['lookup'], capability: 'read', authentication: 'none',
  repositories: [], agents: [], autoApply: true, ...extra,
} as ExtensionLibraryServer);
const bundleId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bundle = (n: number, name: string): ExtensionSkillBundle => ({ id: bundleId(n), instanceId: bundleId(999), digest: 'a'.repeat(64), name, files: 1, bytes: 1, source: { kind: 'archive', filename: 'x.tar' }, requirements: [], createdAt: 0, auditActor: '1' });
const skill = (n: number, extra: Partial<ExtensionLibrarySkill> = {}): ExtensionLibrarySkill => ({ bundleId: bundleId(n), enabled: true, repositories: [], agents: [], autoApply: true, ...extra });
const library = (servers: ExtensionLibraryServer[], skills: ExtensionLibrarySkill[] = [], skillBundles: ExtensionSkillBundle[] = []) => ({ servers, skills, skillBundles, secrets: {} });
const context = { repository: 'team/repo', agentAlias: 'claude-main', runtime: 'claude' };
const names = (set: { servers: { name: string }[] }) => set.servers.map(s => s.name);

test('items without limits apply to every repository and agent', () => {
  const set = resolveExtensionSet(library([server('docs')], [skill(1)], [bundle(1, 'writing')]), context);
  assert.deepEqual(names(set), ['docs']);
  assert.deepEqual(set.skills.map(s => s.bundle.name), ['writing']);
  assert.deepEqual(set.skipped, []);
  assert.deepEqual(resolveExtensionSet(library([server('docs')]), { ...context, repository: 'other/repo', agentAlias: 'codex' }).servers.length, 1);
});

test('repository limit matches case-insensitively and requires every run repository', () => {
  const lib = library([server('docs', { repositories: ['Team/Repo'] })]);
  assert.deepEqual(names(resolveExtensionSet(lib, context)), ['docs']);
  assert.deepEqual(names(resolveExtensionSet(lib, { ...context, repository: 'other/repo' })), []);
  assert.deepEqual(names(resolveExtensionSet(lib, { ...context, repository: ['team/repo', 'other/repo'] })), []);
  assert.deepEqual(names(resolveExtensionSet(lib, { ...context, repository: [] })), []);
});

test('agent limit restricts the item to the listed aliases', () => {
  const lib = library([server('docs', { agents: ['claude-main'] })]);
  assert.deepEqual(names(resolveExtensionSet(lib, context)), ['docs']);
  assert.deepEqual(names(resolveExtensionSet(lib, { ...context, agentAlias: 'codex-main' })), []);
});

test('a disabled item applies to no run', () => {
  const lib = library([server('docs', { enabled: false })], [skill(1, { enabled: false })], [bundle(1, 'writing')]);
  const set = resolveExtensionSet(lib, context);
  assert.deepEqual(names(set), []); assert.deepEqual(set.skills, []); assert.deepEqual(set.skipped, []);
});

test('autoApply false items apply only when added explicitly', () => {
  const lib = library([server('docs', { autoApply: false }), server('search')], [skill(1, { autoApply: false })], [bundle(1, 'writing')]);
  assert.deepEqual(names(resolveExtensionSet(lib, context)), ['search']);
  const explicit = resolveExtensionSet(lib, { ...context, additional: { servers: ['docs'], skills: [bundleId(1)] } });
  assert.deepEqual(names(explicit), ['docs', 'search']);
  assert.deepEqual(explicit.skills.map(s => s.bundleId), [bundleId(1)]);
  assert.deepEqual(names(resolveExtensionSet(lib, { ...context, autoApply: false, additional: { servers: ['docs'] } })), ['docs']);
});

test('explicit entries that are missing, disabled or out of limits are skipped with a reason', () => {
  const lib = library([server('off', { enabled: false, autoApply: false }), server('scoped', { repositories: ['other/repo'], autoApply: false }), server('agent', { agents: ['codex'], autoApply: false })], [skill(1, { enabled: false })], [bundle(1, 'writing')]);
  const set = resolveExtensionSet(lib, { ...context, additional: { servers: ['missing', 'off', 'scoped', 'agent'], skills: [bundleId(1), bundleId(2)] } });
  assert.deepEqual(names(set), []);
  assert.deepEqual(set.skipped.map(s => [s.kind, s.name, s.reason, s.source]), [
    ['server', 'agent', 'agent', 'additional'], ['server', 'missing', 'not_found', 'additional'], ['server', 'off', 'disabled', 'additional'], ['server', 'scoped', 'repository', 'additional'],
    ['skill', bundleId(1), 'disabled', 'additional'], ['skill', bundleId(2), 'not_found', 'additional'],
  ]);
  assert.equal(set.skipped.find(s => s.name === bundleId(1))?.label, 'writing');
  assert.equal(resolveExtensionSet(library([server('docs')]), { ...context, runtime: 'opencode', additional: { servers: ['docs'] } }).skipped[0].reason, 'runtime');
});

test('write servers are left out without the run write authorization', () => {
  const lib = library([server('writer', { capability: 'write' }), server('docs')]);
  assert.deepEqual(names(resolveExtensionSet(lib, { ...context, allowWrite: false })), ['docs']);
  assert.deepEqual(names(resolveExtensionSet(lib, { ...context, allowWrite: true })), ['docs', 'writer']);
  assert.equal(resolveExtensionSet(lib, { ...context, allowWrite: false, additional: { servers: ['writer'] } }).skipped[0].reason, 'write_not_authorized');
});

test('a bearer server without a configured credential is skipped, not launched', () => {
  const lib = { ...library([server('docs', { authentication: 'bearer' } as Partial<ExtensionLibraryServer>)]), secrets: { docs: { fields: ['bearerToken'] as ['bearerToken'], configured: false } } };
  const set = resolveExtensionSet(lib, context);
  assert.deepEqual(names(set), []);
  assert.deepEqual(set.skipped, [{ kind: 'server', name: 'docs', reason: 'secret_not_configured', source: 'auto' }]);
});

test('over-limit sets keep explicit items first, then auto items by name, and report the rest', () => {
  const servers = Array.from({ length: 12 }, (_, i) => server(`s${String(i).padStart(2, '0')}`, { autoApply: i < 10 }));
  const skills = Array.from({ length: 10 }, (_, i) => skill(i + 1));
  const bundles = skills.map((s, i) => bundle(i + 1, `skill-${String(9 - i)}`));
  const set = resolveExtensionSet(library(servers, skills, bundles), { ...context, additional: { servers: ['s11', 's10'], skills: [bundleId(1)] } });
  assert.deepEqual(names(set), ['s00', 's01', 's02', 's03', 's04', 's05', 's10', 's11']);
  assert.deepEqual(set.omitted.filter(o => o.kind === 'server').map(o => [o.name, o.source]), [['s06', 'auto'], ['s07', 'auto'], ['s08', 'auto'], ['s09', 'auto']]);
  assert.equal(set.skills.length, 8);
  assert.ok(set.skills.some(s => s.bundleId === bundleId(1)), 'explicit skill kept even though it sorts last');
  assert.deepEqual(set.skills.map(s => s.bundle.name), [...set.skills.map(s => s.bundle.name)].sort());
  assert.deepEqual(set.omitted.filter(o => o.kind === 'skill').map(o => o.label), ['skill-7', 'skill-8']);
  assert.deepEqual(names(resolveExtensionSet(library(servers), { ...context, limits: { servers: 2 } })), ['s00', 's01']);
});

test('resolution order is deterministic regardless of library or request order', () => {
  const a = resolveExtensionSet(library([server('zeta'), server('alpha'), server('mid', { autoApply: false })]), { ...context, additional: { servers: ['mid'] } });
  const b = resolveExtensionSet(library([server('mid', { autoApply: false }), server('alpha'), server('zeta')]), { ...context, additional: { servers: ['mid', 'mid'] } });
  assert.deepEqual(names(a), ['alpha', 'mid', 'zeta']);
  assert.deepEqual(a, b);
});

test('library and automation schemas bound sizes, reject duplicates and default new items to autoApply', () => {
  const parsed = extensionLibraryInputSchema.parse({ version: 1, servers: [{ kind: 'https', name: 'docs', url: 'https://docs.example.com/mcp', enabled: true, tools: [], capability: 'read', authentication: 'none' }], skills: [] });
  assert.equal(parsed.servers[0].autoApply, true); assert.deepEqual(parsed.servers[0].repositories, []);
  assert.equal(extensionLibraryInputSchema.safeParse({ version: 1, servers: [server('a'), server('a')], skills: [] }).success, false);
  assert.equal(extensionLibraryInputSchema.safeParse({ version: 1, servers: Array.from({ length: 33 }, (_, i) => server(`s${i}`)), skills: [] }).success, false);
  assert.equal(extensionLibraryInputSchema.safeParse({ version: 1, servers: [{ ...server('a'), command: 'sh' }], skills: [] }).success, false);
  assert.equal(extensionLibraryInputSchema.safeParse({ version: 1, servers: Array.from({ length: 32 }, (_, i) => server(`s${i}`)), skills: [] }).success, true);
  assert.equal(automationExtensionsSchema.safeParse({ servers: ['docs', 'docs'], skills: [] }).success, false);
  assert.equal(automationExtensionsSchema.safeParse({ servers: ['docs'], skills: [bundleId(1)] }).success, true);
  assert.equal(automationExtensionsSchema.safeParse({ servers: ['docs'] }).success, false);
});
