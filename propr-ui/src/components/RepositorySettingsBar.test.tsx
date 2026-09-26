import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { MonitoredRepo } from '../api/proprApi';
import { RepositorySettingsBar } from './RepositorySettingsBar';

const repo: MonitoredRepo = {
  id: 'repo-1',
  name: 'integry/propr',
  enabled: true,
  visualPreview: { enabled: false, types: ['image'] }
};

function renderBar(overrides: Partial<MonitoredRepo> = {}, isReadOnly = false) {
  const onToggleCancelCiDuringFollowup = vi.fn();
  const onUpdateCancelCiWorkflows = vi.fn();
  render(
    <MemoryRouter>
      <RepositorySettingsBar
        repo={{ ...repo, ...overrides }}
        indexingStatus={undefined}
        onToggle={vi.fn()}
        onRemove={vi.fn()}
        onStopIndexing={vi.fn()}
        onReindex={vi.fn()}
        onToggleStar={vi.fn()}
        onToggleHidden={vi.fn()}
        onToggleAutoCiFollowup={vi.fn()}
        onToggleCancelCiDuringFollowup={onToggleCancelCiDuringFollowup}
        onUpdateCancelCiWorkflows={onUpdateCancelCiWorkflows}
        onToggleNotifications={vi.fn()}
        onUpdateVisualPreview={vi.fn()}
        isReadOnly={isReadOnly}
      />
    </MemoryRouter>
  );
  return { onToggleCancelCiDuringFollowup, onUpdateCancelCiWorkflows };
}

const controlName = 'Cancel CI during follow-up implementation for integry/propr';
const workflowsName = 'Validation workflows to cancel for integry/propr';

describe('RepositorySettingsBar follow-up CI cancellation', () => {
  it('renders the option off by default with helper text about restarting checks', () => {
    renderBar();

    const toggle = screen.getByRole('checkbox', { name: controlName });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Cancel CI while follow-up implementation is in progress')).toBeInTheDocument();
    expect(screen.getByText(/Only the validation workflows you select below are cancelled/)).toBeInTheDocument();
    expect(screen.getByText(/If you select nothing here, the instance-wide/)).toBeInTheDocument();
    expect(screen.getByText(/Checks start again on the new commit, or resume on the current one if no commit is produced\./)).toBeInTheDocument();
    // The selection belongs to the enabled option; nothing to select while it is off.
    expect(screen.queryByRole('textbox', { name: workflowsName })).not.toBeInTheDocument();
  });

  it('asks for a selection and discloses the instance fallback while the enabled option selects nothing', () => {
    renderBar({ cancelCiDuringFollowup: true });

    expect(screen.getByRole('textbox', { name: workflowsName })).toHaveValue('');
    // Clearing the selection hands the decision to the environment fallback, so
    // the empty state must not promise that nothing is cancelled.
    expect(screen.getByText(/No workflows selected for this repository, so the instance-wide/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is cancelled when your operator left it unset/)).toBeInTheDocument();
    expect(screen.getAllByText('CANCEL_CI_FOLLOWUP_WORKFLOWS').length).toBeGreaterThan(0);
    expect(screen.getByText('pr-build-check.yml')).toBeInTheDocument();
  });

  it('shows the selected workflows and reports an edited selection as exact identities', () => {
    const { onUpdateCancelCiWorkflows } = renderBar({
      cancelCiDuringFollowup: true,
      cancelCiDuringFollowupWorkflows: ['pr-build-check.yml', 'Full Test Suite']
    });

    const input = screen.getByRole('textbox', { name: workflowsName });
    expect(input).toHaveValue('pr-build-check.yml, Full Test Suite');
    expect(screen.getByText(/Cancels exactly these 2 workflows: pr-build-check\.yml, Full Test Suite\./)).toBeInTheDocument();
    expect(screen.getByText(/A workflow that is not listed is never cancelled/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: ' pr-build-check.yml , .github/workflows/pr-test-on-label.yml, PR-BUILD-CHECK.YML ' } });
    fireEvent.blur(input);
    expect(onUpdateCancelCiWorkflows).toHaveBeenCalledWith('repo-1', ['pr-build-check.yml', '.github/workflows/pr-test-on-label.yml']);
  });

  it('does not report a selection that did not change', () => {
    const { onUpdateCancelCiWorkflows } = renderBar({
      cancelCiDuringFollowup: true,
      cancelCiDuringFollowupWorkflows: ['pr-build-check.yml']
    });

    const input = screen.getByRole('textbox', { name: workflowsName });
    fireEvent.change(input, { target: { value: 'pr-build-check.yml ' } });
    fireEvent.blur(input);
    expect(onUpdateCancelCiWorkflows).not.toHaveBeenCalled();
  });

  it('preserves comma-containing names on unchanged blur and when editing another selection', () => {
    const { onUpdateCancelCiWorkflows } = renderBar({
      cancelCiDuringFollowup: true,
      cancelCiDuringFollowupWorkflows: ['Build, Test', 'Lint "strict"']
    });
    const input = screen.getByRole('textbox', { name: workflowsName });
    expect(input).toHaveValue('"Build, Test", "Lint ""strict"""');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onUpdateCancelCiWorkflows).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '"Build, Test", "Lint ""strict""", docs.yml' } });
    fireEvent.blur(input);
    expect(onUpdateCancelCiWorkflows).toHaveBeenCalledWith('repo-1', ['Build, Test', 'Lint "strict"', 'docs.yml']);
  });

  it('does not save incomplete quoted input', () => {
    const { onUpdateCancelCiWorkflows } = renderBar({ cancelCiDuringFollowup: true });
    const input = screen.getByRole('textbox', { name: workflowsName });
    fireEvent.change(input, { target: { value: '"Build, Test' } });
    fireEvent.blur(input);
    expect(onUpdateCancelCiWorkflows).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Changes have not been saved');
  });

  it('reflects the stored value and reports a toggle', () => {
    const { onToggleCancelCiDuringFollowup } = renderBar({ cancelCiDuringFollowup: true });

    const toggle = screen.getByRole('checkbox', { name: controlName });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(onToggleCancelCiDuringFollowup).toHaveBeenCalledWith('repo-1');
  });

  it('hides the option for viewers who cannot manage repositories', () => {
    renderBar({ cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['pr-build-check.yml'] }, true);

    expect(screen.queryByRole('checkbox', { name: controlName })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: workflowsName })).not.toBeInTheDocument();
  });
});
