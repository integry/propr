import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionLibraryRevision, ExtensionLibraryServer } from '@propr/shared';
import AgentExtensionsSection from '../AgentExtensionsSection';
import { ExtensionServerForm } from './ExtensionServerForm';
import { getExtensionLibrary, resolveExtensionPackage, saveExtensionLibrary } from '../../../api/extensionProfilesApi';

vi.mock('../../../api/extensionProfilesApi', () => ({
  getExtensionLibrary: vi.fn(), saveExtensionLibrary: vi.fn(), setExtensionItemEnabled: vi.fn(), extensionLibraryHistory: vi.fn(),
  validateExtensionLibrary: vi.fn(), importArchiveSkill: vi.fn(), importGithubSkill: vi.fn(), discoverExtensionTools: vi.fn(),
  listGithubSkillRefs: vi.fn(), resolveGithubSkillRef: vi.fn(), resolveExtensionPackage: vi.fn(),
}));
vi.mock('../../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({
  agents: [{ alias: 'claude-main', kind: 'direct', type: 'claude', enabled: true, supportedModels: [] }],
  repositories: [{ name: 'example/docs', enabled: true }],
}) }));

const integrity = `sha512-${'Q'.repeat(86)}==`;
const browser: ExtensionLibraryServer = {
  kind: 'package', name: 'browser', ecosystem: 'npm', package: '@example/browser-mcp', version: '1.4.2', integrity, enabled: true, tools: ['navigate'],
  capability: 'read', args: ['--headless'], env: [{ name: 'LOG_LEVEL', value: 'info' }], secretEnv: ['BROWSER_TOKEN'], repositories: [], agents: [], autoApply: true,
};
const library: ExtensionLibraryRevision = {
  instanceId: 'instance', revision: 3, version: 1, createdAt: 0, updatedAt: 0, auditActor: '1', servers: [browser], skills: [], skillBundles: [],
  secrets: { browser: { count: 1, configured: true, configuredEnv: ['BROWSER_TOKEN'] } },
  acknowledgements: { browser: { actor: '1', at: Date.UTC(2026, 10, 13), package: '@example/browser-mcp', version: '1.4.2', secretEnv: ['BROWSER_TOKEN'] } },
};
const choices = { agents: ['claude-main'], codexAgents: [], repositories: ['example/docs'], unavailable: false };
const newForm = () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<ExtensionServerForm servers={[]} catalog={[]} choices={choices} onSave={onSave} onCancel={() => {}} />);
  const form = screen.getByTestId('extension-server-form');
  fireEvent.change(within(form).getByLabelText('Server type'), { target: { value: '__package' } });
  return { form, onSave };
};

