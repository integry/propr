import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionLibraryRevision, ExtensionLibraryServer } from '@propr/shared';
import AgentExtensionsSection from '../AgentExtensionsSection';
import { getExtensionLibrary, saveExtensionLibrary } from '../../../api/extensionProfilesApi';
import { listPlugins } from '../../../api/pluginsApi';

vi.mock('../../../api/extensionProfilesApi', () => ({
  getExtensionLibrary: vi.fn(), saveExtensionLibrary: vi.fn(), setExtensionItemEnabled: vi.fn(), extensionLibraryHistory: vi.fn(),
  validateExtensionLibrary: vi.fn(), importArchiveSkill: vi.fn(), importGithubSkill: vi.fn(), discoverExtensionTools: vi.fn(),
  listGithubSkillRefs: vi.fn(), resolveGithubSkillRef: vi.fn(), resolveExtensionPackage: vi.fn(),
}));
vi.mock('../../../api/pluginsApi', () => ({ listPlugins: vi.fn() }));
vi.mock('../../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({
  agents: [{ alias: 'claude-main', kind: 'direct', type: 'claude', enabled: true, supportedModels: [] }],
  repositories: [{ name: 'example/docs', enabled: true }],
}) }));

const integrity = `sha512-${'Q'.repeat(86)}==`;
const managedBy = { plugin: 'example-pack', item: 'example-local', active: true };
const local: ExtensionLibraryServer = {
  kind: 'package', name: 'example-local', ecosystem: 'npm', package: 'propr-fixture-mcp', version: '1.0.0', integrity, bin: 'propr-fixture-mcp', enabled: true,
  tools: ['echo', 'secret_length'], capability: 'read', args: ['--quiet'], env: [{ name: 'FIXTURE_GREETING', value: 'hello' }], secretEnv: ['FIXTURE_TOKEN'],
  repositories: [], agents: [], autoApply: true, managedBy,
};
const own: ExtensionLibraryServer = { kind: 'https', name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search'], capability: 'read', authentication: 'none', repositories: [], agents: [], autoApply: true };
const bundleId = '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e';
const bundle = { id: bundleId, instanceId: 'instance', name: 'example-notes', digest: 'd'.repeat(64), files: 1, bytes: 512, source: { kind: 'plugin' as const, plugin: 'example-pack', version: '0.1.0', path: 'skills/example-notes' }, requirements: [], createdAt: 0, auditActor: '1' };
const library: ExtensionLibraryRevision = {
  instanceId: 'instance', revision: 3, version: 1, createdAt: 0, updatedAt: 0, auditActor: '1', servers: [local, own],
  skills: [{ bundleId, enabled: true, repositories: [], agents: [], autoApply: true, managedBy: { plugin: 'example-pack', item: 'example-notes', active: true } }],
  skillBundles: [bundle], secrets: {},
};

const section = async () => {
  render(<MemoryRouter><AgentExtensionsSection /></MemoryRouter>);
  await screen.findByText(/Revision 3/);
  return screen.getByRole('region', { name: 'Skills & MCP servers' });
};

describe('managed library items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library, bundles: [], catalog: [] });
    vi.mocked(saveExtensionLibrary).mockImplementation(async input => ({ library: { ...library, ...input, revision: 4 } as ExtensionLibraryRevision }));
    vi.mocked(listPlugins).mockResolvedValue({ plugins: [{ id: 'example-pack', manifest: { name: 'Example pack' } }] } as never);
  });

  it('badges servers and skills a plugin contributes with the plugin name, linking to the plugin, and offers no removal', async () => {
    const view = await section();
    const [server, ownServer] = within(view).getAllByTestId('extension-server');
    const link = await within(server).findByRole('link', { name: 'From plugin: Example pack' });
    expect(link).toHaveAttribute('href', '/plugins/example-pack');
    expect(within(within(view).getByTestId('extension-skill')).getByRole('link', { name: 'From plugin: Example pack' })).toHaveAttribute('href', '/plugins/example-pack');
    expect(within(server).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(server).getByRole('button', { name: 'Edit limits' })).toBeEnabled();
    expect(within(server).getByRole('checkbox', { name: 'Enabled: example-local' })).toBeEnabled();
    expect(within(ownServer).queryByTestId('extension-managed-badge')).toBeNull();
    expect(within(ownServer).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('shows a managed package server definition read-only and saves only its limits and automatic apply', async () => {
    const view = await section();
    fireEvent.click(within(within(view).getAllByTestId('extension-server')[0]).getByRole('button', { name: 'Edit limits' }));
    const form = within(view).getByTestId('extension-server-form');
    const definition = within(form).getByTestId('extension-managed-definition');
    expect(definition).toHaveTextContent('Packagepropr-fixture-mcp');
    expect(definition).toHaveTextContent('Exact version1.0.0');
    expect(definition).toHaveTextContent('Arguments--quiet');
    expect(definition).toHaveTextContent('VariablesFIXTURE_GREETING=hello');
    expect(definition).toHaveTextContent('Secret variablesFIXTURE_TOKEN');
    // No definition field can be edited: only the limits and automatic apply are form controls.
    expect(within(form).queryByLabelText(/^Server name/)).toBeNull();
    expect(within(form).queryByLabelText('Package')).toBeNull();
    expect(within(form).queryByLabelText(/^Exact version/)).toBeNull();
    expect(within(form).queryByLabelText(/^Arguments/)).toBeNull();
    expect(within(form).queryAllByRole('textbox').map(input => input.getAttribute('aria-label') ?? input.closest('label')?.textContent)).toEqual([
      expect.stringMatching(/Unlisted repository/), expect.stringMatching(/Unlisted agent alias/),
    ]);
    fireEvent.click(within(form).getByLabelText('example/docs', { exact: true }));
    fireEvent.click(within(form).getByRole('checkbox', { name: /Apply automatically/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledTimes(1));
    const [input] = vi.mocked(saveExtensionLibrary).mock.calls[0];
    expect(input.servers[0]).toEqual({ ...local, repositories: ['example/docs'], autoApply: false });
  });

  it('edits only the limits of a managed skill and says where its definition comes from', async () => {
    const view = await section();
    fireEvent.click(within(within(view).getByTestId('extension-skill')).getByRole('button', { name: 'Edit limits' }));
    const form = within(view).getByTestId('extension-skill-form');
    expect(within(form).getByTestId('extension-managed-note')).toHaveTextContent('Its definition comes from the plugin and is read-only here');
    expect(within(form).queryByRole('button', { name: 'Choose another bundle' })).toBeNull();
  });
});
