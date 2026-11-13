import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MonitoredRepo } from '../api/proprApi';
import { RepositoryPrStatusControl } from './RepositoryPrStatusControl';

const repo: MonitoredRepo = { id: 'repo-1', name: 'integry/propr', enabled: true };
const name = 'Show the ProPR status in pull requests for integry/propr';

describe('RepositoryPrStatusControl', () => {
  it('is off by default and toggles the repository', () => {
    const onToggle = vi.fn();
    render(<RepositoryPrStatusControl repo={repo} onToggle={onToggle} isReadOnly={false} />);
    const toggle = screen.getByRole('checkbox', { name }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith('repo-1');
  });

  it('shows the stored value and does nothing when read-only', () => {
    const onToggle = vi.fn();
    render(<RepositoryPrStatusControl repo={{ ...repo, prStatusDisplay: true }} onToggle={onToggle} isReadOnly />);
    const toggle = screen.getByRole('checkbox', { name }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
