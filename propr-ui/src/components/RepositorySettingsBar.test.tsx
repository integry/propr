import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitoredRepo } from '../api/proprApi';
import type { RepoWorkflow } from '../api/proprTypes';
import { clearRepoWorkflowsCache } from '../hooks/useRepoWorkflows';
import { RepositorySettingsBar } from './RepositorySettingsBar';

const getRepoWorkflows = vi.hoisted(() => vi.fn());
vi.mock('../api/proprApi', async (importOriginal) => ({ ...await importOriginal<object>(), getRepoWorkflows }));

beforeEach(() => {
  clearRepoWorkflowsCache();
  getRepoWorkflows.mockReset();
  getRepoWorkflows.mockResolvedValue({ workflows: [] });
});

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

const workflow = (id: number, name: string, file: string, triggers: string[] | null): RepoWorkflow => ({
  id, name, file, path: `.github/workflows/${file}`, triggers,
  pullRequest: triggers ? triggers.some(event => event === 'pull_request' || event === 'pull_request_target') : null,
});
const detected = [
  workflow(1, 'Build & Lint Check', 'pr-build-check.yml', ['pull_request']),
  workflow(2, 'Full Test Suite', 'pr-test-on-label.yml', ['pull_request', 'workflow_dispatch']),
  workflow(3, 'Docker Images', 'docker-images.yml', ['push']),
];

describe('RepositorySettingsBar detected workflows', () => {
  it('offers the repository workflows and matches stored entries by any identity', async () => {
    getRepoWorkflows.mockResolvedValue({ workflows: detected });
    renderBar({ cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['Full Test Suite'] });

    const fullSuite = await screen.findByRole('checkbox', { name: /Full Test Suite/ });
    expect(getRepoWorkflows).toHaveBeenCalledWith('integry', 'propr');
    expect(fullSuite).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Build & Lint Check/ })).not.toBeChecked();
    // Only pull request runs are cancelled, so a push-only workflow cannot be picked.
    expect(screen.getByRole('checkbox', { name: /Docker Images/ })).toBeDisabled();
  });

  it('stores a picked workflow by file name and removes every spelling of an unpicked one', async () => {
    getRepoWorkflows.mockResolvedValue({ workflows: detected });
    const { onUpdateCancelCiWorkflows } = renderBar({ cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['Full Test Suite'] });

    fireEvent.click(await screen.findByRole('checkbox', { name: /Build & Lint Check/ }));
    expect(onUpdateCancelCiWorkflows).toHaveBeenLastCalledWith('repo-1', ['Full Test Suite', 'pr-build-check.yml']);
    expect(screen.getByRole('textbox', { name: workflowsName })).toHaveValue('Full Test Suite, pr-build-check.yml');

    fireEvent.click(screen.getByRole('checkbox', { name: /Full Test Suite/ }));
    expect(onUpdateCancelCiWorkflows).toHaveBeenLastCalledWith('repo-1', ['pr-build-check.yml']);
  });

  it('flags stored entries that match no workflow in the repository', async () => {
    getRepoWorkflows.mockResolvedValue({ workflows: detected });
    renderBar({ cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['pr-build-check.yml', 'ci.yml'] });

    expect(await screen.findByText(/Not found in this repository, so never cancelled: ci\.yml\./)).toBeInTheDocument();
  });

  it('flags a stored selection only after an empty listing successfully loads', async () => {
    let resolveListing!: (response: { workflows: RepoWorkflow[] }) => void;
    getRepoWorkflows.mockReturnValue(new Promise(resolve => { resolveListing = resolve; }));
    const { onUpdateCancelCiWorkflows } = renderBar({
      cancelCiDuringFollowup: true,
      cancelCiDuringFollowupWorkflows: ['ci.yml'],
    });

    expect(screen.getByText('Loading workflows from GitHub…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => { resolveListing({ workflows: [] }); });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Not found in this repository, so never cancelled: ci.yml. Remove or correct it below.',
    );
    expect(screen.queryByText('Loading workflows from GitHub…')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: workflowsName })).toHaveValue('ci.yml');
    expect(onUpdateCancelCiWorkflows).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: workflowsName }), { target: { value: '' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not flag an empty selection after an empty listing successfully loads', async () => {
    renderBar({ cancelCiDuringFollowup: true });
    await waitFor(() => expect(screen.queryByText('Loading workflows from GitHub…')).not.toBeInTheDocument());

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Workflows in integry/propr' })).not.toBeInTheDocument();
  });

  it('falls back to typing workflows when GitHub cannot list them', async () => {
    getRepoWorkflows.mockRejectedValue(new Error('offline'));
    renderBar({ cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['ci.yml'] });

    expect(await screen.findByText(/Could not load this repository's workflows from GitHub/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: workflowsName })).toHaveValue('ci.yml');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not ask GitHub for workflows while the option is off', () => {
    renderBar();
    expect(getRepoWorkflows).not.toHaveBeenCalled();
  });
});
