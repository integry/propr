import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionServerForm } from './ExtensionServerForm';
import { ExtensionSkillForm } from './ExtensionSkillForm';
import { PICKER_FILTER_THRESHOLD } from './ExtensionItemPicker';
import { listGithubSkillRefs, resolveGithubSkillRef } from '../../../api/extensionProfilesApi';

vi.mock('../../../api/extensionProfilesApi', () => ({
  discoverExtensionTools: vi.fn(), listGithubSkillRefs: vi.fn(), resolveGithubSkillRef: vi.fn(), importGithubSkill: vi.fn(), importArchiveSkill: vi.fn(),
  checkExtensionOAuth: vi.fn(), resolveExtensionPackage: vi.fn(),
}));

const choices = { agents: ['claude-main'], codexAgents: [], repositories: ['example/docs'], unavailable: false };
const commit = '0123456789abcdef0123456789abcdef01234567';

const serverForm = (props: Partial<Parameters<typeof ExtensionServerForm>[0]> = {}) => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(<ExtensionServerForm servers={[]} catalog={[]} choices={choices} onSave={onSave} onCancel={onCancel} {...props} />);
  return { form: screen.getByTestId('extension-server-form'), onSave, onCancel };
};
const skillForm = (repositories = choices.repositories) => {
  const onCancel = vi.fn();
  render(<ExtensionSkillForm available={[]} choices={{ ...choices, repositories }} onImported={() => {}} onSave={vi.fn()} onCancel={onCancel} />);
  const form = screen.getByTestId('extension-skill-form');
  fireEvent.click(within(form).getByText('Import from an authorized GitHub repository'));
  return { form, onCancel };
};

