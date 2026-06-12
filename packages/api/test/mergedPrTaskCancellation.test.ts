import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import { db } from '@propr/core';
import {
  cancelActiveTasksForMergedPR,
  handleWebhookRequest,
  isMergedPullRequestClose,
  PR_MERGED_CANCELLATION_REASON,
  type MergedPRStopContext,
  type MergedPRTaskCancellerDeps,
} from '../webhookHandler.js';

const REPOSITORY = 'acme/widgets';
const PR_NUMBER = 42;

// The @propr/core barrel eagerly opens the shared db connection on import;
// close it so the test process can exit.
after(async () => {
  await db.destroy();
});

function makeCancellerDeps(overrides: Partial<MergedPRTaskCancellerDeps> = {}): {
  deps: MergedPRTaskCancellerDeps;
  stopCalls: Array<{ id: string; context: MergedPRStopContext }>;
} {
  const stopCalls: Array<{ id: string; context: MergedPRStopContext }> = [];
  const deps: MergedPRTaskCancellerDeps = {
    getActiveTasksForPR: async () => ({
      activeTasks: [
        { taskId: 'task-a', state: 'claude_execution' },
        { taskId: 'task-b', state: 'processing' },
      ],
      queuedJobs: [{ jobId: 'issue-acme-widgets-42-99', state: 'waiting' }],
    }),
    stopTask: async (id, context) => {
      stopCalls.push({ id, context });
      return { success: true };
    },
    ...overrides,
  };
  return { deps, stopCalls };
}

test('isMergedPullRequestClose only matches merged PR close events', () => {
  const merged = { action: 'closed', pull_request: { merged: true } };
  const unmerged = { action: 'closed', pull_request: { merged: false } };
  const reopened = { action: 'reopened', pull_request: { merged: true } };

  assert.equal(isMergedPullRequestClose('pull_request', merged), true);
  assert.equal(isMergedPullRequestClose('pull_request', unmerged), false);
  assert.equal(isMergedPullRequestClose('pull_request', reopened), false);
  assert.equal(isMergedPullRequestClose('issues', merged), false);
  assert.equal(isMergedPullRequestClose('pull_request', { action: 'closed' }), false);
});

test('cancelActiveTasksForMergedPR stops every active task and queued job with the merge reason', async () => {
  const { deps, stopCalls } = makeCancellerDeps();

  const summary = await cancelActiveTasksForMergedPR(REPOSITORY, PR_NUMBER, deps);

  assert.deepEqual(summary, { attempted: 3, cancelled: 3, failed: 0, skipped: 0 });
  assert.deepEqual(stopCalls.map(c => c.id).sort(), ['issue-acme-widgets-42-99', 'task-a', 'task-b']);
  for (const call of stopCalls) {
    assert.equal(call.context.cancellationReason, PR_MERGED_CANCELLATION_REASON);
    assert.equal(call.context.requestedBy, 'system');
    assert.equal(call.context.ensureCancelled, true, 'merge-triggered stops must record the cancellation');
    assert.match(call.context.reason, /acme\/widgets#42 was merged/);
  }
});

test('cancelActiveTasksForMergedPR does nothing when there is no active work', async () => {
  const { deps, stopCalls } = makeCancellerDeps({
    getActiveTasksForPR: async () => ({ activeTasks: [], queuedJobs: [] }),
  });

  const summary = await cancelActiveTasksForMergedPR(REPOSITORY, PR_NUMBER, deps);

  assert.deepEqual(summary, { attempted: 0, cancelled: 0, failed: 0, skipped: 0 });
  assert.equal(stopCalls.length, 0);
});

test('cancelActiveTasksForMergedPR continues cancelling after a task fails to stop', async () => {
  const stopCalls: string[] = [];
  const { deps } = makeCancellerDeps({
    stopTask: async (id) => {
      stopCalls.push(id);
      if (id === 'task-a') throw new Error('container stop blew up');
      return { success: true };
    },
  });

  const summary = await cancelActiveTasksForMergedPR(REPOSITORY, PR_NUMBER, deps);

  assert.equal(stopCalls.length, 3, 'all tasks should be attempted despite the failure');
  assert.deepEqual(summary, { attempted: 3, cancelled: 2, failed: 1, skipped: 0 });
});

test('cancelActiveTasksForMergedPR counts no-longer-active tasks as skipped', async () => {
  const { deps } = makeCancellerDeps({
    stopTask: async (id) => ({ success: id !== 'task-a' }),
  });

  const summary = await cancelActiveTasksForMergedPR(REPOSITORY, PR_NUMBER, deps);

  assert.deepEqual(summary, { attempted: 3, cancelled: 2, failed: 0, skipped: 1 });
});

// --- handleWebhookRequest integration (no live Redis/GitHub) ---

const WEBHOOK_SECRET = 'test-secret';

function makeWebhookRequest(event: string, payload: Record<string, unknown>): Request {
  const body = Buffer.from(JSON.stringify(payload));
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(body);
  return {
    body,
    headers: {
      'x-hub-signature-256': `sha256=${hmac.digest('hex')}`,
      'x-github-delivery': `delivery-${Math.random().toString(36).slice(2)}`,
      'x-github-event': event,
    },
  } as unknown as Request;
}

function makeWebhookResponse(): { res: Response; result: { statusCode?: number; sent?: unknown } } {
  const result: { statusCode?: number; sent?: unknown } = {};
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      result.sent = payload;
      return this;
    },
  } as unknown as Response;
  return { res, result };
}

