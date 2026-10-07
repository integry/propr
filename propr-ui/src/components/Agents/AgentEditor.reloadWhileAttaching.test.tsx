import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentEditor } from './AgentEditor';
import {
  AgentApiError,
  deleteAgentAttachment,
  getAgentDefinition,
  updateAgentDefinition,
  uploadAgentAttachment,
  type AgentDefinitionRecord,
} from '../../api/agentDefinitionsApi';
import { getInstanceCatalog } from '../../api/proprApi';
import { useAgentEditor } from './useAgentEditor';

vi.mock('../../api/agentDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/agentDefinitionsApi')>()),
  getAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  uploadAgentAttachment: vi.fn(),
  deleteAgentAttachment: vi.fn(),
}));

vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../../utils/repoHelpers', () => ({
  fetchEnabledRepos: vi.fn().mockResolvedValue([{ name: 'integry/propr', enabled: true }]),
}));

const definition: AgentDefinitionRecord = {
  id: 'agent-1', ownerId: '1', name: 'Dependency review', description: null, repositories: ['integry/propr'],
  prompt: 'Review dependencies', attachments: [], agentAlias: 'claude-main', modelName: 'claude-opus-4-5',
  capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
  autonomyMode: 'dry_run', enabled: true, revision: 3, createdAt: 0, updatedAt: 0,
};

const renderEditor = (definitionId: string) => render(
  <AgentEditor definitionId={definitionId} onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter },
);

/** A reload and an input file change both settle the file list, so one waits for the other instead of racing it. */
describe('AgentEditor reload while input files change', () => {
  beforeEach(() => {
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-4-5'] }],
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each([
    ['uploading an input file', 'upload'],
    ['removing an input file', 'remove'],
  ] as const)('ignores a reload requested while %s, so an older read cannot replace the new file list', async (_label, change) => {
    const attachment = { id: 'file-1', originalName: 'notes.md', size: 10 } as AgentDefinitionRecord['attachments'][number];
    const before = change === 'remove' ? [attachment] : [];
    const after = change === 'remove' ? [] : [attachment];
    vi.mocked(getAgentDefinition).mockResolvedValue({ ...definition, attachments: before });
    vi.mocked(updateAgentDefinition).mockRejectedValue(new AgentApiError('Agent definition was changed', 409));
    let finish: () => void = () => undefined;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(uploadAgentAttachment).mockImplementation(async () => {
      await settled;
      return { definition: { ...definition, attachments: after }, attachments: after };
    });
    vi.mocked(deleteAgentAttachment).mockImplementation(async () => { await settled; return { ...definition, attachments: after }; });
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted: vi.fn() }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());
    await act(async () => { await result.current.save(); });
    expect(result.current.conflict).toBe(true);

    // A read taken now would predate the change, and its late answer would undo it on screen.
    let finishRead: (loaded: AgentDefinitionRecord) => void = () => undefined;
    vi.mocked(getAgentDefinition).mockClear().mockReturnValue(new Promise(resolve => { finishRead = resolve; }));
    const { upload, removeAttachment, reload } = result.current;
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = change === 'upload' ? upload([new File(['x'], 'notes.md')]) : removeAttachment('file-1');
      await reload();
    });
    expect(getAgentDefinition).not.toHaveBeenCalled();

    await act(async () => { finish(); await pending; });
    expect(result.current.definition?.attachments).toEqual(after);
    expect(result.current.conflict).toBe(true);

    let reloaded: Promise<void> = Promise.resolve();
    act(() => { reloaded = result.current.reload(); });
    expect(getAgentDefinition).toHaveBeenCalledWith('agent-1');
    await act(async () => { finishRead({ ...definition, attachments: after, revision: 4 }); await reloaded; });
    expect(result.current.definition?.attachments).toEqual(after);
    expect(result.current.conflict).toBe(false);
  });

  it.each([
    ['upload', 'upload'],
    ['removal', 'remove'],
  ] as const)('ignores an input file %s requested while a reload is in flight', async (_label, change) => {
    const attachment = { id: 'file-1', originalName: 'notes.md', size: 10 } as AgentDefinitionRecord['attachments'][number];
    vi.mocked(getAgentDefinition).mockResolvedValue({ ...definition, attachments: [attachment] });
    vi.mocked(updateAgentDefinition).mockRejectedValue(new AgentApiError('Agent definition was changed', 409));
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted: vi.fn() }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());
    await act(async () => { await result.current.save(); });

    let finishRead: (loaded: AgentDefinitionRecord) => void = () => undefined;
    vi.mocked(getAgentDefinition).mockReturnValue(new Promise(resolve => { finishRead = resolve; }));
    const { upload, removeAttachment, reload } = result.current;
    let reloaded: Promise<void> = Promise.resolve();
    await act(async () => {
      reloaded = reload();
      await (change === 'upload' ? upload([new File(['x'], 'notes.md')]) : removeAttachment('file-1'));
    });
    expect(uploadAgentAttachment).not.toHaveBeenCalled();
    expect(deleteAgentAttachment).not.toHaveBeenCalled();
    expect(result.current.attachmentsPending).toBe(false);

    await act(async () => { finishRead({ ...definition, attachments: [attachment], revision: 4 }); await reloaded; });
    expect(result.current.definition?.attachments).toEqual([attachment]);
    expect(result.current.conflict).toBe(false);
  });

  it('disables Reload while an input file upload is in flight', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    vi.mocked(updateAgentDefinition).mockRejectedValue(new AgentApiError('Agent definition was changed', 409));
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(uploadAgentAttachment).mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    renderEditor('agent-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    const reloadButton = await screen.findByRole('button', { name: 'Reload' });
    expect(reloadButton).toBeEnabled();
    fireEvent.change(screen.getByTestId('agent-attachment-input'), { target: { files: [new File(['x'], 'notes.md')] } });
    await waitFor(() => expect(reloadButton).toBeDisabled());

    await act(async () => { fail(new Error('Upload failed')); });
    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
    expect(reloadButton).toBeEnabled();
  });
});
