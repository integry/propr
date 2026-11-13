import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionLibraryInput, ExtensionLibraryServerInput } from '@propr/shared';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { ExtensionLibraryStore } from '../src/extensions/extensionProfileStore.js';
import { executeWithExtensions, currentExtensionLaunch, type ExtensionLaunchHooks } from '../src/extensions/extensionLaunch.js';
import { taskRunExtensionRequest } from '../src/extensions/extensionRunResolution.js';
import { codexAutoApplyConflict, codexConfigDefinesProviderOrProfile } from '../src/agents/impl/utils/codexExtensionConflict.js';
import type { AgentConfig, AgentExtensionRequest, AgentTaskOptions } from '../src/agents/types.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';

const secret = 'UNMISTAKABLE_AUTO_APPLY_SENTINEL_DO_NOT_DISCLOSE';
const server = (extra: Partial<ExtensionLibraryServerInput> = {}): ExtensionLibraryServerInput => ({ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'none', repositories: [], agents: [], autoApply: true, ...extra } as ExtensionLibraryServerInput);
const skillFiles = () => [{ path: 'SKILL.md', content: Buffer.from('---\nname: release-notes\ndescription: Writes release notes\n---\nWrite them.').toString('base64') }];
const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
const claude = { type: 'claude', alias: 'claude-main', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: '/unused', supportedModels: ['synthetic'] } as AgentConfig;

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-auto-apply-'));
  const previous = process.env.PROPR_EGRESS_SOCKET_DIR; process.env.PROPR_EGRESS_SOCKET_DIR = root;
  extensionTestResources(t).defer(async () => { if (previous === undefined) delete process.env.PROPR_EGRESS_SOCKET_DIR; else process.env.PROPR_EGRESS_SOCKET_DIR = previous; await fs.rm(root, { recursive: true, force: true }); });
  extensionTestResources(t).defer(async () => { await (await import('../src/db/connection.js')).closeConnection(); });
  const database = extensionTestResources(t).database();
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await database.schema.createTable('tasks', c => c.string('task_id').primary());
  await database.schema.createTable('task_history', c => { c.string('task_id'); c.string('state'); c.string('timestamp'); c.text('reason'); c.text('metadata'); });
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await up(database); await grantMigration(database); await libraryMigration(database);
  const store = new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'synthetic-auto-apply-custody' });
  const bundle = await store.importSkill('1', skillFiles(), { kind: 'archive', filename: 'skill.tar' });
  const save = async (library: Omit<ExtensionLibraryInput, 'version'>, secrets: Record<string, string | null> = {}) => store.saveLibrary('1', { version: 1, ...library }, secrets, (await store.readLibrary('1')).revision);
  /** Launch one run and report what its container would receive and what its task event records. */
  // eslint-disable-next-line max-params -- test helper mirrors the launch inputs
  const run = async (extensions: AgentExtensionRequest, config: AgentConfig = claude, hooks: ExtensionLaunchHooks = {}, between?: () => Promise<void>) => {
    const taskId = randomUUID();
    await database('tasks').insert({ task_id: taskId });
    let launched: { servers: string[]; skills: boolean; extensions: boolean } | undefined;
    const options: AgentTaskOptions = { extensions, taskId, issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: root, prompt: 'Run', githubToken: '' };
    await executeWithExtensions(config, options, async prepared => {
      await between?.();
      if (currentExtensionLaunch()) await currentExtensionLaunch()!.beforeLaunch();
      launched = { servers: prepared.toolPolicy?.mcpServers?.map(s => s.name) ?? [], skills: prepared.prompt.includes('/opt/propr/extensions'), extensions: !!prepared.extensions };
      return result;
    }, store, hooks);
    const history = await database('task_history').where({ task_id: taskId });
    return { launched: launched!, event: history.map(h => JSON.parse(h.metadata)).find(m => m.event === 'extensions.resolved'), history };
  };
  return { database, store, bundle, save, run, root };
}
const issueTask = (labels: string[] = [], extra: { allowWrite?: boolean; repository?: string } = {}) => taskRunExtensionRequest({ kind: 'issue', repository: extra.repository ?? 'team/repo', labels: labels.map(name => ({ name })), allowWrite: extra.allowWrite });
const followUp = (labels: string[] = []) => taskRunExtensionRequest({ kind: 'pull_request', repository: 'team/repo', labels });

