import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PlanHistoryDialog } from './PlanHistoryDialog';
import type { PlanRevision } from '../../api/proprApi';
import { describeRevision } from './planRevisionLabels';

const api = vi.hoisted(() => ({
  listPlanRevisions: vi.fn(),
  getPlanRevision: vi.fn(),
}));

vi.mock('../../api/proprApi', () => api);

const refinementSnapshot = {
  revision_id: 7, draft_revision: 3, status_before: 'refining', status_after: 'review',
  cause: 'generation' as const, nameBefore: null, nameAfter: null, currentCause: 'refinement' as const,
  replaced_at: '2026-09-28 10:00:00', issue_count: 2, titles: ['Add metrics', 'Trace tool calls'],
};

const editSnapshot = { ...refinementSnapshot, revision_id: 8, status_before: 'review' };
const preview = (snapshot = refinementSnapshot): PlanRevision => ({
  ...snapshot, plan: [{ id: 'preview', title: `Version ${snapshot.revision_id}`, body: 'Full task details', implementation: '' }],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('PlanHistoryDialog', () => {
  beforeEach(() => {
    api.listPlanRevisions.mockReset().mockResolvedValue([refinementSnapshot]);
    api.getPlanRevision.mockReset().mockResolvedValue({
      ...refinementSnapshot,
      plan: [
        { id: 'a', title: 'Add metrics', body: 'Count MCP calls per tool', implementation: '' },
        { id: 'b', title: 'Trace tool calls', body: 'Emit spans', implementation: '' },
      ],
    });
  });

  test('previews an earlier version and restores it', async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={onRestore} />);

    const restoreButton = screen.getByRole('button', { name: /restore this version/i });
    expect(restoreButton).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    expect(await screen.findByText('Count MCP calls per tool')).toBeInTheDocument();
    expect(api.getPlanRevision).toHaveBeenCalledWith('draft-1', 7);

    fireEvent.click(restoreButton);
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(7));
  });

  test('only the latest selection can supply the preview and restore target', async () => {
    const first = deferred<PlanRevision>();
    const second = deferred<PlanRevision>();
    api.listPlanRevisions.mockResolvedValue([refinementSnapshot, editSnapshot]);
    api.getPlanRevision.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={onRestore} />);
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    fireEvent.click(screen.getByRole('button', { name: /before edits/i }));
    const restore = screen.getByRole('button', { name: /restore this version/i });
    expect(restore).toBeDisabled();
    await act(async () => second.resolve(preview(editSnapshot)));
    expect(screen.getByText('1. Version 8')).toBeInTheDocument();
    expect(restore).toBeEnabled();
    await act(async () => first.resolve(preview()));
    expect(screen.queryByText('1. Version 7')).not.toBeInTheDocument();
    fireEvent.click(restore);
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(8));
  });

  test('clears an existing preview while loading and keeps restore disabled after failure', async () => {
    const next = deferred<PlanRevision>();
    api.listPlanRevisions.mockResolvedValue([refinementSnapshot, editSnapshot]);
    api.getPlanRevision.mockResolvedValueOnce(preview()).mockReturnValueOnce(next.promise);
    const onRestore = vi.fn();
    render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={onRestore} />);
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    await screen.findByText('1. Version 7');
    fireEvent.click(screen.getByRole('button', { name: /before edits/i }));
    const restore = screen.getByRole('button', { name: /restore this version/i });
    expect(restore).toBeDisabled();
    expect(screen.queryByText('1. Version 7')).not.toBeInTheDocument();
    fireEvent.click(restore);
    expect(onRestore).not.toHaveBeenCalled();
    await act(async () => next.reject(new Error('Preview unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Preview unavailable');
    expect(restore).toBeDisabled();
  });

  test('superseded failures cannot clear the latest selection loading state', async () => {
    const first = deferred<PlanRevision>();
    const second = deferred<PlanRevision>();
    api.listPlanRevisions.mockResolvedValue([refinementSnapshot, editSnapshot]);
    api.getPlanRevision.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    fireEvent.click(screen.getByRole('button', { name: /before edits/i }));
    await act(async () => first.reject(new Error('Stale failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /before edits/i }).querySelector('.animate-spin')).not.toBeNull();
    expect(screen.getByRole('button', { name: /restore this version/i })).toBeDisabled();
    await act(async () => second.resolve(preview(editSnapshot)));
    expect(screen.getByRole('button', { name: /restore this version/i })).toBeEnabled();
  });

  test.each(['close', 'draft change', 'unmount'] as const)('invalidates outstanding previews on %s', async change => {
    const pending = deferred<PlanRevision>();
    api.getPlanRevision.mockReturnValueOnce(pending.promise);
    const props = { isOpen: true, draftId: 'draft-1', onClose: vi.fn(), onRestore: vi.fn() };
    const view = render(<PlanHistoryDialog {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    if (change === 'unmount') {
      view.unmount();
      render(<PlanHistoryDialog {...props} />);
    } else if (change === 'close') {
      view.rerender(<PlanHistoryDialog {...props} isOpen={false} />);
      view.rerender(<PlanHistoryDialog {...props} />);
    } else {
      view.rerender(<PlanHistoryDialog {...props} draftId="draft-2" />);
    }
    await screen.findByRole('button', { name: /before refinement/i });
    await act(async () => pending.resolve(preview()));
    expect(screen.queryByText('1. Version 7')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /restore this version/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /before refinement/i }));
    await screen.findByText('Emit spans');
    expect(api.getPlanRevision).toHaveBeenLastCalledWith(change === 'draft change' ? 'draft-2' : 'draft-1', 7);
    expect(screen.getByRole('button', { name: /restore this version/i })).toBeEnabled();
  });

  test('holds the selected revision fixed while restore is outstanding', async () => {
    const pending = deferred<void>();
    api.listPlanRevisions.mockResolvedValue([refinementSnapshot, editSnapshot]);
    const onRestore = vi.fn().mockReturnValue(pending.promise);
    render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={onRestore} />);
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    await screen.findByText('Emit spans');
    fireEvent.click(screen.getByRole('button', { name: /restore this version/i }));
    const other = screen.getByRole('button', { name: /before edits/i });
    expect(other).toBeDisabled();
    fireEvent.click(other);
    expect(api.getPlanRevision).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(7);
    await act(async () => pending.resolve());
    expect(other).toBeEnabled();
  });

  test('a previous draft restore cannot change the new draft dialog state', async () => {
    const oldRestore = deferred<void>();
    const currentRestore = deferred<void>();
    const onRestore = vi.fn().mockReturnValueOnce(oldRestore.promise).mockReturnValueOnce(currentRestore.promise);
    const props = { isOpen: true, draftId: 'draft-1', onClose: vi.fn(), onRestore };
    const { rerender } = render(<PlanHistoryDialog {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    await screen.findByText('Emit spans');
    fireEvent.click(screen.getByRole('button', { name: /restore this version/i }));
    rerender(<PlanHistoryDialog {...props} draftId="draft-2" />);
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    await screen.findByText('Emit spans');
    fireEvent.click(screen.getByRole('button', { name: /restore this version/i }));
    expect(onRestore).toHaveBeenCalledTimes(2);
    await act(async () => oldRestore.reject(new Error('Old draft failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /restore this version/i })).toBeDisabled();
    await act(async () => currentRestore.resolve());
    expect(screen.getByRole('button', { name: /restore this version/i })).toBeEnabled();
  });

  test('shows a restore failure and keeps restore disabled when read-only', async () => {
    const onRestore = vi.fn().mockRejectedValue(new Error('The plan cannot be restored while an operation is running'));
    const { rerender } = render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={onRestore} />);
    fireEvent.click(await screen.findByRole('button', { name: /before refinement/i }));
    await screen.findByText('Emit spans');
    fireEvent.click(screen.getByRole('button', { name: /restore this version/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('while an operation is running');

    rerender(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={onRestore} isReadOnly />);
    expect(screen.getByRole('button', { name: /restore this version/i })).toBeDisabled();
  });

  test('explains an empty history', async () => {
    api.listPlanRevisions.mockResolvedValue([]);
    render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={vi.fn()} />);
    expect(await screen.findByText(/no earlier versions yet/i)).toBeInTheDocument();
  });

  test('shows how each saved plan version was created', async () => {
    render(<PlanHistoryDialog isOpen draftId="draft-1" onClose={vi.fn()} onRestore={vi.fn()} />);
    expect(await screen.findByText('Generated')).toBeInTheDocument();
  });

  test('labels snapshots by the operation that replaced them', () => {
    expect(describeRevision({ status_before: 'generating', status_after: 'review' })).toBe('Before generation');
    expect(describeRevision({ status_before: 'review', status_after: 'review' })).toBe('Before edits');
    expect(describeRevision({ status_before: 'review', status_after: 'draft' })).toBe('Before returning to setup');
    expect(describeRevision({ status_before: 'approved', status_after: 'executing' })).toBe('Before publishing');
  });
});
