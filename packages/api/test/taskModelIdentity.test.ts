import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskModelIdentity } from '../routes/taskModelIdentity.js';

const followup = { task_id: 'followup', task_type: 'pr-comment', model_name: 'claude-opus-5-5', initial_job_data: JSON.stringify({ pullRequestNumber: 7 }) };

test('an unresolved PR follow-up never borrows the configured default', () => {
  assert.deepEqual(taskModelIdentity(followup, []), { modelName: null, agentAlias: null });
});
test('saved execution evidence repairs historical follow-ups without a queued model override', () => {
  assert.deepEqual(taskModelIdentity(followup, [], [{ model_name: 'gpt-6-astra' }]), { modelName: 'gpt-6-astra', agentAlias: null });
});
test('resolved implementation and review routing outrank stale task and job identities', () => {
  for (const commandMode of [undefined, 'review']) {
    const task = { ...followup, initial_job_data: { modelName: 'claude-opus-5-5', agentAlias: 'claude', commandMode } };
    assert.deepEqual(taskModelIdentity(task, [{ metadata: JSON.stringify({ model: 'gpt-6-astra', executionRouting: { model: 'gpt-6-astra', agentAlias: 'codex' } }) }]), { modelName: 'gpt-6-astra', agentAlias: 'codex' });
  }
});
test('session history uses the latest recorded model without retaining the wrong provider', () => {
  assert.deepEqual(taskModelIdentity(followup, [{ metadata: { model: 'claude-opus-5-5' } }, { metadata: { model: 'gpt-6-astra' } }]), { modelName: 'gpt-6-astra', agentAlias: null });
});
test('explicit selections and virtual synthetic identity remain available', () => {
  assert.deepEqual(taskModelIdentity({ ...followup, initial_job_data: { modelName: 'gpt-6-astra', agentAlias: 'codex' } }, []), { modelName: 'gpt-6-astra', agentAlias: 'codex' });
  assert.deepEqual(taskModelIdentity(followup, [{ metadata: { syntheticRouting: { virtualModel: 'balanced', virtualAgentAlias: 'pool' }, model: 'gpt-6-astra' } }]), { modelName: 'balanced', agentAlias: 'pool' });
});

test('actual persisted execution wins over a stale history model', () => {
  assert.deepEqual(taskModelIdentity(followup, [{ metadata: { model: 'claude-opus-5-5' } }], [{ model_name: 'gpt-6-astra' }]), { modelName: 'gpt-6-astra', agentAlias: null });
});

const reportTask = { task_id: 'agent-run-run-1-report', task_type: 'agent-run', model_name: null, initial_job_data: JSON.stringify({ number: 0, type: 'agent-run', subtitle: 'Report run' }) };
const snapshotRun = (snapshot: Record<string, unknown>) => ({ definition_snapshot: JSON.stringify(snapshot) });

test('a report task names the model its run recorded on execution', () => {
  const history = [{ metadata: { model: 'gpt-6-astra', executionRouting: { model: 'gpt-6-astra', agentAlias: 'codex' } } }];
  assert.deepEqual(taskModelIdentity(reportTask, history, [], snapshotRun({ agentAlias: null, modelName: null })), { modelName: 'gpt-6-astra', agentAlias: 'codex' });
});
test('a historical report task recovers its model from execution records before its snapshot', () => {
  assert.deepEqual(taskModelIdentity(reportTask, [], [{ model_name: 'gpt-6-astra' }], snapshotRun({ agentAlias: 'claude', modelName: 'opus' })), { modelName: 'gpt-6-astra', agentAlias: null });
});
test('a historical report task whose snapshot pinned agent and model is named by it', () => {
  assert.deepEqual(taskModelIdentity(reportTask, [], [], snapshotRun({ agentAlias: 'codex', modelName: 'gpt-6-astra' })), { modelName: 'gpt-6-astra', agentAlias: 'codex' });
});
test('a historical report task that ran on defaults stays unknown', () => {
  for (const snapshot of [{ agentAlias: null, modelName: null }, { agentAlias: 'codex', modelName: null }, { agentAlias: null, modelName: 'gpt-6-astra' }]) {
    assert.deepEqual(taskModelIdentity(reportTask, [], [], snapshotRun(snapshot)), { modelName: null, agentAlias: null });
  }
  assert.deepEqual(taskModelIdentity(reportTask, [], []), { modelName: null, agentAlias: null });
  assert.deepEqual(taskModelIdentity(reportTask, [], [], { definition_snapshot: 'not json' }), { modelName: null, agentAlias: null });
});
test('a run snapshot never names a task that is not an automation run', () => {
  const issueTask = { task_id: 'issue-1', task_type: 'issue', model_name: 'claude-opus-5-5', initial_job_data: {} };
  assert.deepEqual(taskModelIdentity(issueTask, [], [], snapshotRun({ agentAlias: 'codex', modelName: 'gpt-6-astra' })), { modelName: 'claude-opus-5-5', agentAlias: null });
});