describe('Add server validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps Add server and Discover tools disabled until the name and HTTPS endpoint are valid', () => {
    const { form, onSave } = serverForm();
    const add = within(form).getByRole('button', { name: 'Add server' });
    const discover = within(form).getByRole('button', { name: 'Discover tools' });
    const name = within(form).getByLabelText(/^Server name/);
    const url = within(form).getByLabelText('HTTPS endpoint');
    expect(add).toBeDisabled();
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.submit(form);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(url, { target: { value: 'http://tools.example.com/mcp' } });
    expect(discover).toBeDisabled();
    fireEvent.change(name, { target: { value: 'x'.repeat(2000) } });
    expect(add).toBeDisabled();
    fireEvent.change(name, { target: { value: 'docs search' } });
    expect(add).toBeDisabled();
    fireEvent.change(name, { target: { value: 'docs' } });
    expect(add).toBeDisabled();
    fireEvent.change(url, { target: { value: 'https://tools.example.com/mcp' } });
    expect(discover).toBeEnabled();
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'docs', url: 'https://tools.example.com/mcp' }), {}, []);
  });

  it('shows a field’s problem once the user leaves it', () => {
    const { form } = serverForm();
    const name = within(form).getByLabelText(/^Server name/);
    const url = within(form).getByLabelText('HTTPS endpoint');
    fireEvent.change(name, { target: { value: 'Docs Search' } });
    expect(name).toHaveAttribute('aria-invalid', 'false');
    fireEvent.blur(name);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByRole('alert')).toHaveTextContent('Start with a lowercase letter.');
    fireEvent.change(url, { target: { value: 'http://tools.example.com/mcp' } });
    fireEvent.blur(url);
    expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getAllByRole('alert').map(alert => alert.textContent)).toContain('Use an https:// address.');
    fireEvent.change(name, { target: { value: 'docs' } });
    expect(name).toHaveAttribute('aria-invalid', 'false');
  });

  it('refuses a name another server already has', () => {
    const docs = { kind: 'https' as const, name: 'docs', url: 'https://a.example.com/mcp', enabled: true, tools: [], capability: 'read' as const, authentication: 'none' as const, repositories: [], agents: [], autoApply: true };
    const { form } = serverForm({ servers: [docs] });
    const name = within(form).getByLabelText(/^Server name/);
    fireEvent.change(name, { target: { value: 'docs' } });
    fireEvent.blur(name);
    expect(within(form).getByRole('alert')).toHaveTextContent('Another server is already named docs.');
  });

  it('labels the access, sign-in and package controls in plain words', () => {
    const { form } = serverForm();
    expect(within(form).getByLabelText('Access')).toHaveDisplayValue('Read');
    expect(within(form).getByRole('option', { name: 'Write (must be allowed per task)' })).toBeInTheDocument();
    expect(form).toHaveTextContent('Lists the server’s tools. No credentials are sent.');
    fireEvent.change(within(form).getByLabelText('Authentication'), { target: { value: 'oauth' } });
    expect(within(form).getByRole('button', { name: 'Check sign-in' })).toBeDisabled();
    expect(within(form).getByLabelText(/^Scopes/)).toBeInTheDocument();
    expect(form).toHaveTextContent('Scopes (optional, space-separated)');
    fireEvent.change(within(form).getByLabelText('Server type'), { target: { value: '__package' } });
    expect(within(form).getByRole('button', { name: 'Check package' })).toBeInTheDocument();
    expect(within(form).getByTestId('extension-package-registry')).toHaveTextContent('npm');
    expect(form).not.toHaveTextContent('Changing the version later');
    expect(within(form).queryByRole('button', { name: 'Check' })).toBeNull();
  });

  it('names each disclosure for typed values after what it adds', () => {
    const { form } = serverForm();
    fireEvent.click(within(form).getByText('Advanced'));
    for (const label of ['Other tool', 'Other repository (owner/name)', 'Other agent']) expect(within(form).getByText(label, { selector: 'summary' })).toBeInTheDocument();
    expect(form).not.toHaveTextContent('Add an unlisted value');
    const repository = within(form).getByLabelText('Other repository (owner/name)');
    fireEvent.change(repository, { target: { value: 'not a repo' } });
    const add = within(repository.closest('details')!).getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    fireEvent.change(repository, { target: { value: 'acme/website' } });
    fireEvent.click(add);
    expect(within(form).getByLabelText('acme/website', { exact: true })).toBeChecked();
  });

  it('filters a long repository list and shows whole rows only', () => {
    const many = Array.from({ length: 26 }, (_, i) => `acme/repo-${String(i).padStart(2, '0')}`);
    serverForm({ choices: { ...choices, repositories: many } });
    const picker = screen.getByRole('group', { name: 'Limit to repositories' });
    expect(PICKER_FILTER_THRESHOLD).toBe(10);
    const filter = within(picker).getByLabelText('Filter limit to repositories');
    fireEvent.change(filter, { target: { value: 'repo-2' } });
    expect(within(picker).getAllByRole('checkbox').map(box => box.closest('label')?.textContent)).toEqual(['acme/repo-20', 'acme/repo-21', 'acme/repo-22', 'acme/repo-23', 'acme/repo-24', 'acme/repo-25']);
    // A fixed row height and a box exactly eight rows tall keep rows whole.
    const list = within(picker).getByTestId('extension-item-picker-list');
    expect(list).toHaveClass('max-h-[calc(16rem+2px)]');
    for (const row of list.querySelectorAll('label')) expect(row).toHaveClass('h-8');
  });

  it('a short list has no filter', () => {
    serverForm();
    expect(screen.queryByLabelText('Filter limit to repositories')).toBeNull();
  });

  it('Escape closes an untouched form at once', () => {
    const { form, onCancel } = serverForm();
    fireEvent.keyDown(within(form).getByLabelText(/^Server name/), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('asks before discarding typed content on Escape, Cancel or leaving through a link', () => {
    const { form, onCancel } = serverForm();
    fireEvent.change(within(form).getByLabelText('HTTPS endpoint'), { target: { value: 'https://tools.example.com/mcp' } });
    fireEvent.keyDown(within(form).getByLabelText('HTTPS endpoint'), { key: 'Escape' });
    const dialog = screen.getByRole('dialog', { name: 'Discard changes?' });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(form).getByLabelText('HTTPS endpoint')).toHaveValue('https://tools.example.com/mcp');

    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    const link = document.createElement('a');
    link.href = '/tasks'; link.textContent = 'Tasks';
    const followed = vi.fn((event: MouseEvent) => event.preventDefault());
    link.addEventListener('click', followed);
    document.body.append(link);
    fireEvent.click(link);
    expect(followed).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard' }));
    expect(followed).toHaveBeenCalledTimes(1);
    link.remove();
  });

  it('keeps the actions in a footer that sticks to the bottom on a phone', () => {
    const { form } = serverForm();
    const actions = within(form).getByTestId('extension-form-actions');
    expect(actions).toHaveClass('sticky', 'bottom-0', 'sm:static');
    expect(within(actions).getByRole('button', { name: 'Add server' })).toBeInTheDocument();
  });
});

