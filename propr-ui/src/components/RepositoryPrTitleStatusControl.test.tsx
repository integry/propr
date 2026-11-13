import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MonitoredRepo } from '../api/proprApi';
import { RepositoryPrTitleStatusControl } from './RepositoryPrTitleStatusControl';

const repo: MonitoredRepo = { id: 'repo-1', name: 'integry/propr', enabled: true };
const name = 'Show the PR state in pull request titles for integry/propr';

describe('RepositoryPrTitleStatusControl', () => {
  it('is on by default, says it controls the title only, and toggles the repository', () => {
    const onToggle = vi.fn();
    render(<RepositoryPrTitleStatusControl repo={repo} onToggle={onToggle} isReadOnly={false} />);
    const toggle = screen.getByRole('checkbox', { name }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(/Controls the title only/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith('repo-1');
  });

  it('shows the stored value and does nothing when read-only', () => {
    const onToggle = vi.fn();
    render(<RepositoryPrTitleStatusControl repo={{ ...repo, prTitleStatus: false }} onToggle={onToggle} isReadOnly />);
    const toggle = screen.getByRole('checkbox', { name }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
