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
