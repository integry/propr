import { describe, expect, it } from 'vitest';
import { editorKeyForRoute } from './useUnsavedEditorGuard';

describe('which editor a route shows', () => {
  it('keeps one key for a saved automation, its runs and one run, so their links never ask', () => {
    expect(editorKeyForRoute('/automations/a1')).toBe('a1');
    expect(editorKeyForRoute('/automations/a1/runs')).toBe('a1');
    expect(editorKeyForRoute('/automations/a1/runs/r1')).toBe('a1');
  });

  it('keys the new-automation form by its template', () => {
    expect(editorKeyForRoute('/automations/new')).toBe('new:');
    expect(editorKeyForRoute('/automations/new?template=daily-issue-triage')).toBe('new:daily-issue-triage');
  });

  it('has no editor for the list or other pages', () => {
    expect(editorKeyForRoute('/automations')).toBeNull();
    expect(editorKeyForRoute('/tasks')).toBeNull();
  });
});
