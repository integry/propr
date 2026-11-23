import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, mock, test } from 'node:test';
import { closeConnection } from '@propr/core';
import type { AgentExecutionResult } from '@propr/core';
import { inferCommitType } from '@propr/shared';
import { buildCommitSubjectPrompt, generateCommitSubject } from '../packages/core/src/agents/commitSubjectGeneration.ts';
import { applyRunSummarySelection } from '../packages/core/src/agents/runSummarySelection.ts';
import { buildCommitMessage } from '../src/jobs/prCommentJobUtils.ts';
import { buildAgentCommitMessage, pendingChangePaths, pullRequestTitleFromTaskTitle } from '../src/jobs/agentCommitMessage.ts';

after(async () => {
  await closeConnection();
});

const SUMMARY = 'I fixed both selected findings, F1 and F2, and the unit and browser tests for them pass.';
const context = { taskId: 'task-1', issueRef: { number: 7, repoOwner: 'o', repoName: 'r' } };

function deps(reply: string | (() => Promise<string>)) {
  const runAnalysis = mock.fn(typeof reply === 'string' ? async () => reply : reply);
  return {
    runAnalysis,
    deps: {
      loadSettings: async () => ({ agent_alias: 'small' }) as never,
      resolveModel: async () => 'claude:haiku',
      runAnalysis: runAnalysis as never,
    },
  };
}

test('a first-person summary goes in, an imperative description comes out', async () => {
  const { deps: d, runAnalysis } = deps('Keep the create dialog open after saving.');
  assert.equal(await generateCommitSubject(SUMMARY, { ...context, title: 'Create dialog closes' }, d), 'keep the create dialog open after saving');
  const call = runAnalysis.mock.calls[0].arguments[0] as { prompt: string; executionType: string; metadata: { taskKind: string } };
  assert.equal(call.executionType, 'title-generation');
  assert.equal(call.metadata.taskKind, 'commit-subject');
  assert.match(call.prompt, /Imperative mood/);
  assert.match(call.prompt, /Create dialog closes/);
  assert.ok(call.prompt.includes(SUMMARY));
});

test('the prompt caps the summary it sends', () => {
  assert.ok(!buildCommitSubjectPrompt('x'.repeat(10_000)).includes('x'.repeat(4001)));
});

test('a narrated reply, a failure, a timeout or no small model gives null (the caller uses the title)', async () => {
  assert.equal(await generateCommitSubject(SUMMARY, context, deps(SUMMARY).deps), null);
  assert.equal(await generateCommitSubject(SUMMARY, context, deps(async () => { throw new Error('boom'); }).deps), null);
  assert.equal(await generateCommitSubject(SUMMARY, context, { ...deps(() => new Promise<string>(() => {})).deps, timeoutMs: 20 }), null);
  const unconfigured = deps('Keep it');
  assert.equal(await generateCommitSubject(SUMMARY, context, { ...unconfigured.deps, loadSettings: async () => ({ agent_alias: '' }) as never }), null);
  assert.equal(unconfigured.runAnalysis.mock.callCount(), 0);
  assert.equal(await generateCommitSubject('  ', context, deps('Keep it').deps), null);
});

function run(overrides: Partial<AgentExecutionResult> = {}): AgentExecutionResult {
  return {
    success: true, executionTimeMs: 1, logs: '', modifiedFiles: [], modelUsed: 'm',
    conversationLog: [], summary: SUMMARY, commitMessage: SUMMARY, ...overrides,
  };
}

test('applyRunSummarySelection proposes a subject only when asked, with its own call', async () => {
  const { deps: d, runAnalysis } = deps('Keep the create dialog open');
  const result = await applyRunSummarySelection(run(), { ...context, commitSubject: { title: 'Dialog' } }, d);
  assert.equal(result.commitSubject, 'keep the create dialog open');
  // The summary is untouched: it stays the commit body.
  assert.equal(result.summary, SUMMARY);
  // One call for the (single-candidate) summary verdict, one for the subject.
  assert.equal(runAnalysis.mock.callCount(), 2);

  const plain = deps('Keep the create dialog open');
  assert.equal((await applyRunSummarySelection(run(), context, plain.deps)).commitSubject, undefined);
  assert.equal(plain.runAnalysis.mock.callCount(), 1);

  const failed = deps('Keep it');
  assert.equal((await applyRunSummarySelection(run({ success: false }), { ...context, commitSubject: {} }, failed.deps)).commitSubject, undefined);
  assert.equal(failed.runAnalysis.mock.callCount(), 0);
});

