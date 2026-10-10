import { describe, expect, it } from 'vitest';
import { buildTaskRow, runOutcome, runOutcomeOf, sanitizeTaskTitle } from './rowModel';
import type { Task, TaskGroup } from './types';

const base: Task = { id: 'task-1', status: 'completed', createdAt: '2026-09-15T10:00:00Z' };
const group = (tasks: Array<Partial<Task>>): TaskGroup => ({
  key: 'integry/propr-pr-2664', repoOwner: 'integry', repoName: 'propr', prNumber: 2664,
  tasks: tasks.map((task, index) => ({ ...base, id: `task-${index}`, ...task })),
});
const image = (index: number) => ({ type: 'image', title: `Preview ${index}`, url: `https://github.com/user-attachments/assets/${index}` });

describe('sanitizeTaskTitle', () => {
  it('drops the workflow prefix, the repeated PR number and the model tag', () => {
    expect(sanitizeTaskTitle('Ultrafix PR #2664: [2659 by GPT-6 Astra] Stop work when an issue or PR withdraws intent'))
      .toMatchObject({ type: 'Ultrafix', title: 'Stop work when an issue or PR withdraws intent' });
    expect(sanitizeTaskTitle('Followup: [870 by Claude Opus 4.6] Update checkout'))
      .toMatchObject({ type: 'Follow-up', title: 'Update checkout' });
    expect(sanitizeTaskTitle('New Issue: Add retries')).toMatchObject({ type: 'Implement', title: 'Add retries' });
  });

  it('removes bare entity prefixes and model tags that are not at the start', () => {
    expect(sanitizeTaskTitle('PR #2664: Stop work').title).toBe('Stop work');
    expect(sanitizeTaskTitle('Stop work [2659 by GPT-6 Astra] on withdrawal').title).toBe('Stop work on withdrawal');
  });

  it('ends a legacy title that may be hard-cut at 100 characters on a whole word, keeping all of its text in the tooltip', () => {
    const hardCut = 'Followup: Expose task changes, logs and events through the MCP server so that an MCP client can actu';
    expect(hardCut).toHaveLength(100);
    const sanitized = sanitizeTaskTitle(hardCut);
    expect(sanitized.title).toBe('Expose task changes, logs and events through the MCP server so that an MCP client can…');
    expect(sanitized.fullTitle).toBe('Expose task changes, logs and events through the MCP server so that an MCP client can actu');
  });

  it('never shows half a word, even when the last word of a 100-character title may be whole', () => {
    const complete = 'New Issue: Expose task changes, logs and events through the MCP server so that an MCP client can act';
    expect(complete).toHaveLength(100);
    const sanitized = sanitizeTaskTitle(complete);
    expect(sanitized.title).toBe('Expose task changes, logs and events through the MCP server so that an MCP client can…');
    expect(sanitized.fullTitle).toBe('Expose task changes, logs and events through the MCP server so that an MCP client can act');
  });

  it('leaves titles of any other length, or ending in punctuation, alone', () => {
    const short = 'Expose task changes through the MCP server so an MCP client can actu';
    expect(sanitizeTaskTitle(short).title).toBe(short);
    const complete = `${'Finish the work. '.repeat(6).slice(0, 99)}.`;
    expect(complete).toHaveLength(100);
    expect(sanitizeTaskTitle(complete).title).toBe(complete);
  });

  it('keeps ordinary bracketed titles', () => {
    expect(sanitizeTaskTitle('[Search by filename] Add fuzzy matching').title).toBe('[Search by filename] Add fuzzy matching');
  });
});

