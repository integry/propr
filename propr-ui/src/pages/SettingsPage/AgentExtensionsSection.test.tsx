import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionLibraryRevision } from '@propr/shared';
import AgentExtensionsSection from './AgentExtensionsSection';
import { extensionLibraryHistory, getExtensionLibrary, saveExtensionLibrary, setExtensionItemEnabled } from '../../api/extensionProfilesApi';

vi.mock('../../api/extensionProfilesApi', () => ({
  getExtensionLibrary: vi.fn(), saveExtensionLibrary: vi.fn(), setExtensionItemEnabled: vi.fn(), extensionLibraryHistory: vi.fn(),
  validateExtensionLibrary: vi.fn(), importArchiveSkill: vi.fn(), importGithubSkill: vi.fn(), discoverExtensionTools: vi.fn(),
  listGithubSkillRefs: vi.fn(), resolveGithubSkillRef: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({
  agents: [{ alias: 'claude-main', kind: 'direct', type: 'claude', enabled: true, supportedModels: [] }],
  repositories: [{ name: 'example/docs', enabled: true }],
}) }));

const bundleId = '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e';
const docs = { kind: 'https' as const, name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search'], capability: 'read' as const, authentication: 'bearer' as const, repositories: ['example/docs'], agents: [], autoApply: true };
const library: ExtensionLibraryRevision = {
  instanceId: 'instance', revision: 3, version: 1, createdAt: 0, updatedAt: 0, auditActor: '1',
  servers: [docs], skills: [{ bundleId, enabled: true, repositories: [], agents: [], autoApply: false }],
  secrets: { docs: { fields: ['bearerToken'], configured: true } },
  skillBundles: [{ id: bundleId, instanceId: 'instance', name: 'Documentation review', digest: 'd'.repeat(64), files: 2, bytes: 2048, source: { kind: 'archive', filename: 'review.tar' }, requirements: [], createdAt: 0, auditActor: '1' }],
};

const section = async () => {
  render(<AgentExtensionsSection />);
  await screen.findByText('Extension library');
  return screen.getByRole('region', { name: 'Skills & MCP servers' });
};

describe('AgentExtensionsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library, bundles: [], catalog: [] });
    vi.mocked(saveExtensionLibrary).mockImplementation(async (input) => ({ library: { ...library, ...input, revision: 4 } as ExtensionLibraryRevision }));
  });

  it('edits the one library with per-item limits and saves against the loaded revision', async () => {
    const view = await section();
    expect(within(view).getByText(/Revision 3/)).toBeInTheDocument();
    expect(within(view).queryByText(/profile/i)).toBeNull();
    expect(within(view).getAllByLabelText('example/docs', { exact: true })[0]).toBeChecked();
    fireEvent.click(within(view).getByRole('button', { name: 'Add HTTPS server' }));
    const names = within(view).getAllByLabelText('Stable server name');
    expect(names[1]).toHaveValue('server-1');
    fireEvent.change(within(view).getAllByLabelText('HTTPS endpoint')[1], { target: { value: 'https://new.example.com/mcp' } });
    const autoApply = within(view).getAllByRole('checkbox', { name: /Apply automatically/ });
    expect(autoApply.map(box => (box as HTMLInputElement).checked)).toEqual([true, true, false]);
    // Agent limits stay behind an advanced disclosure.
    expect(within(view).getAllByText('Advanced: limit to agents')).toHaveLength(3);
    fireEvent.click(within(view).getAllByLabelText('claude-main', { exact: true })[1]);
    fireEvent.click(within(view).getByRole('button', { name: 'Save library' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledTimes(1));
    const [input, expectedRevision, secrets] = vi.mocked(saveExtensionLibrary).mock.calls[0];
    expect(expectedRevision).toBe(3);
    expect(secrets).toEqual({});
    expect(input).toEqual({
      version: 1,
      servers: [docs, { kind: 'https', name: 'server-1', url: 'https://new.example.com/mcp', enabled: true, tools: [], capability: 'read', authentication: 'none', repositories: [], agents: ['claude-main'], autoApply: true }],
      skills: library.skills,
    });
    expect(await within(view).findByRole('status')).toHaveTextContent('Extension library saved.');
    expect(within(view).getByText(/Revision 4/)).toBeInTheDocument();
  });

  it('switches a saved item off through the enable endpoint without saving the draft', async () => {
    vi.mocked(setExtensionItemEnabled)
      .mockResolvedValueOnce({ library: { ...library, revision: 4, servers: [{ ...docs, enabled: false }] } })
      .mockResolvedValueOnce({ library: { ...library, revision: 5, servers: [{ ...docs, enabled: false }], skills: [{ ...library.skills[0], enabled: false }] } });
    const view = await section();
    fireEvent.change(within(view).getByLabelText('Stable server name'), { target: { value: 'docs' } });
    const enabled = within(view).getAllByRole('checkbox', { name: 'Enabled' });
    fireEvent.click(enabled[0]);
    await waitFor(() => expect(setExtensionItemEnabled).toHaveBeenCalledWith({ kind: 'server', name: 'docs' }, false));
    await waitFor(() => expect(within(view).getAllByRole('checkbox', { name: 'Enabled' })[0]).not.toBeChecked());
    fireEvent.click(within(view).getAllByRole('checkbox', { name: 'Enabled' })[1]);
    await waitFor(() => expect(setExtensionItemEnabled).toHaveBeenCalledWith({ kind: 'skill', bundleId }, false));
    expect(saveExtensionLibrary).not.toHaveBeenCalled();
    fireEvent.click(within(view).getByRole('button', { name: 'Save library' }));
    // Each toggle revision sat directly on the draft's base, so the draft is still current.
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledWith(expect.anything(), 5, {}));
  });

  it('keeps the draft base revision when a toggle reveals edits made elsewhere, so saving conflicts', async () => {
    // Another administrator saved revision 4 (narrowing the server's repositories); this toggle lands as revision 5.
    const elsewhere = { ...library, revision: 5, servers: [{ ...docs, repositories: ['example/other'] }], skills: [{ ...library.skills[0], enabled: false }] };
    vi.mocked(setExtensionItemEnabled).mockResolvedValue({ library: elsewhere });
    const view = await section();
    fireEvent.click(within(view).getAllByRole('checkbox', { name: 'Enabled' })[1]);
    await waitFor(() => expect(setExtensionItemEnabled).toHaveBeenCalledWith({ kind: 'skill', bundleId }, false));
    expect(await within(view).findByRole('status')).toHaveTextContent('changed elsewhere');
    fireEvent.click(within(view).getByRole('button', { name: 'Save library' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledTimes(1));
    // The stale draft (still holding the wider limit) is submitted against revision 3, which the server refuses.
    const [input, expectedRevision] = vi.mocked(saveExtensionLibrary).mock.calls[0];
    expect(expectedRevision).toBe(3);
    expect(input.servers[0].repositories).toEqual(['example/docs']);
  });

  it('keeps the draft base when a toggle is a no-op on a head another administrator already changed', async () => {
    // Revision 4 elsewhere disabled the server and narrowed its repositories. The stale Disable
    // writes nothing and returns that unchanged head, which is still exactly base + 1.
    const elsewhere = { ...library, revision: 4, servers: [{ ...docs, enabled: false, repositories: ['example/other'] }] };
    vi.mocked(setExtensionItemEnabled).mockResolvedValue({ library: elsewhere });
    const view = await section();
    fireEvent.click(within(view).getAllByRole('checkbox', { name: 'Enabled' })[0]);
    await waitFor(() => expect(setExtensionItemEnabled).toHaveBeenCalledWith({ kind: 'server', name: 'docs' }, false));
    expect(await within(view).findByRole('status')).toHaveTextContent('changed elsewhere');
    fireEvent.click(within(view).getByRole('button', { name: 'Save library' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledTimes(1));
    // Saving the stale draft (wider limit) is sent against revision 3, so the server refuses it.
    const [input, expectedRevision] = vi.mocked(saveExtensionLibrary).mock.calls[0];
    expect(expectedRevision).toBe(3);
    expect(input.servers[0].repositories).toEqual(['example/docs']);
  });

  it('changes a new item only in the draft', async () => {
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library: { ...library, revision: 0, servers: [], skills: [], skillBundles: [], secrets: {} }, catalog: [] });
    const view = await section();
    expect(within(view).getByText(/Not saved yet/)).toBeInTheDocument();
    expect(within(view).queryByRole('button', { name: 'Revision history' })).toBeNull();
    fireEvent.click(within(view).getByRole('button', { name: 'Add HTTPS server' }));
    fireEvent.click(within(view).getByRole('checkbox', { name: 'Enabled' }));
    expect(within(view).getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked();
    expect(setExtensionItemEnabled).not.toHaveBeenCalled();
    fireEvent.click(within(view).getByRole('button', { name: 'Save library' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledWith(expect.objectContaining({ servers: [expect.objectContaining({ enabled: false })] }), 0, {}));
  });

  it('shows why a save was refused and sends a replaced token write-only', async () => {
    vi.mocked(saveExtensionLibrary).mockRejectedValueOnce(new Error('Automations add these extensions explicitly; remove them from "Weekly" (docs) before removing or renaming them'));
    const view = await section();
    fireEvent.change(within(view).getByLabelText(/Replace bearer token/), { target: { value: 'synthetic-token' } });
    fireEvent.click(within(view).getByRole('button', { name: 'Remove server' }));
    fireEvent.click(within(view).getByRole('button', { name: 'Save library' }));
    expect(await within(view).findByRole('alert')).toHaveTextContent('"Weekly" (docs)');
    expect(vi.mocked(saveExtensionLibrary).mock.calls[0][0].servers).toEqual([]);
    vi.mocked(extensionLibraryHistory).mockResolvedValue({ revisions: [library] });
    fireEvent.click(within(view).getByRole('button', { name: 'Revision history' }));
    expect(await within(view).findByText(/Revision 3 .* administrator 1 · 1 servers · 1 skills/)).toBeInTheDocument();
  });
});