test('the follow-up commit: generated subject, summary in the body, agent trailer last', () => {
  const message = buildCommitMessage({
    changesSummary: SUMMARY, unprocessedComments: [{ id: 5, author: 'alice' } as never], pullRequestNumber: 3,
    claudeResult: { success: true, model: 'claude-opus-5-5', agentAlias: 'claude', commitSubject: 'keep the create dialog open' } as never,
    llm: null, authorsText: '@alice', title: 'Dialog fixes', paths: ['ui/src/Dialog.tsx'],
  });
  const [subject, body, ...rest] = message.split('\n\n');
  assert.equal(subject, 'fix: keep the create dialog open');
  assert.equal(body, SUMMARY);
  assert.match(rest.join('\n\n'), /PR: #3\nComment by: @alice \(ID: 5\)\nModel: /);
  assert.match(message, /\n\nProPR-Agent: claude\/claude-opus-5-5$/);
  assert.doesNotMatch(message, /\(ai\)/);
});

test('the follow-up commit falls back to the PR title, never to the summary', () => {
  const message = buildCommitMessage({
    changesSummary: SUMMARY, unprocessedComments: [], pullRequestNumber: 3,
    claudeResult: { success: true, model: 'claude-opus-5-5' } as never, llm: null, authorsText: '@a',
    title: pullRequestTitleFromTaskTitle('Follow-up PR #3: Fix the login redirect'), paths: ['src/login.ts'],
  });
  assert.equal(message.split('\n')[0], 'fix: fix the login redirect');
});

test('the issue commit uses the type of the changed paths and the issue title as fallback', () => {
  const message = buildAgentCommitMessage({
    generatedSubject: null, title: 'Explain the retry settings', fallbackSubject: 'resolve issue #12',
    paths: ['docs/settings.md'], body: SUMMARY, agentAlias: 'codex', model: 'gpt-5',
  });
  assert.equal(message, `docs: explain the retry settings\n\n${SUMMARY}\n\nProPR-Agent: codex/gpt-5`);
});

test('PR task titles give back the PR title', () => {
  assert.equal(pullRequestTitleFromTaskTitle('Fix PR #12: Add retries'), 'Add retries');
  assert.equal(pullRequestTitleFromTaskTitle('Follow-up PR #12: Untitled pull request'), null);
  assert.equal(pullRequestTitleFromTaskTitle(undefined), null);
});

test('pending change paths come from git status, without ProPR runtime files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'commit-subject-'));
  try {
    const git = (...args: string[]) => promisify(execFile)('git', ['-C', dir, ...args]);
    await git('init', '-q');
    await mkdir(path.join(dir, 'docs'));
    await writeFile(path.join(dir, 'docs', 'a.md'), 'a');
    // Every path staging leaves out (assets, caches, installed helpers, previews) stays out of the type too.
    for (const runtimeFile of ['.propr/previews/shot.png', '.propr/preview-src/page.html', '.propr/assets/output.json',
        '.propr/cache/index.bin', '.propr/.cache/x', '.propr/node_modules/pkg/index.js']) {
        await mkdir(path.dirname(path.join(dir, runtimeFile)), { recursive: true });
        await writeFile(path.join(dir, runtimeFile), 'x');
    }
    const paths = await pendingChangePaths(dir);
    assert.deepEqual(paths, ['docs/a.md']);
    assert.equal(inferCommitType({ paths, title: 'Add retry documentation' }), 'docs');
    assert.deepEqual(await pendingChangePaths(path.join(dir, 'missing')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