test('a label-started issue task launches with matching read servers and skills; other repositories and agents get none', async t => {
  const { save, run, bundle } = await fixture(t);
  await save({ servers: [server(), server({ name: 'scoped', repositories: ['Team/Repo'], agents: ['claude-main'] }), server({ name: 'manual', autoApply: false }), server({ name: 'off', enabled: false }), server({ name: 'write', capability: 'write' })], skills: [{ bundleId: bundle.id, enabled: true, repositories: ['team/repo'], agents: [], autoApply: true }] });
  const matched = await run(issueTask());
  assert.deepEqual(matched.launched, { servers: ['docs', 'scoped'], skills: true, extensions: true });
  assert.deepEqual(matched.event.autoApplied, { servers: ['docs', 'scoped'], skills: ['release-notes'] });
  assert.deepEqual(matched.event.added, { servers: [], skills: [] });
  assert.deepEqual(matched.event.provenance, { source: 'auto', auditActor: '1' });
  assert.equal(matched.event.runKind, 'issue');
  const otherRepository = await run(issueTask([], { repository: 'other/repo' }));
  assert.deepEqual(otherRepository.launched, { servers: ['docs'], skills: false, extensions: true });
  const otherAgent = await run(issueTask(), { ...claude, alias: 'claude-other' });
  assert.deepEqual(otherAgent.launched.servers, ['docs']);
  await save({ servers: [server({ repositories: ['other/repo'] })], skills: [] });
  const none = await run(issueTask());
  assert.deepEqual(none.launched, { servers: [], skills: false, extensions: false });
  assert.deepEqual(none.event.servers, []);
});

test('disabled items do not apply, and re-enabling applies them to the next launched run', async t => {
  const { store, save, run } = await fixture(t);
  await save({ servers: [server()], skills: [] });
  await store.setItemEnabled('1', { kind: 'server', name: 'docs' }, false);
  assert.deepEqual((await run(issueTask())).launched.servers, []);
  await store.setItemEnabled('1', { kind: 'server', name: 'docs' }, true);
  assert.deepEqual((await run(followUp())).launched.servers, ['docs']);
});

test('each opt-out label removes exactly its class for issue tasks and follow-ups, never for automations', async t => {
  const { save, run, bundle } = await fixture(t);
  await save({ servers: [server()], skills: [{ bundleId: bundle.id, enabled: true, repositories: [], agents: [], autoApply: true }] });
  for (const request of [issueTask, followUp]) {
    assert.deepEqual((await run(request(['disable-mcps']))).launched, { servers: [], skills: true, extensions: true });
    assert.deepEqual((await run(request(['DISABLE-SKILLS']))).launched, { servers: ['docs'], skills: false, extensions: true });
    const neither = await run(request(['bug', 'disable-extensions']));
    assert.deepEqual(neither.launched, { servers: [], skills: false, extensions: false });
    assert.deepEqual(neither.event.labelOptOut, { labels: ['disable-extensions'], removed: { servers: ['docs'], skills: ['release-notes'] } });
  }
  // Automations ignore the labels; labels never add an item.
  assert.deepEqual((await run({ autoApply: true, servers: [], skills: [], labels: ['disable-extensions'] })).launched.servers, ['docs']);
  await save({ servers: [server({ autoApply: false })], skills: [] });
  assert.deepEqual((await run(issueTask(['disable-skills']))).launched.servers, []);
});

test('a write server reaches only a run with explicit write authorization, never label-started tasks or follow-ups', async t => {
  const { save, run } = await fixture(t);
  await save({ servers: [server(), server({ name: 'tracker', capability: 'write' })], skills: [] });
  assert.deepEqual((await run(issueTask([], { allowWrite: true }))).launched.servers, ['docs', 'tracker']);
  assert.deepEqual((await run(issueTask())).launched.servers, ['docs']);
  assert.deepEqual((await run(followUp())).launched.servers, ['docs']);
  // A legacy submission's explicit items keep their own write choice and gain the run kind and labels.
  const legacy = taskRunExtensionRequest({ kind: 'issue', repository: 'team/repo', labels: ['disable-mcps'], base: { autoApply: false, servers: ['tracker'], skills: [], repositories: ['team/repo'], allowWrite: false } });
  assert.deepEqual(legacy, { autoApply: false, servers: ['tracker'], skills: [], repositories: ['team/repo'], allowWrite: false, kind: 'issue', labels: ['disable-mcps'] });
});

test('library edits between queue and launch use the new revision; pending disable, removal and rotation still refuse', async t => {
  const { store, save, run } = await fixture(t);
  await save({ servers: [server()], skills: [] });
  const queued = issueTask();
  await save({ servers: [server(), server({ name: 'added' })], skills: [] });
  const launched = await run(queued);
  assert.deepEqual(launched.launched.servers, ['added', 'docs']);
  assert.equal(launched.event.libraryRevision, (await store.readLibrary('1')).revision);
  for (const operation of ['disable', 'remove', 'rotate'] as const) {
    await save({ servers: [server({ authentication: 'bearer' })], skills: [] }, { docs: secret });
    const between = async () => {
      if (operation === 'disable') await store.setItemEnabled('1', { kind: 'server', name: 'docs' }, false);
      if (operation === 'remove') await save({ servers: [], skills: [] });
      if (operation === 'rotate') await store.replaceSecret('1', 'docs', `${secret}_ROTATED`);
    };
    await assert.rejects(run(issueTask(), claude, {}, between), /changed/, operation);
  }
});