describe('buildTaskRow', () => {
  it('rolls every earlier run into one row named after the entity', () => {
    const row = buildTaskRow(group([
      { title: 'Ultrafix PR #2664: [2659 by GPT-6 Astra] Stop work when intent is withdrawn', subtitle: 'Ultrafix cycle 3 (linting)' },
      { title: 'Followup: Update 3', subtitle: 'Update', commitHash: '9f3c21e81a4d' },
      { title: 'Fix PR #2664: [2659 by GPT-6 Astra] Stop work when intent is withdrawn', subtitle: 'Restrict withdrawal labels' },
      { title: 'Review PR #2664: [2659 by GPT-6 Astra] Stop work when intent is withdrawn', subtitle: null },
    ]));
    expect(row.title).toBe('Stop work when intent is withdrawn');
    expect(row.type).toBe('Ultrafix');
    expect(row.detail).toBe('Ultrafix cycle 3 (linting)');
    expect(row.earlierRuns.map(run => [run.type, run.delta, run.summarized])).toEqual([
      // A follow-up makes the changes asked for, so it is a fix even when its summary names no action.
      ['Fix', 'Pushed commit 9f3c21e', false],
      ['Fix', 'Restrict withdrawal labels', true],
      ['Review', 'No code changes: finished without a commit', false],
    ]);
  });

  it('names a follow-up run by what it did instead of repeating Follow-up', () => {
    const title = 'Follow-up PR #2661: [2658 by GPT-6 Astra] Read-only token';
    const row = buildTaskRow(group([
      { title: 'Review PR #2661: Read-only token', subtitle: 'No blocking findings' },
      { title, subtitle: 'Fix seedCommit test failure' },
      { title, subtitle: 'Resolve AntigravityAgent git access conflicts' },
      { title, subtitle: 'Re-run the integration tests' },
      { title, subtitle: 'Review the token scope' },
      { title, subtitle: 'Update repoBranching.ts for read-only tokens' },
    ]));
    expect(row.earlierRuns.map(run => run.type)).toEqual(['Fix', 'Fix', 'Test', 'Review', 'Fix']);
    expect(row.earlierRuns.map(run => run.type)).not.toContain('Follow-up');
  });

  it('never names a row with a meaningless title', () => {
    const row = buildTaskRow(group([
      { title: 'Followup: Update 3', subtitle: 'Tighten the null check' },
      { title: 'New Issue: Add retries', subtitle: 'Preparing a PR for issue #12' },
    ]));
    expect(row.title).toBe('Add retries');
    expect(row.detail).toBe('Tighten the null check');
    expect(row.earlierRuns[0]).toMatchObject({ type: 'Implement', delta: 'No code changes: finished without a commit', summarized: false });
  });

  it('states what an unsummarized run came to instead of generic filler', () => {
    const run = (task: Partial<Task>) => runOutcome({ ...base, ...task });
    expect(run({ status: 'completed', commitHash: 'abcdef1234' })).toBe('Pushed commit abcdef1');
    expect(run({ status: 'completed' })).toBe('No code changes: finished without a commit');
    expect(run({ status: 'failed', failedReason: 'Agent timed out after 30m\n  at worker.ts:12' })).toBe('Agent timed out after 30m');
    expect(run({ status: 'failed' })).toBe('Stopped before reporting a result');
    expect(run({ status: 'cancelled' })).toBe('Stopped before committing changes');
    expect(run({ status: 'processing' })).toBe('No result yet');
    expect(run({ status: 'queued' })).toBe('Waiting to start');
    const row = buildTaskRow(group([{ title: 'Fix PR #1: A' }, { title: 'Follow-up PR #1: A' }, { title: 'Followup: Update 2' }]));
    expect(row.earlierRuns.map(earlier => earlier.delta)).not.toContain('Follow-up run');
  });

  it('gives a rollup line whose newest run has no summary that run\'s outcome, never a bare type', () => {
    const queued = buildTaskRow(group([
      { title: 'Review PR #2656: Show provider rate-limit resets', status: 'queued' },
      { title: 'Fix PR #2656: Show provider rate-limit resets', subtitle: 'Format reset times' },
    ]));
    expect(queued).toMatchObject({ type: 'Review', detail: null, outcome: 'Waiting to start' });
    const summarized = buildTaskRow(group([
      { title: 'Follow-up PR #2654: Retry webhooks', subtitle: 'Back off exponentially' },
      { title: 'Review PR #2654: Retry webhooks' },
    ]));
    expect(summarized).toMatchObject({ detail: 'Back off exponentially', outcome: null });
    // A single run states its outcome too, so its line under the title is never empty.
    const failed = buildTaskRow(group([{ title: 'New Issue: Add retries', status: 'failed', failedReason: 'Typecheck failed during test execution' }]));
    expect(failed).toMatchObject({ type: 'Implement', detail: null, outcome: 'Typecheck failed during test execution' });
  });

  it('shows the repository by name, keeping the owner for the tooltip', () => {
    const row = buildTaskRow({ ...group([{ title: 'New Issue: Add retries' }]), repoName: 'desktop-workspaces' });
    expect(row.repository).toBe('integry/desktop-workspaces');
    expect(row.repositoryName).toBe('desktop-workspaces');
  });

  it('keeps an assigned issue\'s assignees when a newer run of its linked PR has none', () => {
    const octocat = { id: '2', login: 'octocat', displayName: null, avatarUrl: null };
    const row = buildTaskRow(group([
      { title: 'Fix PR #2664: Stop work', prNumber: 2664, assignees: [] },
      { title: 'New Issue: Stop work', issueNumber: 2659, assignees: [octocat] },
    ]));
    expect(row.assignees).toEqual([octocat]);
  });

  it('joins different assignees of the linked issue and PR, newest run first, each user once', () => {
    const user = (id: string, login: string) => ({ id, login, displayName: null, avatarUrl: null });
    const row = buildTaskRow(group([
      { prNumber: 2664, assignees: [user('3', 'hubot')] },
      { prNumber: 2664, assignees: [user('3', 'hubot')] },
      { issueNumber: 2659, assignees: [user('2', 'octocat'), user('3', 'hubot-renamed')] },
    ]));
    expect(row.assignees.map(assignee => assignee.login)).toEqual(['hubot', 'octocat']);
  });

  it('is unassigned only when no run has an assignee', () => {
    expect(buildTaskRow(group([{ assignees: [] }, {}])).assignees).toEqual([]);
  });

  it('counts only trusted previews', () => {
    const row = buildTaskRow(group([{ title: 'Fix PR #1: A', previewMedia: [image(1), image(2), { type: 'image', url: 'javascript:alert(1)', title: 'x' }] as Task['previewMedia'] }]));
    expect(row.previewCount).toBe(2);
  });
});

describe('runOutcomeOf', () => {
  it('keeps queued work apart from work in flight', () => {
    for (const status of ['queued', 'pending', 'waiting']) expect(runOutcomeOf({ ...base, status })).toBe('waiting');
    for (const status of ['processing', 'claude_execution', 'post_processing']) expect(runOutcomeOf({ ...base, status })).toBe('active');
  });
});