describe('local package servers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library, bundles: [], catalog: [] });
    vi.mocked(saveExtensionLibrary).mockImplementation(async input => ({ library: { ...library, ...input, revision: 4 } as ExtensionLibraryRevision }));
  });

  it('offers Local package next to HTTPS endpoint and saves an exact version with arguments and plain variables, without an acknowledgement', async () => {
    const { form, onSave } = newForm();
    expect(within(form).getByLabelText('Server type')).toHaveDisplayValue('Local package (npm)');
    expect(within(form).queryByLabelText('HTTPS endpoint')).toBeNull();
    expect(within(form).getByText(/PyPI packages are not supported yet/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/^Server name/), { target: { value: 'files' } });
    fireEvent.change(within(form).getByLabelText('Package'), { target: { value: '@example/files-mcp' } });
    fireEvent.change(within(form).getByLabelText(/^Exact version/), { target: { value: '2.0.1' } });
    fireEvent.change(within(form).getByLabelText(/^Arguments/), { target: { value: '--read-only\n/data' } });
    fireEvent.change(within(form).getByLabelText(/^Variables/), { target: { value: 'LOG_LEVEL=debug' } });
    fireEvent.change(within(form).getByLabelText('Tool name'), { target: { value: 'read_file' } });
    fireEvent.click(within(form).getByLabelText('Tool name').parentElement!.parentElement!.querySelector('button')!);
    // No secret variables: no warning and no acknowledgement.
    expect(within(form).queryByText(/same container as the agent/)).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [server, secrets, acknowledged] = onSave.mock.calls[0];
    expect(server).toMatchObject({ kind: 'package', name: 'files', ecosystem: 'npm', package: '@example/files-mcp', version: '2.0.1', args: ['--read-only', '/data'], env: [{ name: 'LOG_LEVEL', value: 'debug' }], secretEnv: [], tools: ['read_file'] });
    expect(server).not.toHaveProperty('url');
    expect(secrets).toEqual({});
    expect(acknowledged).toEqual([]);
  });

  it('rejects version ranges and tags and reserved variable names before saving', async () => {
    const { form, onSave } = newForm();
    fireEvent.change(within(form).getByLabelText('Package'), { target: { value: 'tool' } });
    for (const version of ['latest', '^1.2', '1.x']) {
      fireEvent.change(within(form).getByLabelText(/^Exact version/), { target: { value: version } });
      expect(within(form).getByLabelText(/^Exact version/)).toHaveAttribute('aria-invalid', 'true');
      expect(within(form).getAllByText(/Ranges and tags \(latest, \^1.2\) are not accepted/).length).toBeGreaterThan(0);
      expect(within(form).getByRole('button', { name: 'Check' })).toBeDisabled();
      fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
      expect(await within(form).findByRole('alert')).toHaveTextContent('Enter an exact version');
    }
    fireEvent.change(within(form).getByLabelText(/^Exact version/), { target: { value: '1.0.0' } });
    fireEvent.change(within(form).getByLabelText(/^Variables/), { target: { value: 'NODE_OPTIONS=--require=/tmp/x' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('NODE_OPTIONS cannot be used as a variable name');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Check shows the resolved version, integrity value and executable, and clears when the version changes', async () => {
    vi.mocked(resolveExtensionPackage).mockResolvedValue({ package: { ecosystem: 'npm', package: 'tool', version: '1.0.0', integrity, bin: 'tool-mcp', bins: ['tool', 'tool-mcp'] } });
    const { form } = newForm();
    fireEvent.change(within(form).getByLabelText('Package'), { target: { value: 'tool' } });
    fireEvent.change(within(form).getByLabelText(/^Exact version/), { target: { value: '1.0.0' } });
    fireEvent.change(within(form).getByLabelText(/^Executable/), { target: { value: 'tool-mcp' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Check' }));
    const result = await within(form).findByTestId('extension-package-check');
    expect(resolveExtensionPackage).toHaveBeenCalledWith({ ecosystem: 'npm', package: 'tool', version: '1.0.0', bin: 'tool-mcp' });
    expect(result).toHaveTextContent('tool@1.0.0');
    expect(result).toHaveTextContent('tool-mcp (of tool, tool-mcp)');
    expect(result).toHaveTextContent(integrity);
    fireEvent.change(within(form).getByLabelText(/^Exact version/), { target: { value: '1.0.1' } });
    expect(within(form).queryByTestId('extension-package-check')).toBeNull();
    vi.mocked(resolveExtensionPackage).mockRejectedValueOnce(new Error('tool@1.0.1 was not found in the npm registry'));
    fireEvent.click(within(form).getByRole('button', { name: 'Check' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('was not found');
  });

  it('a secret variable shows the container warning and cannot be saved until acknowledged; its value is write-only', async () => {
    const { form, onSave } = newForm();
    fireEvent.change(within(form).getByLabelText('Package'), { target: { value: 'tool' } });
    fireEvent.change(within(form).getByLabelText(/^Exact version/), { target: { value: '1.0.0' } });
    fireEvent.change(within(form).getByLabelText('New secret variable name'), { target: { value: 'api_token' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add secret variable' }));
    fireEvent.change(within(form).getByLabelText(/^API_TOKEN/), { target: { value: 'synthetic-secret' } });
    expect(within(form).getByLabelText(/^API_TOKEN/)).toHaveAttribute('type', 'password');
    expect(within(form).getByText(/same container as the agent/)).toHaveTextContent('narrowly scoped credential');
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Confirm that the secret values are readable inside the task container');
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(within(form).getByRole('checkbox', { name: /readable inside the task container/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [server, secrets, acknowledged] = onSave.mock.calls[0];
    expect(server.secretEnv).toEqual(['API_TOKEN']);
    expect(JSON.stringify(server)).not.toContain('synthetic-secret');
    expect(secrets).toEqual({ 'server-1/API_TOKEN': 'synthetic-secret' });
    expect(acknowledged).toEqual(['server-1']);
  });

  const openSaved = async () => {
    render(<AgentExtensionsSection />);
    const row = await screen.findByTestId('extension-server');
    fireEvent.click(within(row).getByRole('button', { name: /Edit/ }));
    return { row, form: screen.getByTestId('extension-server-form') };
  };
  const acknowledgement = (form: HTMLElement) => within(form).getByRole('checkbox', { name: /readable inside the task container/ });

  it('lists a local server as Local with its package and version; a version change needs a new explicit acknowledgement', async () => {
    const { row, form } = await openSaved();
    expect(row).toHaveTextContent('browser');
    expect(row).toHaveTextContent('Local · @example/browser-mcp@1.4.2');
    expect(row).not.toHaveTextContent('Secret variables not configured');
    expect(within(form).getByText(`Pinned integrity: ${integrity}`)).toBeInTheDocument();
    expect(within(form).getByLabelText(/^BROWSER_TOKEN/)).toHaveValue('');
    expect(within(form).getByText(/^BROWSER_TOKEN/)).toHaveTextContent('configured; write-only');
    // The saved acknowledgement covers this package, version and variables.
    expect(acknowledgement(form)).toBeChecked();
    expect(within(form).getByText(/Acknowledged by user 1/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/^Exact version/), { target: { value: '1.5.0' } });
    // The saved acknowledgement no longer covers the new version, and is not silently extended to it.
    expect(acknowledgement(form)).not.toBeChecked();
    expect(within(form).queryByText(/Acknowledged by user 1/)).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save server' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Confirm that the secret values are readable');
    expect(saveExtensionLibrary).not.toHaveBeenCalled();
    fireEvent.click(acknowledgement(form));
    fireEvent.click(within(form).getByRole('button', { name: 'Save server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledTimes(1));
    const [input, revision, secrets, acknowledgements] = vi.mocked(saveExtensionLibrary).mock.calls[0];
    expect(revision).toBe(3);
    expect(input.servers[0]).toMatchObject({ kind: 'package', version: '1.5.0', secretEnv: ['BROWSER_TOKEN'] });
    expect(secrets).toEqual({});
    expect(acknowledgements).toEqual(['browser']);
  });

  it.each([
    ['package', (form: HTMLElement) => fireEvent.change(within(form).getByLabelText(/^Package$/), { target: { value: '@example/other-mcp' } })],
    ['secret variables', (form: HTMLElement) => {
      fireEvent.change(within(form).getByLabelText('New secret variable name'), { target: { value: 'EXTRA_TOKEN' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Add secret variable' }));
    }],
    ['removed secret variable', (form: HTMLElement) => {
      fireEvent.change(within(form).getByLabelText('New secret variable name'), { target: { value: 'EXTRA_TOKEN' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Add secret variable' }));
      // Acknowledge the two-variable set, then remove the original one: the tick was for both.
      fireEvent.click(acknowledgement(form));
      fireEvent.click(within(form).getByRole('button', { name: 'Remove secret variable BROWSER_TOKEN' }));
    }],
    ['server name', (form: HTMLElement) => fireEvent.change(within(form).getByLabelText(/^Server name/), { target: { value: 'browser2' } })],
  ])('changing the %s clears the acknowledgement until it is given again', async (_label, edit) => {
    const { form } = await openSaved();
    expect(acknowledgement(form)).toBeChecked();
    edit(form);
    expect(acknowledgement(form)).not.toBeChecked();
    expect(within(form).queryByText(/Acknowledged by user 1/)).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save server' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Confirm that the secret values are readable');
    expect(saveExtensionLibrary).not.toHaveBeenCalled();
  });

  it('an edit that keeps the package, version and secret variables keeps the saved acknowledgement', async () => {
    const { form } = await openSaved();
    fireEvent.change(within(form).getByLabelText(/^Arguments/), { target: { value: '--headless\n--read-only' } });
    expect(acknowledgement(form)).toBeChecked();
    fireEvent.click(within(form).getByRole('button', { name: 'Save server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveExtensionLibrary).mock.calls[0][0].servers[0]).toMatchObject({ args: ['--headless', '--read-only'] });
  });

  it('warns on the row when a secret variable has no value', async () => {
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library: { ...library, secrets: { browser: { count: 1, configured: false, configuredEnv: [] } } }, bundles: [], catalog: [] });
    render(<AgentExtensionsSection />);
    expect(await screen.findByTestId('extension-server')).toHaveTextContent('Secret variables not configured');
  });
});
