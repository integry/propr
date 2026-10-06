import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitoredRepo } from '../api/proprApi';
import { RepositoryAutoResolveConflictsControl } from './RepositoryAutoResolveConflictsControl';

const getSettings = vi.hoisted(() => vi.fn());
vi.mock('../api/proprApi', async (importOriginal) => ({ ...await importOriginal<object>(), getSettings }));

const repo: MonitoredRepo = { id: 'repo-1', name: 'integry/propr', enabled: true };
const name = 'Auto-resolve merge conflicts for integry/propr';

beforeEach(() => {
  getSettings.mockReset();
  getSettings.mockResolvedValue({ auto_resolve_merge_conflicts: true });
});

describe('RepositoryAutoResolveConflictsControl', () => {
  it('shows the inherited instance default for repositories without an override', async () => {
    render(<RepositoryAutoResolveConflictsControl repo={repo} onUpdate={vi.fn()} isReadOnly={false} />);

    expect((screen.getByRole('combobox', { name }) as HTMLSelectElement).value).toBe('inherit');
    expect(await screen.findByRole('option', { name: 'Use instance default (currently On)' })).toBeTruthy();
  });

  it('reflects a stored override', () => {
    render(<RepositoryAutoResolveConflictsControl repo={{ ...repo, autoResolveMergeConflicts: false }} onUpdate={vi.fn()} isReadOnly={false} instanceDefault={false} />);

    expect((screen.getByRole('combobox', { name }) as HTMLSelectElement).value).toBe('never');
    expect(screen.getByRole('option', { name: 'Use instance default (currently Off)' })).toBeTruthy();
  });

  it('sets always, never, and inherit (null)', () => {
    const onUpdate = vi.fn();
    render(<RepositoryAutoResolveConflictsControl repo={repo} onUpdate={onUpdate} isReadOnly={false} instanceDefault={false} />);
    const select = screen.getByRole('combobox', { name });

    fireEvent.change(select, { target: { value: 'always' } });
    fireEvent.change(select, { target: { value: 'never' } });
    fireEvent.change(select, { target: { value: 'inherit' } });

    expect(onUpdate.mock.calls).toEqual([['repo-1', true], ['repo-1', false], ['repo-1', null]]);
  });
});
