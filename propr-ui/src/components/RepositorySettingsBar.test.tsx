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
  const onUpdateNonBlockingChecks = vi.fn();
  const { unmount } = render(
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
        onUpdateNonBlockingChecks={onUpdateNonBlockingChecks}
        onToggleNotifications={vi.fn()}
        onUpdateVisualPreview={vi.fn()}
        isReadOnly={isReadOnly}
      />
    </MemoryRouter>
  );
  return { onToggleCancelCiDuringFollowup, onUpdateCancelCiWorkflows, onUpdateNonBlockingChecks, unmount };
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
    expect(screen.getByText(/also cancelled when a pull request is merged or closed/)).toBeInTheDocument();
    // The selection belongs to the enabled option; nothing to select while it is off.
    expect(screen.queryByRole('textbox', { name: workflowsName })).not.toBeInTheDocument();
  });

  it('asks for a selection and discloses the instance fallback while the enabled option selects nothing', () => {
    renderBar({ cancelCiDuringFollowup: true });

    expect(screen.getByRole('textbox', { name: workflowsName })).toBeInTheDocument();
    // Clearing the selection hands the decision to the environment fallback, so
    // the empty state must not promise that nothing is cancelled.
    expect(screen.getByText(/No workflows selected for this repository, so the instance-wide/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is cancelled when your operator left it unset/)).toBeInTheDocument();
    expect(screen.getAllByText('CANCEL_CI_FOLLOWUP_WORKFLOWS').length).toBeGreaterThan(0);
  });

  it('shows the selected workflows and reports an edited selection as exact identities', async () => {
    getRepoWorkflows.mockRejectedValue(new Error('offline'));
    const { onUpdateCancelCiWorkflows } = renderBar({
      cancelCiDuringFollowup: true,
      cancelCiDuringFollowupWorkflows: ['pr-build-check.yml', 'Full Test Suite']
    });

    const input = await screen.findByRole('textbox', { name: workflowsName });
    expect(input).toHaveValue('pr-build-check.yml, Full Test Suite');
    expect(screen.getByText(/Cancels exactly these 2 workflows: pr-build-check\.yml, Full Test Suite\./)).toBeInTheDocument();
    expect(screen.getByText(/A workflow that is not listed is never cancelled/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: ' pr-build-check.yml , .github/workflows/pr-test-on-label.yml, PR-BUILD-CHECK.YML ' } });
    fireEvent.blur(input);
    expect(onUpdateCancelCiWorkflows).toHaveBeenCalledWith('repo-1', ['pr-build-check.yml', '.github/workflows/pr-test-on-label.yml']);
  });

  it('does not report a selection that did not change', async () => {
    getRepoWorkflows.mockRejectedValue(new Error('offline'));
    const { onUpdateCancelCiWorkflows } = renderBar({
      cancelCiDuringFollowup: true,
      cancelCiDuringFollowupWorkflows: ['pr-build-check.yml']
    });

    const input = await screen.findByRole('textbox', { name: workflowsName });
    fireEvent.change(input, { target: { value: 'pr-build-check.yml ' } });
    fireEvent.blur(input);
    expect(onUpdateCancelCiWorkflows).not.toHaveBeenCalled();
  });

  it('preserves comma-containing names on unchanged blur and when editing another selection', async () => {
    getRepoWorkflows.mockRejectedValue(new Error('offline'));
    const { onUpdateCancelCiWorkflows } = renderBar({
      cancelCiDuringFollowup: true,
      cancelCiDuringFollowupWorkflows: ['Build, Test', 'Lint "strict"']
    });
    const input = await screen.findByRole('textbox', { name: workflowsName });
    expect(input).toHaveValue('"Build, Test", "Lint ""strict"""');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onUpdateCancelCiWorkflows).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '"Build, Test", "Lint ""strict""", docs.yml' } });
    fireEvent.blur(input);
    expect(onUpdateCancelCiWorkflows).toHaveBeenCalledWith('repo-1', ['Build, Test', 'Lint "strict"', 'docs.yml']);
  });

  it('does not save incomplete quoted input', async () => {
    getRepoWorkflows.mockRejectedValue(new Error('offline'));
    const { onUpdateCancelCiWorkflows } = renderBar({ cancelCiDuringFollowup: true });
    const input = await screen.findByRole('textbox', { name: workflowsName });
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
  it.each([{ triggers: ['pull_request'] }, { triggers: ['push'] }, { triggers: null }])('recognizes and deselects a padded display name with triggers $triggers', async ({ triggers }) => {
    getRepoWorkflows.mockResolvedValue({ workflows: [workflow(1, ' CI ', 'validation.yml', triggers)] });
    const { onUpdateCancelCiWorkflows } = renderBar({
      cancelCiDuringFollowup: true,
      cancelCiDuringFollowupWorkflows: ['cI'],
    });

    const checkbox = await screen.findByRole('checkbox', { name: /validation\.yml/ });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove unavailable selections' })).not.toBeInTheDocument();
    expect(onUpdateCancelCiWorkflows).not.toHaveBeenCalled();

    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole('textbox', { name: workflowsName })).toHaveValue('');
    expect(onUpdateCancelCiWorkflows).toHaveBeenLastCalledWith('repo-1', []);
  });

  it('preserves a normalized display name when removing unavailable selections after discovery', async () => {
    let resolveListing!: (response: { workflows: RepoWorkflow[] }) => void;
    getRepoWorkflows.mockReturnValue(new Promise(resolve => { resolveListing = resolve; }));
    const { onUpdateCancelCiWorkflows } = renderBar({
      cancelCiDuringFollowup: true,
      cancelCiDuringFollowupWorkflows: ['CI', 'deleted.yml'],
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => { resolveListing({ workflows: [workflow(1, ' CI ', 'validation.yml', ['pull_request'])] }); });

    expect(screen.getByRole('alert')).toHaveTextContent('Not found in this repository, so never cancelled: deleted.yml.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable selections' }));
    expect(onUpdateCancelCiWorkflows).toHaveBeenLastCalledWith('repo-1', ['CI']);
    expect(screen.getByRole('checkbox', { name: /validation\.yml/ })).toBeChecked();
    expect(screen.getByRole('textbox', { name: workflowsName })).toHaveValue('CI');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers the repository workflows and matches stored entries by any identity', async () => {
    getRepoWorkflows.mockResolvedValue({ workflows: detected });
    renderBar({ cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['Full Test Suite'] });

    const fullSuite = await screen.findByRole('checkbox', { name: /Full Test Suite/ });
    expect(getRepoWorkflows).toHaveBeenCalledWith('integry', 'propr');
    expect(fullSuite).toBeChecked();
    expect(screen.getByRole('textbox', { name: workflowsName })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Build & Lint Check/ })).not.toBeChecked();
    // Only pull request runs are cancelled, so a push-only workflow cannot be picked.
    expect(screen.getByRole('checkbox', { name: /Docker Images/ })).toBeDisabled();
  });

  it('allows manual identities outside a cached listing and keeps checkbox edits in sync', async () => {
    getRepoWorkflows.mockResolvedValue({ workflows: detected });
    const initial = renderBar({ cancelCiDuringFollowup: true });
    await screen.findByRole('checkbox', { name: /Full Test Suite/ });
    initial.unmount();

    const { onUpdateCancelCiWorkflows } = renderBar({ cancelCiDuringFollowup: true });
    const fullSuite = await screen.findByRole('checkbox', { name: /Full Test Suite/ });
    expect(getRepoWorkflows).toHaveBeenCalledTimes(1);
    const input = screen.getByRole('textbox', { name: workflowsName });
    fireEvent.change(input, { target: { value: 'Full Test Suite, new-validation.yml' } });
    fireEvent.blur(input);
    expect(onUpdateCancelCiWorkflows).toHaveBeenLastCalledWith('repo-1', ['Full Test Suite', 'new-validation.yml']);
    expect(fullSuite).toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: /Build & Lint Check/ }));
    expect(input).toHaveValue('Full Test Suite, new-validation.yml, pr-build-check.yml');
    fireEvent.click(fullSuite);
    expect(input).toHaveValue('new-validation.yml, pr-build-check.yml');
    expect(onUpdateCancelCiWorkflows).toHaveBeenLastCalledWith('repo-1', ['new-validation.yml', 'pr-build-check.yml']);
    expect(getRepoWorkflows).toHaveBeenCalledTimes(1);
  });

  it.each([['populated', detected], ['empty', []]] as const)(
    'preserves manual input across a successful %s discovery without saving it',
    async (_label, listing) => {
      let resolveListing!: (response: { workflows: readonly RepoWorkflow[] }) => void;
      getRepoWorkflows.mockReturnValue(new Promise(resolve => { resolveListing = resolve; }));
      const { onUpdateCancelCiWorkflows } = renderBar({ cancelCiDuringFollowup: true });
      const input = screen.getByRole('textbox', { name: workflowsName });
      fireEvent.change(input, { target: { value: 'new-validation.yml' } });

      await act(async () => { resolveListing({ workflows: listing }); });

      expect(screen.getByRole('textbox', { name: workflowsName })).toBe(input);
      expect(input).toHaveValue('new-validation.yml');
      expect(onUpdateCancelCiWorkflows).not.toHaveBeenCalled();
      fireEvent.blur(input);
      expect(onUpdateCancelCiWorkflows).toHaveBeenCalledWith('repo-1', ['new-validation.yml']);
    },
  );

  it('stores a picked workflow by file name and removes every spelling of an unpicked one', async () => {
    getRepoWorkflows.mockResolvedValue({ workflows: detected });
    const { onUpdateCancelCiWorkflows } = renderBar({ cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['Full Test Suite'] });

    fireEvent.click(await screen.findByRole('checkbox', { name: /Build & Lint Check/ }));
    expect(onUpdateCancelCiWorkflows).toHaveBeenLastCalledWith('repo-1', ['Full Test Suite', 'pr-build-check.yml']);
    expect(screen.getByRole('checkbox', { name: /Build & Lint Check/ })).toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: /Full Test Suite/ }));
    expect(onUpdateCancelCiWorkflows).toHaveBeenLastCalledWith('repo-1', ['pr-build-check.yml']);
  });

  it('flags stored entries that match no workflow in the repository', async () => {
    getRepoWorkflows.mockResolvedValue({ workflows: detected });
    const { onUpdateCancelCiWorkflows } = renderBar({ cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['pr-build-check.yml', 'ci.yml'] });

    expect(await screen.findByText(/Not found in this repository, so never cancelled: ci\.yml\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable selections' }));
    expect(onUpdateCancelCiWorkflows).toHaveBeenLastCalledWith('repo-1', ['pr-build-check.yml']);
    expect(screen.getByRole('checkbox', { name: /Build & Lint Check/ })).toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('flags a stored selection only after an empty listing successfully loads', async () => {
    let resolveListing!: (response: { workflows: RepoWorkflow[] }) => void;
    getRepoWorkflows.mockReturnValue(new Promise(resolve => { resolveListing = resolve; }));
    const { onUpdateCancelCiWorkflows } = renderBar({
      cancelCiDuringFollowup: true,
      cancelCiDuringFollowupWorkflows: ['ci.yml'],
    });

    expect(screen.getByText('Loading workflows from GitHub…')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: workflowsName })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => { resolveListing({ workflows: [] }); });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Not found in this repository, so never cancelled: ci.yml.',
    );
    expect(screen.queryByText('Loading workflows from GitHub…')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: workflowsName })).toBeInTheDocument();
    expect(onUpdateCancelCiWorkflows).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable selections' }));
    expect(onUpdateCancelCiWorkflows).toHaveBeenCalledWith('repo-1', []);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not flag an empty selection after an empty listing successfully loads', async () => {
    renderBar({ cancelCiDuringFollowup: true });
    await waitFor(() => expect(screen.queryByText('Loading workflows from GitHub…')).not.toBeInTheDocument());

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Workflows in integry/propr' })).not.toBeInTheDocument();
    expect(screen.getByText('No active workflow files found in this repository.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: workflowsName })).toBeInTheDocument();
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

describe('RepositorySettingsBar non-blocking checks', () => {
  const checksName = 'Checks that never block automation for integry/propr';

  it('shows the stored checks and saves an edited list on blur', () => {
    const { onUpdateNonBlockingChecks } = renderBar({ nonBlockingChecks: ['Packaged Connect*'] });
    const input = screen.getByRole('textbox', { name: checksName });
    expect(input).toHaveValue('Packaged Connect*');
    fireEvent.change(input, { target: { value: 'Packaged Connect*, Validate unsigned * package, packaged connect*' } });
    fireEvent.blur(input);
    expect(onUpdateNonBlockingChecks).toHaveBeenCalledWith('repo-1', ['Packaged Connect*', 'Validate unsigned * package']);
  });

  it('does not save unchanged or malformed input', () => {
    const { onUpdateNonBlockingChecks } = renderBar({ nonBlockingChecks: ['Packaged Connect*'] });
    const input = screen.getByRole('textbox', { name: checksName });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '"unclosed' } });
    fireEvent.blur(input);
    expect(onUpdateNonBlockingChecks).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Changes have not been saved/);
  });

  it('is hidden for read-only viewers', () => {
    renderBar({ nonBlockingChecks: ['Packaged Connect*'] }, true);
    expect(screen.queryByRole('textbox', { name: checksName })).not.toBeInTheDocument();
  });
});
