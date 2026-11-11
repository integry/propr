import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import FileOverlapNotice from './FileOverlapNotice';
import LiveFileChips from './LiveFileChips';

const fileChangesMocks = vi.hoisted(() => ({ getFileChanges: vi.fn() }));
vi.mock('../../api/fileChangesApi', () => ({ getFileChanges: fileChangesMocks.getFileChanges }));
vi.mock('../../contexts/useSocket', () => ({ useSocket: () => ({ isConnected: false, onTaskUpdate: () => () => undefined }) }));

const overlap = {
  taskId: 'other-task', paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], totalPaths: 12,
  repository: 'acme/app', issueNumber: 42, taskType: 'issue',
};

describe('FileOverlapNotice', () => {
  it('names the other task with a link and bounds the shared paths', () => {
    render(<MemoryRouter><FileOverlapNotice overlaps={[overlap, { ...overlap, taskId: 'pr-task', issueNumber: 7, taskType: 'pr_comment', paths: ['README.md'], totalPaths: 1 }]} /></MemoryRouter>);
    const note = screen.getByRole('note', { name: 'Also being changed by other tasks' });
    expect(note).toHaveTextContent('Also being changed by issue #42: src/a.ts, src/b.ts, src/c.ts and 9 more');
    expect(screen.getByRole('link', { name: 'issue #42' })).toHaveAttribute('href', '/tasks/other-task');
    expect(screen.getByRole('link', { name: 'PR #7' })).toHaveAttribute('href', '/tasks/pr-task');
  });

  it('renders nothing without overlaps', () => {
    const { container } = render(<MemoryRouter><FileOverlapNotice overlaps={[]} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the API overlaps on an active task and hides them once the task has finished', async () => {
    fileChangesMocks.getFileChanges.mockResolvedValue({ taskId: 'task-1', lastUpdated: '', overlaps: [overlap], files: [{ path: 'src/a.ts', status: 'modified', linesAdded: 1, linesRemoved: 0, diff: '+a' }] });
    const { rerender } = render(<MemoryRouter><LiveFileChips taskId="task-1" isActive={true} /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByRole('link', { name: 'issue #42' })).toBeInTheDocument();
    rerender(<MemoryRouter><LiveFileChips taskId="task-1" isActive={false} /></MemoryRouter>);
    expect(screen.queryByRole('note', { name: 'Also being changed by other tasks' })).not.toBeInTheDocument();
  });
});
