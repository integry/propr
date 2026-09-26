import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRepoBranches } from '../api/proprApi';
import { AddRepositoryModal } from './AddRepositoryModal';

vi.mock('../api/proprApi', () => ({
  getRepoBranches: vi.fn(),
}));

const branches = vi.mocked(getRepoBranches);

function renderModal(overrides: Partial<React.ComponentProps<typeof AddRepositoryModal>> = {}) {
  const props: React.ComponentProps<typeof AddRepositoryModal> = {
    isOpen: true,
    newRepo: '',
    newAlias: '',
    newBaseBranch: '',
    autoFollowupOnFailedCi: false,
    visualPreview: { enabled: false, types: ['image'] },
    availableRepos: ['integry/propr'],
    onRepoChange: vi.fn(),
    onAliasChange: vi.fn(),
    onBaseBranchChange: vi.fn(),
    onAutoFollowupOnFailedCiChange: vi.fn(),
    onVisualPreviewChange: vi.fn(),
    onAdd: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<AddRepositoryModal {...props} />) };
}

describe('AddRepositoryModal', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('exposes one labelled dialog with reachable header and form actions', () => {
    const { props } = renderModal();

    expect(screen.getByRole('dialog', { name: 'Add Repository' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Repository *')).toHaveFocus();
    expect(screen.getByLabelText('Alias (optional)')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Base Branch (optional)' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Automatic CI follow-up/ })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /Visual previews/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add Repository' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Close Add Repository' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps branch selection in the scroll-owned form and submits through one form path', async () => {
    branches.mockResolvedValue({
      branches: ['main', 'release/2026.09'],
      defaultBranch: 'main',
    });
    const onAdd = vi.fn();
    const onBaseBranchChange = vi.fn();
    const { rerender } = renderModal({
      newRepo: 'integry/propr',
      onAdd,
      onBaseBranchChange,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Base Branch (optional)' }));
    expect(screen.getByRole('combobox', { name: 'Base Branch (optional)' })).toHaveFocus();
    const releaseBranch = await screen.findByRole('option', { name: 'release/2026.09' });
    expect(releaseBranch.closest('[data-testid="add-repository-modal-body"]')).not.toBeNull();
    fireEvent.click(releaseBranch);
    expect(onBaseBranchChange).toHaveBeenCalledOnce();
    expect(onBaseBranchChange).toHaveBeenCalledWith('release/2026.09');

    rerender(<AddRepositoryModal
      isOpen
      newRepo="integry/propr"
      newAlias="Production"
      newBaseBranch="release/2026.09"
      autoFollowupOnFailedCi
      visualPreview={{ enabled: true, types: ['image'] }}
      availableRepos={['integry/propr']}
      onRepoChange={vi.fn()}
      onAliasChange={vi.fn()}
      onBaseBranchChange={onBaseBranchChange}
      onAutoFollowupOnFailedCiChange={vi.fn()}
      onVisualPreviewChange={vi.fn()}
      onAdd={onAdd}
      onClose={vi.fn()}
    />);

    const submit = screen.getByRole('button', { name: 'Add Repository' });
    expect(submit).toHaveAttribute('type', 'submit');
    fireEvent.click(submit);
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
  });

  it('reports visual preview selection changes', () => {
    const onVisualPreviewChange = vi.fn();
    renderModal({ onVisualPreviewChange });

    expect(screen.queryByRole('button', { name: 'Images' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview instructions (optional)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Visual previews/ }));
    expect(onVisualPreviewChange).toHaveBeenCalledWith({ enabled: true, types: ['image'] });
  });

  it('shows preview types and instructions once visual previews are enabled', () => {
    const onVisualPreviewChange = vi.fn();
    renderModal({ visualPreview: { enabled: true, types: ['image'] }, onVisualPreviewChange });

    expect(screen.getByRole('button', { name: 'Images' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Videos' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Images' }));
    expect(onVisualPreviewChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Videos' }));
    expect(onVisualPreviewChange).toHaveBeenLastCalledWith({ enabled: true, types: ['image', 'video'] });

    fireEvent.change(screen.getByLabelText('Preview instructions (optional)'), { target: { value: 'Capture mobile.' } });
    expect(onVisualPreviewChange).toHaveBeenLastCalledWith({ enabled: true, types: ['image'], instructions: 'Capture mobile.' });
  });

  it('preserves read-only permissions for every mutating control', () => {
    const { props } = renderModal({
      newRepo: 'integry/propr',
      isReadOnly: true,
    });

    expect(screen.getByLabelText('Repository *')).toBeDisabled();
    expect(screen.getByLabelText('Alias (optional)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Base Branch (optional)' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Automatic CI follow-up/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Visual previews/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Repository' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', { name: 'Add Repository' }).closest('form')!);
    expect(props.onAdd).not.toHaveBeenCalled();
  });
});
