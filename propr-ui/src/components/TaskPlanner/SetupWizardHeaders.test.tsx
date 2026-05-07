import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditModeHeader, NewModeHeader } from './SetupWizardHeaders';

const duplicateRepos = [
  { name: 'integry/propr', enabled: true, baseBranch: 'main' },
  { name: 'integry/propr', enabled: true, baseBranch: 'develop' },
];

describe('SetupWizardHeaders', () => {
  it('renders the resolved branch as read-only metadata in new mode', () => {
    render(
      <NewModeHeader
        reposLoading={false}
        selectedRepo="integry/propr"
        selectedBaseBranch="develop"
        repos={duplicateRepos}
        onRepoChange={vi.fn()}
        baseBranch="develop"
        isLoadingBranches={false}
      />
    );

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Filter branches...')).not.toBeInTheDocument();
    expect(screen.getByText('develop')).toBeInTheDocument();
    expect(screen.getByText('develop').closest('[title]')).toHaveAttribute(
      'title',
      'develop\n\nPlanner Studio uses the repository entry\'s configured branch. To plan against a different branch, add the repository again in Repositories with that branch.'
    );
  });

  it('preserves duplicate repository selections by configured baseBranch in edit mode', () => {
    const onRepoChange = vi.fn();

    render(
      <EditModeHeader
        repository="integry/propr"
        isRepoLoading={false}
        baseBranch="develop"
        selectedBaseBranch="develop"
        branchError={null}
        repoError={null}
        repos={duplicateRepos}
        onRepoChange={onRepoChange}
        reposLoading={false}
      />
    );

    const trigger = screen.getByRole('button', { name: /propr \(develop\)/i });
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const mainOption = screen.getAllByTestId('repo-item').find((item) => item.textContent?.includes('(main)'));
    expect(mainOption).toBeDefined();
    fireEvent.click(mainOption!);

    expect(onRepoChange).toHaveBeenCalledWith('integry/propr', expect.objectContaining({
      baseBranch: 'main',
      option: expect.objectContaining({ name: 'integry/propr', baseBranch: 'main' }),
    }));
  });

  it('does not synthesize a configured branch entry for an inferred default branch in edit mode', () => {
    render(
      <EditModeHeader
        repository="integry/propr"
        isRepoLoading={false}
        baseBranch="main"
        selectedBaseBranch="main"
        configuredBaseBranch={undefined}
        branchError={null}
        repoError={null}
        repos={[{ name: 'integry/propr', enabled: true }]}
        onRepoChange={vi.fn()}
        reposLoading={false}
      />
    );

    expect(screen.getByRole('button', { name: /propr$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /propr \(main\)/i })).not.toBeInTheDocument();
  });

  it('shows branch lookup failures in new mode', () => {
    render(
      <NewModeHeader
        reposLoading={false}
        selectedRepo="integry/propr"
        selectedBaseBranch=""
        repos={duplicateRepos}
        onRepoChange={vi.fn()}
        baseBranch=""
        isLoadingBranches={false}
        branchError="GitHub unavailable"
      />
    );

    expect(screen.getByText('GitHub unavailable')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });
});
