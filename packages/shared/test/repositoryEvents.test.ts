import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REPOSITORY_EVENT_DOMAINS, REPOSITORY_EVENT_TYPES, TASK_EVENT_KINDS, TASK_EVENT_TYPES, TASK_TERMINAL_EVENT_TYPES,
  isRepositoryEventType, taskEventKind,
} from '../src/repositoryEvents.js';
import { REPOSITORY_EVENT_ALL_TYPES, isRepositoryEventDomain } from '../src/repositoryEventWait.js';

test('the task domain is appended after the existing domains with its five event types', () => {
  assert.deepEqual([...REPOSITORY_EVENT_DOMAINS], ['pull_request', 'epic_queue', 'plan_issue', 'task']);
  assert.deepEqual([...TASK_EVENT_TYPES], ['queued', 'started', 'completed', 'failed', 'cancelled']);
  assert.equal(REPOSITORY_EVENT_TYPES.task, TASK_EVENT_TYPES);
  assert.deepEqual([...TASK_TERMINAL_EVENT_TYPES], ['completed', 'failed', 'cancelled']);
  for (const type of TASK_EVENT_TYPES) assert.equal(isRepositoryEventType('task', type), true, type);
  assert.equal(isRepositoryEventType('task', 'status_changed'), false);
  assert.equal(isRepositoryEventType('plan_issue', 'queued'), false);
  assert.equal(isRepositoryEventDomain('task'), true);
  // Readers that accept a type filter derive it from the domain list.
  for (const type of ['queued', 'started', 'failed', 'cancelled']) assert.ok(REPOSITORY_EVENT_ALL_TYPES.includes(type), type);
});

test('stored task types map to the documented task kinds; other task types are not journaled', () => {
  assert.deepEqual([...TASK_EVENT_KINDS], ['implementation', 'follow-up', 'review', 'merge-conflict', 'automation']);
  assert.equal(taskEventKind('issue'), 'implementation');
  assert.equal(taskEventKind(undefined), 'implementation');
  assert.equal(taskEventKind('pr-comment'), 'follow-up');
  assert.equal(taskEventKind('review'), 'review');
  assert.equal(taskEventKind('merge_conflict'), 'merge-conflict');
  assert.equal(taskEventKind('agent-run'), 'automation');
  for (const type of ['goal', 'goal-step', 'task-import', 'something-else']) assert.equal(taskEventKind(type), null, type);
});
