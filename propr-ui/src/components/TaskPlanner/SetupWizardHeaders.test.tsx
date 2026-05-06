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
});
