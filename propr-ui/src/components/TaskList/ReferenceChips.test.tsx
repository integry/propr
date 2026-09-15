import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskReferenceChips } from './ReferenceChips';
import type { Task } from './types';

const base: Task = { id: 'abcdef123456', status: 'completed', createdAt: '2026-09-15T10:00:00Z' };

describe('TaskReferenceChips', () => {
  it('prefixes entities and never repeats a PR number as an issue', () => {
    render(<TaskReferenceChips task={{ ...base, issueNumber: 2393, prNumber: 2393 }} prNumber={2393} />);
    expect(screen.getByText('PR #2393')).toBeInTheDocument();
    expect(screen.queryByText(/Issue #/)).not.toBeInTheDocument();
  });

  it('shows the linked issue when it differs from the PR', () => {
    render(<TaskReferenceChips task={{ ...base, issueNumber: 2393, prNumber: 2393, linkedIssueNumber: 2380 }} prNumber={2393} />);
    expect(screen.getByText('PR #2393')).toBeInTheDocument();
    expect(screen.getByText('Issue #2380')).toBeInTheDocument();
  });

  it('falls back to the task id chip and uses the neutral mono chip style', () => {
    render(<TaskReferenceChips task={base} prNumber={null} />);
    const chip = screen.getByText('#abcdef12');
    expect(chip.className).toContain('font-mono');
    expect(chip.className).toContain('bg-slate-100');
    expect(chip.className).toContain('rounded-sm');
  });
});