function makeHandlerDeps(canceller: MergedPRTaskCancellerDeps) {
  const processed: string[] = [];
  return {
    processed,
    deps: {
      webhookSecret: WEBHOOK_SECRET,
      redis: { set: async () => 'OK' },
      processor: async (_payload: Record<string, unknown>, event: string) => {
        processed.push(event);
      },
      correlationId: 'test-correlation',
      mergedPRTaskCanceller: canceller,
    },
  };
}

function prClosedPayload(merged: boolean): Record<string, unknown> {
  return {
    action: 'closed',
    repository: { full_name: REPOSITORY },
    pull_request: { number: PR_NUMBER, merged },
  };
}

test('handleWebhookRequest cancels active tasks when a PR is merged', async () => {
  const { deps: canceller, stopCalls } = makeCancellerDeps();
  const { deps, processed } = makeHandlerDeps(canceller);
  const { res, result } = makeWebhookResponse();

  await handleWebhookRequest(makeWebhookRequest('pull_request', prClosedPayload(true)), res, deps);

  assert.equal(result.statusCode, 200);
  assert.equal(stopCalls.length, 3);
  assert.deepEqual(processed, ['pull_request'], 'standard processing still runs');
});

test('handleWebhookRequest does not cancel anything for an unmerged PR close', async () => {
  const { deps: canceller, stopCalls } = makeCancellerDeps();
  const { deps } = makeHandlerDeps(canceller);
  const { res, result } = makeWebhookResponse();

  await handleWebhookRequest(makeWebhookRequest('pull_request', prClosedPayload(false)), res, deps);

  assert.equal(result.statusCode, 200);
  assert.equal(stopCalls.length, 0);
});

test('handleWebhookRequest still succeeds when the PR task lookup fails entirely', async () => {
  const { deps: canceller } = makeCancellerDeps({
    getActiveTasksForPR: async () => { throw new Error('database unavailable'); },
  });
  const { deps, processed } = makeHandlerDeps(canceller);
  const { res, result } = makeWebhookResponse();

  await handleWebhookRequest(makeWebhookRequest('pull_request', prClosedPayload(true)), res, deps);

  assert.equal(result.statusCode, 200, 'webhook delivery must not fail');
  assert.deepEqual(processed, ['pull_request']);
});