describe('Add skill from GitHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listGithubSkillRefs).mockResolvedValue({ refs: [{ name: 'main', ref: 'refs/heads/main', kind: 'branch' }] });
  });

  it('never calls free text a confirmed commit', async () => {
    const { form } = skillForm();
    fireEvent.change(within(form).getByLabelText('Repository'), { target: { value: 'example/docs' } });
    await waitFor(() => expect(listGithubSkillRefs).toHaveBeenCalledWith('example/docs'));
    fireEvent.click(within(form).getByText('Use an exact commit'));
    fireEvent.change(within(form).getByLabelText('Exact 40-character commit'), { target: { value: 'not-a-commit' } });
    expect(form).not.toHaveTextContent('Confirmed');
    expect(within(form).getByTestId('extension-skill-commit')).toHaveTextContent('Enter the full 40-character commit');
    expect(within(form).getByRole('button', { name: 'Import pinned skill' })).toBeDisabled();
    expect(resolveGithubSkillRef).not.toHaveBeenCalled();
  });

  it('confirms a typed commit only after the lookup verified it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let resolve!: (value: { commit: string }) => void;
      vi.mocked(resolveGithubSkillRef).mockReturnValue(new Promise(res => { resolve = res; }));
      const { form } = skillForm();
      fireEvent.change(within(form).getByLabelText('Repository'), { target: { value: 'example/docs' } });
      fireEvent.click(within(form).getByText('Use an exact commit'));
      fireEvent.change(within(form).getByLabelText('Exact 40-character commit'), { target: { value: commit } });
      expect(within(form).getByTestId('extension-skill-commit')).toHaveTextContent('Checking the commit…');
      await act(async () => { vi.advanceTimersByTime(500); });
      expect(resolveGithubSkillRef).toHaveBeenCalledWith('example/docs', commit);
      expect(form).not.toHaveTextContent('Confirmed');
      await act(async () => resolve({ commit }));
      expect(within(form).getByTestId('extension-skill-commit')).toHaveTextContent(`Confirmed import commit: ${commit}`);
      fireEvent.change(within(form).getByLabelText('Relative skill directory'), { target: { value: 'skills/review' } });
      expect(within(form).getByRole('button', { name: 'Import pinned skill' })).toBeEnabled();
    } finally { vi.useRealTimers(); }
  });

  it('refuses a commit the repository does not have', async () => {
    vi.mocked(resolveGithubSkillRef).mockRejectedValue(new Error('not found'));
    const { form } = skillForm();
    fireEvent.change(within(form).getByLabelText('Repository'), { target: { value: 'example/docs' } });
    fireEvent.click(within(form).getByText('Use an exact commit'));
    fireEvent.change(within(form).getByLabelText('Exact 40-character commit'), { target: { value: commit } });
    expect(await within(form).findByText('This commit was not found in the repository.')).toBeInTheDocument();
    expect(form).not.toHaveTextContent('Confirmed');
  });

  it('shows a typed repository as the selected option only once it is a valid owner/name', async () => {
    const { form } = skillForm([]);
    const select = within(form).getByLabelText('Repository') as HTMLSelectElement;
    const github = within(within(form).getByText('Import from an authorized GitHub repository').closest('details')!);
    fireEvent.click(github.getByText('Other repository (owner/name)', { selector: 'summary' }));
    const other = github.getByLabelText('Other repository (owner/name)');
    fireEvent.change(other, { target: { value: 'team' } });
    expect(select).toHaveValue('');
    expect(within(select).queryByRole('option', { name: 'team' })).toBeNull();
    expect(listGithubSkillRefs).not.toHaveBeenCalled();
    fireEvent.change(other, { target: { value: 'team/project' } });
    expect(select).toHaveValue('team/project');
    await waitFor(() => expect(listGithubSkillRefs).toHaveBeenCalledWith('team/project'));
  });

  it('asks before discarding typed import fields', () => {
    const { form, onCancel } = skillForm();
    fireEvent.change(within(form).getByLabelText('Relative skill directory'), { target: { value: 'skills/review' } });
    fireEvent.keyDown(within(form).getByLabelText('Relative skill directory'), { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
