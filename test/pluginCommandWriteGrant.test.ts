import { test } from 'node:test';
import assert from 'node:assert';
import { taskRunExtensionRequest } from '@propr/shared';
import { pluginCommandRunExtensionBase } from '../src/jobs/pluginCommandTask.js';

/**
 * The run side of a `needsWrite` plugin command's write authorization: the
 * run consumes its single-use grant as it starts, and only a grant still
 * unused authorizes it, for exactly the plugin's write servers it covers.
 */
const run = {
  pluginId: 'fixture-deploy-one', pluginName: 'Deploy one', command: 'deploy-one-release', kind: 'prompt' as const,
  instruction: 'Cut a release.', extensions: { servers: ['deploy-one-api', 'deploy-one-docs'], skills: [] },
  writeGrant: { id: '6f1c9a52-7d8e-4b4a-9a43-3f0a6c2b1d10', repository: 'owner/app', number: 42, servers: ['deploy-one-api'] },
};
const quiet = { info: () => {}, warn: () => {} };

/** A grant store like the database's: each id is handed out once. */
function grants() {
  const used = new Set<string>();
  const consumers: string[] = [];
  return {
    consumers,
    consume: async (command: typeof run, taskId: string) => {
      consumers.push(taskId);
      if (used.has(command.writeGrant.id)) return null;
      used.add(command.writeGrant.id);
      return command.writeGrant.servers;
    },
  };
}

test('the first run gets the write grant for the plugin\'s write server only; a retry and a later follow-up get read access', async () => {
  const store = grants();
  const first = await pluginCommandRunExtensionBase(run, undefined, 'task-1', { consume: store.consume, logger: quiet });
  assert.deepStrictEqual(first, { autoApply: true, servers: ['deploy-one-api', 'deploy-one-docs'], skills: [], allowWrite: true, writeServers: ['deploy-one-api'] });
  // Through the request builder the restriction stays with the write authorization.
  const request = taskRunExtensionRequest({ kind: 'pull_request', repository: 'owner/app', base: first });
  assert.strictEqual(request.allowWrite, true);
  assert.deepStrictEqual(request.writeServers, ['deploy-one-api']);

  const retry = await pluginCommandRunExtensionBase(run, undefined, 'task-1-retry', { consume: store.consume, logger: quiet });
  assert.deepStrictEqual(retry, { autoApply: true, servers: ['deploy-one-api', 'deploy-one-docs'], skills: [] });
  assert.strictEqual(taskRunExtensionRequest({ kind: 'pull_request', repository: 'owner/app', base: retry }).allowWrite, false);
  // A later follow-up carries no plugin command at all.
  assert.strictEqual(await pluginCommandRunExtensionBase(undefined, undefined, 'later', { consume: store.consume, logger: quiet }), undefined);
  assert.deepStrictEqual(store.consumers, ['task-1', 'task-1-retry']);
});

test('a command without a write grant never consults the grants, and an unreadable grant means read access', async () => {
  const store = grants();
  const { writeGrant: _unused, ...readOnly } = run;
  assert.deepStrictEqual(await pluginCommandRunExtensionBase(readOnly, undefined, 't', { consume: store.consume, logger: quiet }), { autoApply: true, servers: readOnly.extensions.servers, skills: [] });
  assert.deepStrictEqual(store.consumers, []);
  const failing = await pluginCommandRunExtensionBase(run, undefined, 't', { consume: async () => { throw new Error('database down'); }, logger: quiet });
  assert.strictEqual(failing?.allowWrite, undefined);
});

test('a base already authorized for every write server keeps that authorization', async () => {
  const store = grants();
  const base = { autoApply: true, servers: [], skills: [], allowWrite: true };
  assert.deepStrictEqual(await pluginCommandRunExtensionBase(run, base, 't', { consume: store.consume, logger: quiet }), { ...base, servers: run.extensions.servers });
});
