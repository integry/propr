import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionLibraryRevision } from '@propr/shared';
import AgentExtensionsSection from './AgentExtensionsSection';
import { extensionLibraryHistory, getExtensionLibrary, importArchiveSkill, saveExtensionLibrary, setExtensionItemEnabled } from '../../api/extensionProfilesApi';

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
const newBundleId = '9c1f3d55-5b1e-4f86-9d4f-3b2a5e1c7a10';
const docs = { kind: 'https' as const, name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search'], capability: 'read' as const, authentication: 'bearer' as const, repositories: ['example/docs'], agents: [], autoApply: true };
const bundle = { id: bundleId, instanceId: 'instance', name: 'Documentation review', digest: 'd'.repeat(64), files: 2, bytes: 2048, source: { kind: 'archive' as const, filename: 'review.tar' }, requirements: [], createdAt: 0, auditActor: '1' };
const library: ExtensionLibraryRevision = {
  instanceId: 'instance', revision: 3, version: 1, createdAt: 0, updatedAt: 0, auditActor: '1',
  servers: [docs], skills: [{ bundleId, enabled: true, repositories: [], agents: [], autoApply: false }],
  secrets: { docs: { fields: ['bearerToken'], configured: true } },
  skillBundles: [bundle],
};
const usage = { automations: [{ id: 'a1', name: 'Weekly', servers: ['docs'], skills: [] }], importedFrom: { servers: {}, skills: { [bundleId]: ['Docs profile'] } } };

const section = async () => {
  render(<AgentExtensionsSection />);
  await screen.findByText(/Revision 3/);
  return screen.getByRole('region', { name: 'Skills & MCP servers' });
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('AgentExtensionsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library, bundles: [], catalog: [], usage });
    vi.mocked(saveExtensionLibrary).mockImplementation(async (input) => ({ library: { ...library, ...input, revision: 4 } as ExtensionLibraryRevision }));
  });

  it('lists servers and skills as rows with their limits, automatic use, explanation and no profile wording', async () => {
    const view = await section();
    expect(within(view).getByRole('list', { name: 'How extensions apply' })).toHaveTextContent('disable-extensions');
    const server = within(view).getByTestId('extension-server');
    expect(server).toHaveTextContent('docs');
    expect(server).toHaveTextContent('HTTPS endpoint');
    expect(server).toHaveTextContent('Read');
    expect(server).toHaveTextContent('example/docs · Applies automatically');
    expect(server).toHaveTextContent('Added by automation “Weekly”.');
    const skill = within(view).getByTestId('extension-skill');
    expect(skill).toHaveTextContent('Documentation review');
    expect(skill).toHaveTextContent('All repositories · Only where an automation adds it');
    expect(skill).toHaveTextContent('Imported from profile “Docs profile”; not applied automatically.');
    expect(within(view).getByRole('checkbox', { name: 'Enabled: docs' })).toBeChecked();
    // Only the migration note may mention profiles.
    expect(view.textContent?.replace('Imported from profile “Docs profile”', '')).not.toMatch(/profile/i);
  });

  it('adds a server in one form and saves it to the library with its limits and write-only token', async () => {
    const view = await section();
    fireEvent.click(within(view).getByRole('button', { name: 'Add server' }));
    const form = within(view).getByTestId('extension-server-form');
    expect(within(form).getByLabelText(/^Server name/)).toHaveValue('server-1');
    fireEvent.change(within(form).getByLabelText('HTTPS endpoint'), { target: { value: 'https://new.example.com/mcp' } });
    fireEvent.change(within(form).getByLabelText('Authentication'), { target: { value: 'bearer' } });
    fireEvent.change(within(form).getByLabelText(/^Bearer token/), { target: { value: 'synthetic-token' } });
    fireEvent.click(within(form).getByLabelText('example/docs', { exact: true }));
    fireEvent.click(within(form).getByRole('checkbox', { name: /Apply automatically/ }));
    fireEvent.click(within(form).getByText('Advanced'));
    fireEvent.click(within(form).getByLabelText('claude-main', { exact: true }));
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledTimes(1));
    const [input, expectedRevision, secrets] = vi.mocked(saveExtensionLibrary).mock.calls[0];
    expect(expectedRevision).toBe(3);
    expect(secrets).toEqual({ 'server-1': 'synthetic-token' });
    expect(input).toEqual({ version: 1, skills: library.skills, servers: [docs, {
      kind: 'https', name: 'server-1', url: 'https://new.example.com/mcp', enabled: true, tools: [], capability: 'read', authentication: 'bearer',
      repositories: ['example/docs'], agents: ['claude-main'], autoApply: false,
    }] });
    expect(await within(view).findByRole('status')).toHaveTextContent('Server server-1 added.');
    expect(within(view).queryByTestId('extension-server-form')).toBeNull();
    expect(within(view).getAllByTestId('extension-server')).toHaveLength(2);
  });

  it('edits a server keeping its stored token unless replaced, and warns when a rename drops it', async () => {
    const view = await section();
    fireEvent.click(within(within(view).getByTestId('extension-server')).getByRole('button', { name: 'Edit' }));
    const form = within(view).getByTestId('extension-server-form');
    expect(within(form).getByLabelText(/^Bearer token/)).toHaveValue('');
    expect(form).toHaveTextContent('(configured; write-only)');
    fireEvent.change(within(form).getByLabelText(/^Server name/), { target: { value: 'docs-2' } });
    expect(form).toHaveTextContent('clears the stored token');
    fireEvent.change(within(form).getByLabelText(/^Server name/), { target: { value: 'docs' } });
    fireEvent.click(within(form).getByLabelText('example/docs', { exact: true }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledWith(expect.objectContaining({ servers: [{ ...docs, repositories: [] }] }), 3, {}));
  });

  it('shows a refused save inside the form and keeps it open', async () => {
    vi.mocked(saveExtensionLibrary).mockRejectedValueOnce(new Error('Automations add these extensions explicitly; remove them from "Weekly" (docs) before removing or renaming them'));
    const view = await section();
    fireEvent.click(within(within(view).getByTestId('extension-server')).getByRole('button', { name: 'Edit' }));
    const form = within(view).getByTestId('extension-server-form');
    fireEvent.change(within(form).getByLabelText(/^Server name/), { target: { value: 'renamed' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save server' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('"Weekly" (docs)');
    expect(within(view).getByTestId('extension-server-form')).toBeInTheDocument();
  });

  it('adds a skill from an archive with its limits in one form', async () => {
    const imported = { ...bundle, id: newBundleId, name: 'Release notes' };
    vi.mocked(importArchiveSkill).mockResolvedValue({ bundle: imported });
    const view = await section();
    fireEvent.click(within(view).getByRole('button', { name: 'Add skill' }));
    const form = within(view).getByTestId('extension-skill-form');
    expect(within(form).getByRole('button', { name: 'Add skill' })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Import a tar/), { target: { files: [new File(['x'], 'notes.tar')] } });
    expect(await within(form).findByText('Release notes')).toBeInTheDocument();
    fireEvent.click(within(form).getByLabelText('example/docs', { exact: true }));
    fireEvent.click(within(form).getByRole('button', { name: 'Add skill' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledWith(expect.objectContaining({
      skills: [library.skills[0], { bundleId: newBundleId, enabled: true, repositories: ['example/docs'], agents: [], autoApply: true }],
    }), 3, {}));
    expect(await within(view).findByRole('status')).toHaveTextContent('Skill Release notes added.');
  });

  it('switches an item off with one click, disables the checkbox in flight and keeps the dimmed row', async () => {
    const request = deferred<{ library: ExtensionLibraryRevision }>();
    vi.mocked(setExtensionItemEnabled).mockReturnValue(request.promise);
    const view = await section();
    const box = within(view).getByRole('checkbox', { name: 'Enabled: docs' });
    fireEvent.click(box);
    expect(setExtensionItemEnabled).toHaveBeenCalledWith({ kind: 'server', name: 'docs' }, false);
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    await act(async () => request.resolve({ library: { ...library, revision: 4, servers: [{ ...docs, enabled: false }] } }));
    expect(box).toBeEnabled();
    expect(box).not.toBeChecked();
    const row = within(view).getByTestId('extension-server');
    expect(row).toHaveAttribute('data-enabled', 'false');
    expect(row).toHaveTextContent('Off');
    expect(row).toHaveTextContent('which currently runs without it');
    expect(saveExtensionLibrary).not.toHaveBeenCalled();
    expect(within(view).getByText(/Revision 4/)).toBeInTheDocument();
    vi.mocked(setExtensionItemEnabled).mockResolvedValue({ library: { ...library, revision: 5 } });
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(setExtensionItemEnabled).toHaveBeenLastCalledWith({ kind: 'server', name: 'docs' }, true);
  });

  it('returns the checkbox to its previous state and shows the error when switching fails', async () => {
    const request = deferred<{ library: ExtensionLibraryRevision }>();
    vi.mocked(setExtensionItemEnabled).mockReturnValue(request.promise);
    const view = await section();
    const box = within(view).getByRole('checkbox', { name: 'Enabled: Documentation review' });
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    await act(async () => request.reject(new Error('A current durable instance administrator is required.')));
    expect(box).toBeChecked();
    expect(box).toBeEnabled();
    expect(within(view).getByRole('alert')).toHaveTextContent('Documentation review could not be switched off: A current durable instance administrator is required.');
  });

  it('removes an item only after confirmation and shows the refusal naming the automations', async () => {
    vi.mocked(saveExtensionLibrary).mockRejectedValueOnce(new Error('Automations add these extensions explicitly; remove them from "Weekly" (docs) before removing or renaming them'));
    const view = await section();
    const row = within(view).getByTestId('extension-server');
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(saveExtensionLibrary).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm removal' }));
    expect(await within(view).findByRole('alert')).toHaveTextContent('"Weekly" (docs)');
    expect(vi.mocked(saveExtensionLibrary).mock.calls[0][0].servers).toEqual([]);
    expect(within(view).getByTestId('extension-server')).toBeInTheDocument();
  });

  it('shows the revision history with who changed the library and when', async () => {
    vi.mocked(extensionLibraryHistory).mockResolvedValue({ revisions: [library] });
    const view = await section();
    fireEvent.click(within(view).getByRole('button', { name: 'Revision history' }));
    expect(await within(view).findByText(/Revision 3 .* administrator 1 · 1 servers · 1 skills/)).toBeInTheDocument();
  });

  it('drops a pending token when the endpoint changes, through the field or the saved-endpoint picker, or authentication is removed', async () => {
    const view = await section();
    fireEvent.click(within(within(view).getByTestId('extension-server')).getByRole('button', { name: 'Edit' }));
    const form = within(view).getByTestId('extension-server-form');
    const token = () => within(form).getByLabelText(/^Bearer token/);
    fireEvent.change(token(), { target: { value: 'token-for-a' } });
    fireEvent.change(within(form).getByLabelText('HTTPS endpoint'), { target: { value: 'https://other.example.com/mcp' } });
    expect(token()).toHaveValue('');
    fireEvent.change(token(), { target: { value: 'token-for-b' } });
    fireEvent.change(within(form).getByLabelText('Use a saved HTTPS endpoint'), { target: { value: docs.url } });
    expect(within(form).getByLabelText('HTTPS endpoint')).toHaveValue(docs.url);
    expect(token()).toHaveValue('');
    fireEvent.change(token(), { target: { value: 'token-for-a' } });
    fireEvent.change(within(form).getByLabelText('Authentication'), { target: { value: 'none' } });
    fireEvent.change(within(form).getByLabelText('Authentication'), { target: { value: 'bearer' } });
    expect(token()).toHaveValue('');
    fireEvent.change(within(form).getByLabelText('HTTPS endpoint'), { target: { value: 'https://other.example.com/mcp' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledWith(expect.objectContaining({ servers: [{ ...docs, url: 'https://other.example.com/mcp' }] }), 3, {}));
  });

  it('switches a new server from a catalog entry back to an HTTPS endpoint', async () => {
    const entry = { id: 'operator-docs', digest: 'c'.repeat(64), tools: ['lookup'], capability: 'read' as const, secrets: { count: 0, configured: false } };
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library, bundles: [], catalog: [entry], usage });
    const view = await section();
    fireEvent.click(within(view).getByRole('button', { name: 'Add server' }));
    const form = within(view).getByTestId('extension-server-form');
    fireEvent.change(within(form).getByLabelText('Server type'), { target: { value: entry.id } });
    expect(within(form).queryByLabelText('HTTPS endpoint')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Server type'), { target: { value: '' } });
    expect(within(form).getByLabelText('Server type')).toHaveValue('');
    fireEvent.change(within(form).getByLabelText('HTTPS endpoint'), { target: { value: 'https://new.example.com/mcp' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveExtensionLibrary).mock.calls[0][0].servers[1]).toEqual({
      kind: 'https', name: 'server-1', url: 'https://new.example.com/mcp', enabled: true, tools: [], capability: 'read', authentication: 'none',
      repositories: [], agents: [], autoApply: true,
    });
  });

  it('closes open server and skill forms on reload so they cannot save over the newer settings', async () => {
    const view = await section();
    fireEvent.click(within(within(view).getByTestId('extension-server')).getByRole('button', { name: 'Edit' }));
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library: { ...library, revision: 5, servers: [{ ...docs, repositories: [] }] }, bundles: [], catalog: [], usage });
    fireEvent.click(within(view).getByRole('button', { name: 'Reload' }));
    expect(await within(view).findByText(/Revision 5/)).toBeInTheDocument();
    expect(within(view).queryByTestId('extension-server-form')).toBeNull();
    expect(within(view).getByTestId('extension-server')).toHaveTextContent('All repositories');
    fireEvent.click(within(within(view).getByTestId('extension-skill')).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(view).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(within(view).queryByTestId('extension-skill-form')).toBeNull());
  });

  it('refuses to save an open form when its item changed after it was opened', async () => {
    const view = await section();
    // A switch on the other item adopts a revision carrying another administrator's edit to the item being edited.
    vi.mocked(setExtensionItemEnabled).mockResolvedValueOnce({ library: { ...library, revision: 4, servers: [{ ...docs, repositories: ['example/other'] }] } });
    fireEvent.click(within(within(view).getByTestId('extension-server')).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(view).getByRole('checkbox', { name: 'Enabled: Documentation review' }));
    expect(await within(view).findByText(/Revision 4/)).toBeInTheDocument();
    const serverForm = within(view).getByTestId('extension-server-form');
    fireEvent.click(within(serverForm).getByRole('button', { name: 'Save server' }));
    expect(await within(serverForm).findByRole('alert')).toHaveTextContent('Server docs was changed elsewhere after you opened it.');
    fireEvent.click(within(serverForm).getByRole('button', { name: 'Cancel' }));

    vi.mocked(setExtensionItemEnabled).mockResolvedValueOnce({ library: { ...library, revision: 5, servers: [{ ...docs, repositories: ['example/other'] }], skills: [{ ...library.skills[0], autoApply: true }] } });
    fireEvent.click(within(within(view).getByTestId('extension-skill')).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(view).getByRole('checkbox', { name: 'Enabled: docs' }));
    expect(await within(view).findByText(/Revision 5/)).toBeInTheDocument();
    const skillForm = within(view).getByTestId('extension-skill-form');
    fireEvent.click(within(skillForm).getByRole('button', { name: 'Save skill' }));
    expect(await within(skillForm).findByRole('alert')).toHaveTextContent('This skill was changed elsewhere after you opened it.');
    expect(saveExtensionLibrary).not.toHaveBeenCalled();
  });

  it('saves an open form against a newer revision when only other items changed', async () => {
    const view = await section();
    vi.mocked(setExtensionItemEnabled).mockResolvedValueOnce({ library: { ...library, revision: 4, skills: [{ ...library.skills[0], enabled: false }] } });
    fireEvent.click(within(within(view).getByTestId('extension-server')).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(view).getByRole('checkbox', { name: 'Enabled: Documentation review' }));
    expect(await within(view).findByText(/Revision 4/)).toBeInTheDocument();
    fireEvent.click(within(within(view).getByTestId('extension-server-form')).getByRole('button', { name: 'Save server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledWith(expect.objectContaining({ servers: [docs], skills: [{ ...library.skills[0], enabled: false }] }), 4, {}));
  });

  it('keeps the newest revision when two switch responses arrive in reverse order', async () => {
    const first = deferred<{ library: ExtensionLibraryRevision }>();
    const second = deferred<{ library: ExtensionLibraryRevision }>();
    vi.mocked(setExtensionItemEnabled).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = await section();
    fireEvent.click(within(view).getByRole('checkbox', { name: 'Enabled: docs' }));
    fireEvent.click(within(view).getByRole('checkbox', { name: 'Enabled: Documentation review' }));
    const both = { ...library, revision: 5, servers: [{ ...docs, enabled: false }], skills: [{ ...library.skills[0], enabled: false }] };
    await act(async () => second.resolve({ library: both }));
    await act(async () => first.resolve({ library: { ...library, revision: 4, servers: [{ ...docs, enabled: false }] } }));
    expect(within(view).getByText(/Revision 5/)).toBeInTheDocument();
    expect(within(view).getByRole('checkbox', { name: 'Enabled: docs' })).not.toBeChecked();
    expect(within(view).getByRole('checkbox', { name: 'Enabled: Documentation review' })).not.toBeChecked();
    fireEvent.click(within(within(view).getByTestId('extension-server')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(within(view).getByTestId('extension-server')).getByRole('button', { name: 'Confirm removal' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalledWith(expect.anything(), 5, {}));
  });
});
