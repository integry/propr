import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MonitoredRepo } from '../api/proprApi';
import { RepositoryVisualPreviewControl } from './RepositoryVisualPreviewControl';

const repo: MonitoredRepo = {
  id: 'repo-1',
  name: 'integry/propr',
  enabled: true,
  visualPreview: { enabled: true, types: ['image'] }
};

describe('RepositoryVisualPreviewControl', () => {
  it('hides the plan selector and does not update configuration in read-only mode', () => {
    const onUpdate = vi.fn();
    render(<RepositoryVisualPreviewControl repo={repo} onUpdate={onUpdate} isReadOnly />);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('removes the editable plan selector when switching to read-only mode', () => {
    const onUpdate = vi.fn();
    const { rerender } = render(<RepositoryVisualPreviewControl repo={repo} onUpdate={onUpdate} isReadOnly={false} />);
    const selector = screen.getByRole('combobox');
    expect(selector).toBeEnabled();

    rerender(<RepositoryVisualPreviewControl repo={repo} onUpdate={onUpdate} isReadOnly />);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: 'paid' } });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('updates preview types and preserves edited instructions', () => {
    const onUpdate = vi.fn();
    render(<RepositoryVisualPreviewControl repo={repo} onUpdate={onUpdate} isReadOnly={false} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Visual preview instructions for integry/propr' }), {
      target: { value: '  Capture the responsive menu.  ' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Videos' }));

    expect(onUpdate).toHaveBeenLastCalledWith('repo-1', {
      enabled: true,
      types: ['image', 'video'],
      instructions: 'Capture the responsive menu.'
    });
  });

  it('keeps at least one preview type selected', () => {
    const onUpdate = vi.fn();
    render(<RepositoryVisualPreviewControl repo={repo} onUpdate={onUpdate} isReadOnly={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Images' }));

    expect(onUpdate).not.toHaveBeenCalled();
  });
});

it('shows conservative auto fallback and saves the repository override', () => {
  const onUpdate = vi.fn();
  const { rerender } = render(<RepositoryVisualPreviewControl repo={repo} onUpdate={onUpdate} isReadOnly={false} />);
  expect(screen.getByRole('combobox')).toHaveValue('auto');
  expect(screen.getByRole('status')).toHaveTextContent('Auto unresolved; using conservative Free limits. Images: 10 MiB; videos: 10 MiB.');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'paid' } });
  expect(onUpdate).toHaveBeenLastCalledWith(repo.id, expect.objectContaining({ githubAttachmentPlan: 'paid' }));
  rerender(<RepositoryVisualPreviewControl repo={{ ...repo, visualPreview: { ...repo.visualPreview!, githubAttachmentPlan: 'paid' } }} onUpdate={onUpdate} isReadOnly={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('Paid (repository override). Images: 10 MiB; videos: 100 MiB.');
});

it('shows detected paid capacity and lets Free override that detection', async () => {
  const { resolveGitHubAttachmentCapacity } = await import('@propr/shared');
  const visualPreview = { ...repo.visualPreview!, githubAttachmentPlan: 'auto' as const, githubAttachmentCapacity: resolveGitHubAttachmentCapacity('auto', 'paid') };
  const { rerender } = render(<RepositoryVisualPreviewControl repo={{ ...repo, visualPreview }} onUpdate={vi.fn()} isReadOnly={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('Paid (detected). Images: 10 MiB; videos: 100 MiB.');
  rerender(<RepositoryVisualPreviewControl repo={{ ...repo, visualPreview: { ...visualPreview, githubAttachmentPlan: 'free' } }} onUpdate={vi.fn()} isReadOnly={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('Free (repository override). Images: 10 MiB; videos: 10 MiB.');
});