test('the applied-extensions event names items and reasons but never secrets or endpoints', async t => {
  const { save, run, database } = await fixture(t);
  await save({ servers: [server({ authentication: 'bearer' }), server({ name: 'missing-secret', authentication: 'bearer' })], skills: [] }, { docs: secret });
  const { event } = await run({ ...issueTask(), servers: ['absent'] });
  assert.deepEqual(event.servers, ['docs']);
  assert.deepEqual(event.skipped.map((s: { name: string; reason: string; source: string }) => [s.name, s.reason, s.source]), [['absent', 'not_found', 'additional'], ['missing-secret', 'secret_not_configured', 'auto']]);
  for (const field of ['libraryRevision', 'provenance', 'autoApplied', 'added', 'omitted', 'runKind']) assert.ok(field in event, field);
  const recorded = JSON.stringify(await database('task_history'));
  assert.doesNotMatch(recorded, new RegExp(`${secret}|8\\.8\\.8\\.8|https://`));
  const grant = JSON.stringify(await database('extension_run_grants'));
  assert.doesNotMatch(grant, new RegExp(secret));
});

test('goal runs and runs without a task launch without auto-applied items', async t => {
  const { save, store, database } = await fixture(t);
  await save({ servers: [server()], skills: [] });
  for (const options of [{ executionMode: 'goal' as const, taskId: 'goal' }, { taskId: undefined }]) {
    let extensions: unknown = 'unset';
    await executeWithExtensions(claude, { extensions: issueTask(), issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: '/unused', prompt: 'Run', githubToken: '', ...options }, async prepared => { extensions = prepared.extensions; assert.equal(currentExtensionLaunch(), undefined); return result; }, store);
    assert.equal(extensions, null);
  }
  assert.equal((await database('extension_run_grants')).length, 0);
});

test('an unreadable library does not break auto-applied task runs; automations still refuse', async t => {
  const { save, run, database } = await fixture(t);
  await save({ servers: [server()], skills: [] });
  await database('extension_library_revisions').update({ snapshot: '{"version":1,"instanceId":"substituted","revision":1}' });
  assert.deepEqual((await run(issueTask())).launched, { servers: [], skills: false, extensions: false });
  await assert.rejects(run({ autoApply: true, servers: [], skills: [] }), /identity mismatch/);
  await assert.rejects(run({ ...issueTask(), servers: ['docs'] }), /identity mismatch/);
});

test('Codex skip conditions launch without auto-applied items and record why; explicit items keep strict behaviour', async t => {
  const { save, run, root } = await fixture(t);
  await save({ servers: [server(), server({ name: 'added', autoApply: false })], skills: [] });
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-codex-home-'));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const codex = { ...claude, type: 'codex', alias: 'codex', configPath: codexHome } as AgentConfig;
  const hooks: ExtensionLaunchHooks = { autoApplyConflict: options => codexAutoApplyConflict(codexHome, options.worktreePath) };
  // A plain operator configuration keeps auto-applied items.
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n[mcp_servers.local]\ncommand = "x"\n');
  assert.deepEqual((await run(issueTask(), codex, hooks)).launched.servers, ['docs']);
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "azure"\n[model_providers.azure]\nbase_url = "https://example.invalid"\n');
  const skipped = await run(issueTask(), codex, hooks);
  assert.deepEqual(skipped.launched, { servers: [], skills: false, extensions: false });
  assert.equal(skipped.event.autoApplySkipped.reason, 'codex_operator_config');
  assert.match(skipped.history.find(h => JSON.parse(h.metadata).event === 'extensions.resolved')!.reason, /Codex/);
  // An automation's explicitly added items still launch; only its auto-applied ones are left out.
  const automation = await run({ autoApply: true, servers: ['added'], skills: [] }, codex, hooks);
  assert.deepEqual(automation.launched.servers, ['added']);
  assert.deepEqual(automation.event.added.servers, ['added']);
  assert.equal(automation.event.autoApplySkipped.reason, 'codex_operator_config');
  await fs.writeFile(path.join(codexHome, 'config.toml'), '');
  await fs.mkdir(path.join(root, '.codex'), { recursive: true }); await fs.writeFile(path.join(root, '.codex', 'config.toml'), '');
  assert.equal((await run(followUp(), codex, hooks)).event.autoApplySkipped.reason, 'codex_workspace_config');
});

test('Codex operator configuration detection reads provider and profile definitions only', () => {
  for (const toml of ['model_provider = "azure"', '[model_providers.azure]\nname = "Azure"', 'profile = "work"', '[profiles.work]\nmodel = "o3"', '[profiles]\nwork = {}', 'model_provider = \'custom\' # comment'])
    assert.equal(codexConfigDefinesProviderOrProfile(toml), true, toml);
  for (const toml of ['', 'model_provider = "openai"', '# profile = "work"', 'model = "gpt-5"\n[mcp_servers.docs]\nurl = "https://example.invalid"', '[tui]\nprofile_hint = true'])
    assert.equal(codexConfigDefinesProviderOrProfile(toml), false, toml);
});
