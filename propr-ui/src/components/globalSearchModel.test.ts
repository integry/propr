import { describe, expect, it } from 'vitest';
import type { DraftListItem } from '../api/plannerApi';
import type { TaskSearchResult } from '../hooks/useGlobalSearch';
import { formatTimeAgoPhrase, getItemDescription, getPlansAction, getScopeAction, getSearchStatus, getShortcutModifierLabel, splitFailureReason } from './globalSearchModel';

const plan = (name: string, initial_prompt: string) =>
  ({ kind: 'plan' as const, key: 'plan:1', plan: { draft_id: '1', repository: 'a/b', name, initial_prompt } as DraftListItem });

describe('globalSearchModel', () => {
  it('formats a complete relative-time phrase without "just now ago"', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(formatTimeAgoPhrase(ago(10_000))).toBe('just now');
    expect(formatTimeAgoPhrase(ago(5 * 60_000))).toBe('5m ago');
    expect(formatTimeAgoPhrase(ago(3 * 3_600_000))).toBe('3h ago');
    expect(formatTimeAgoPhrase(ago(2 * 86_400_000))).toBe('2d ago');
  });

  it('labels the shortcut modifier for the platform', () => {
    expect(getShortcutModifierLabel('MacIntel')).toBe('⌘');
    expect(getShortcutModifierLabel('iPad')).toBe('⌘');
    expect(getShortcutModifierLabel('Win32')).toBe('Ctrl+');
    expect(getShortcutModifierLabel('Linux x86_64')).toBe('Ctrl+');
    expect(getShortcutModifierLabel('')).toBe('Ctrl+');
  });

  it('labels the All scope\'s full search as the task search it opens', () => {
    expect(getScopeAction('all', ' mcp ')).toEqual({ label: 'Search all tasks for "mcp"', path: '/tasks?search=mcp' });
    expect(getScopeAction('all', 'mcp')).toEqual(getScopeAction('tasks', 'mcp'));
    // Plans matched under All stay reachable through their own full search.
    expect(getPlansAction('all', { all: 2, repositories: 0, plans: 2, tasks: 0 }, 'mcp'))
      .toEqual({ label: 'Search all plans for "mcp"', path: '/plans?search=mcp' });
  });

  it('drops a description that only restates the title', () => {
    expect(getItemDescription(plan('Expose retrieval over MCP', 'Plan Expose retrieval over MCP'))).toBeNull();
    expect(getItemDescription(plan('Expose retrieval over MCP', 'Expose retrieval over MCP.'))).toBeNull();
    expect(getItemDescription(plan('', 'Configure endpoint routes'))).toBeNull();
    expect(getItemDescription(plan('Expose retrieval over MCP', 'Configure endpoint routes and handlers.')))
      .toBe('Configure endpoint routes and handlers.');
  });

  it('keeps a short or non-ASCII description that does not restate the title', () => {
    expect(getItemDescription(plan('Repair production deployment', 'Rollback'))).toBe('Rollback');
    expect(getItemDescription(plan('Repair production deployment', 'Plan'))).toBe('Plan');
    expect(getItemDescription(plan('Repair production deployment', 'Repair production deployment now')))
      .toBe('Repair production deployment now');
    expect(getItemDescription(plan('Réparer le déploiement', 'Plan: réparer le déploiement'))).toBeNull();
    expect(getItemDescription(plan('Réparer le déploiement', 'Annuler'))).toBe('Annuler');
    expect(getItemDescription(plan('Deploy', '部署回滚'))).toBe('部署回滚');
    const task = (title: string, subtitle: string) =>
      ({ kind: 'task' as const, key: 'task:1', task: { id: '1', status: 'done', createdAt: '', title, subtitle } as TaskSearchResult });
    expect(getItemDescription(task('Fix login flow', 'Hotfix'))).toBe('Hotfix');
    expect(getItemDescription(task('Fix login flow', 'Fix login flow'))).toBeNull();
  });

  it('splits file paths out of a failure reason', () => {
    expect(splitFailureReason('Lint failed on src/mcp/activity.ts')).toEqual([
      { text: 'Lint failed on ', path: false },
      { text: 'src/mcp/activity.ts', path: true },
    ]);
    expect(splitFailureReason('Timed out')).toEqual([{ text: 'Timed out', path: false }]);
  });

  it('labels statuses with capitalised text and a tone', () => {
    expect(getSearchStatus('failed')).toEqual({ label: 'Failed', tone: 'failed' });
    expect(getSearchStatus('review')).toEqual({ label: 'Review', tone: 'review' });
    expect(getSearchStatus('pr_created')).toEqual({ label: 'PR created', tone: 'review' });
    expect(getSearchStatus('post_processing')).toEqual({ label: 'Post processing', tone: 'active' });
  });
});
