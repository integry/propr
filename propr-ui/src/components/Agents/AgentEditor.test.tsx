import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { validateAgentSchedule } from '@propr/shared';
import { AgentEditor } from './AgentEditor';
import {
  AgentApiError,
  createAgentDefinition,
  deleteAgentAttachment,
  deleteAgentDefinition, getAgentCapacity, getAgentDefinition,
  triggerAgentRun,
  updateAgentDefinition,
  uploadAgentAttachment,
  type AgentDefinitionRecord,
} from '../../api/agentDefinitionsApi';
import { getInstanceCatalog } from '../../api/proprApi';
import { useAgentEditor } from './useAgentEditor';

vi.mock('../../api/agentDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/agentDefinitionsApi')>()),
  createAgentDefinition: vi.fn(),
  getAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(),
  uploadAgentAttachment: vi.fn(),
  deleteAgentAttachment: vi.fn(),
  triggerAgentRun: vi.fn(), getAgentCapacity: vi.fn(),
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

const renderEditor = (definitionId: string | null = null) =>
  render(<AgentEditor definitionId={definitionId} onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });

const fillRequired = () => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly triage' } });
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Summarize new issues' } });
};

describe('AgentEditor', () => {
  beforeEach(() => {
    vi.mocked(getAgentCapacity).mockResolvedValue({ capacity: { status: 'ok', sessionPercent: 20, provider: 'claude' }, threshold: 90 });
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [
        { alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-4-5'], defaultModel: 'claude-opus-4-5' },
        { alias: 'opencode-main', type: 'opencode', enabled: true, supportedModels: ['opencode-model'] },
      ],
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('shows the shared validation message for an invalid cron and sends no request', async () => {
    renderEditor();
    fillRequired();
    fireEvent.click(screen.getByRole('radio', { name: 'Cron' }));
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '61 * * * *' } });

    const message = validateAgentSchedule('61 * * * *')!;
    expect(screen.getByTestId('agent-schedule-feedback')).toHaveTextContent(message);

    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(createAgentDefinition).not.toHaveBeenCalled();
  });

  it('requires a name before creating', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('name is required');
    expect(createAgentDefinition).not.toHaveBeenCalled();
  });

  it('creates an agent with the form contents', async () => {
    vi.mocked(createAgentDefinition).mockResolvedValue({ ...definition, id: 'agent-2' });
    renderEditor();
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(createAgentDefinition).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Nightly triage', prompt: 'Summarize new issues', schedule: null, autonomy: 'dry_run', capabilities: ['repository_read'],
    })));
  });

  it('disables the propr_mcp toggle and acting autonomy for an OpenCode agent', async () => {
    renderEditor();
    const agentSelect = await screen.findByTitle('Select AI agent');
    await waitFor(() => expect(screen.getByRole('option', { name: 'OpenCode' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Claude' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'opencode-main' })).not.toBeInTheDocument();

    fireEvent.change(agentSelect, { target: { value: 'claude-main' } });
    const mcpToggle = screen.getByRole('switch', { name: /ProPR tools/ });
    expect(mcpToggle).toBeEnabled();
    fireEvent.click(mcpToggle);
    expect(mcpToggle).toBeChecked();

    fireEvent.change(agentSelect, { target: { value: 'opencode-main' } });
    expect(mcpToggle).toBeDisabled();
    expect(mcpToggle).not.toBeChecked();
    expect(screen.getByTestId('agent-capability-propr_mcp-hint')).toHaveTextContent('Not available for OpenCode: only Claude and Codex');
    expect(screen.getByTestId('agent-capability-web-hint')).toHaveTextContent('Best effort on OpenCode');
    expect(screen.getByRole('radio', { name: /^Auto/ })).toBeDisabled();
  });

  it('previews the next run of a preset in UTC', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'Cron' }));
    fireEvent.click(screen.getByRole('button', { name: 'Weekdays 09:00' }));

    expect(screen.getByLabelText('Cron expression')).toHaveValue('0 9 * * 1-5');
    expect(screen.getByTestId('agent-schedule-feedback')).toHaveTextContent('Next run: Thu 8 Oct 09:00 UTC');
  });

  it('sends the loaded revision and shows a conflict when the agent changed elsewhere', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    vi.mocked(updateAgentDefinition).mockRejectedValue(new AgentApiError('Agent definition was changed', 409));
    renderEditor('agent-1');

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Changed elsewhere — reload')).toBeInTheDocument();
    expect(updateAgentDefinition).toHaveBeenCalledWith('agent-1', expect.objectContaining({ name: 'Renamed' }), 3);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    vi.mocked(getAgentDefinition).mockResolvedValue({ ...definition, name: 'Changed in another tab', revision: 4 });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Changed in another tab'));
    expect(screen.queryByText('Changed elsewhere — reload')).not.toBeInTheDocument();
  });

  it('locks the name and description while a save is pending so later typing is not overwritten', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    let finish: (saved: AgentDefinitionRecord) => void = () => undefined;
    vi.mocked(updateAgentDefinition).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    renderEditor('agent-1');

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeDisabled());
    expect(screen.getByLabelText('Description')).toBeDisabled();

    finish({ ...definition, name: 'Renamed', revision: 4 });
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeEnabled());
    expect(screen.getByLabelText('Description')).toBeEnabled();
    expect(screen.getByLabelText('Name')).toHaveValue('Renamed');
  });

  it('disables Run now while a save is pending so the run cannot use the previous configuration', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    let finish: (saved: AgentDefinitionRecord) => void = () => undefined;
    vi.mocked(updateAgentDefinition).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    vi.mocked(triggerAgentRun).mockResolvedValue({ created: true, run: { id: 'run-1' } } as unknown as Awaited<ReturnType<typeof triggerAgentRun>>);
    renderEditor('agent-1');

    await screen.findByLabelText('Name');
    const runButton = screen.getByRole('button', { name: 'Run now' });
    expect(runButton).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(runButton).toBeDisabled());
    fireEvent.click(runButton);
    expect(triggerAgentRun).not.toHaveBeenCalled();

    finish({ ...definition, name: 'Renamed', revision: 4 });
    await waitFor(() => expect(runButton).toBeEnabled());
    fireEvent.click(runButton);
    await waitFor(() => expect(triggerAgentRun).toHaveBeenCalledWith('agent-1'));
  });

  it('disables Run now while the form differs from the saved agent and runs once it is saved', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue({ ...definition, autonomyMode: 'auto', capabilities: ['repository_read', 'propr_mcp'] });
    vi.mocked(updateAgentDefinition).mockImplementation(async (_id, input) => ({
      ...definition, prompt: input.prompt!, autonomyMode: input.autonomy!, capabilities: input.capabilities!, revision: 4,
    }));
    vi.mocked(triggerAgentRun).mockResolvedValue({ created: true, run: { id: 'run-1' } } as unknown as Awaited<ReturnType<typeof triggerAgentRun>>);
    renderEditor('agent-1');

    const runButton = await screen.findByRole('button', { name: 'Run now' });
    expect(runButton).toBeEnabled();
    fireEvent.click(screen.getByRole('radio', { name: /^Dry run/ }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Only report, change nothing' } });

    expect(runButton).toBeDisabled();
    expect(runButton).toHaveAccessibleDescription('Save your changes to run them');
    fireEvent.click(runButton);
    expect(triggerAgentRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(runButton).toBeEnabled());
    expect(screen.queryByText('Save your changes to run them')).not.toBeInTheDocument();
    fireEvent.click(runButton);
    await waitFor(() => expect(triggerAgentRun).toHaveBeenCalledWith('agent-1'));
  });

  it('re-enables Run now when an edit is undone', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    renderEditor('agent-1');

    const prompt = await screen.findByLabelText('Prompt');
    const runButton = screen.getByRole('button', { name: 'Run now' });
    fireEvent.change(prompt, { target: { value: 'Something else' } });
    expect(runButton).toBeDisabled();
    fireEvent.change(prompt, { target: { value: definition.prompt } });
    expect(runButton).toBeEnabled();
  });

  it('ignores a run requested from a stale render after the form was edited', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted: vi.fn() }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());

    act(() => result.current.update({ autonomy: 'auto' }));
    expect(result.current.dirty).toBe(true);
    await act(async () => { await result.current.run(); });
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it('reports a creation that finishes after its editor closed without claiming it is still open', async () => {
    let finish: (saved: AgentDefinitionRecord) => void = () => undefined;
    vi.mocked(createAgentDefinition).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onSaved = vi.fn();
    const { unmount } = render(<AgentEditor definitionId={null} onSaved={onSaved} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(createAgentDefinition).toHaveBeenCalled());

    unmount();
    await act(async () => { finish({ ...definition, id: 'agent-2' }); });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-2' }), true, false);
  });

  it('reports a creation that finishes while its editor is open as open', async () => {
    vi.mocked(createAgentDefinition).mockResolvedValue({ ...definition, id: 'agent-2' });
    const onSaved = vi.fn();
    render(<AgentEditor definitionId={null} onSaved={onSaved} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-2' }), true, true));
  });

  it('reports a deletion that finishes after its editor closed without claiming it is still open', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    let finish: () => void = () => undefined;
    vi.mocked(deleteAgentDefinition).mockReturnValue(new Promise<void>(resolve => { finish = resolve; }) as never);
    const onDeleted = vi.fn();
    const { result, unmount } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());

    let pending: Promise<boolean> = Promise.resolve(false);
    act(() => { pending = result.current.remove(); });
    unmount();
    await act(async () => { finish(); await pending; });
    expect(onDeleted).toHaveBeenCalledWith('agent-1', false);
  });

  it('ignores a run requested while a save is in flight, even before the button re-renders', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    let finish: (saved: AgentDefinitionRecord) => void = () => undefined;
    vi.mocked(updateAgentDefinition).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    vi.mocked(triggerAgentRun).mockResolvedValue({ created: true, run: { id: 'run-1' } } as unknown as Awaited<ReturnType<typeof triggerAgentRun>>);
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted: vi.fn() }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());

    // Both actions come from the same render, as two clicks handled before React re-renders would.
    const { save, run } = result.current;
    let pendingSave: Promise<void> = Promise.resolve();
    await act(async () => {
      pendingSave = save();
      await run();
    });
    expect(updateAgentDefinition).toHaveBeenCalledTimes(1);
    expect(triggerAgentRun).not.toHaveBeenCalled();

    await act(async () => {
      finish({ ...definition, revision: 4 });
      await pendingSave;
    });
    await act(async () => { await result.current.run(); });
    expect(triggerAgentRun).toHaveBeenCalledWith('agent-1');
  });
  it('blocks Run now after a conflict until the replacement definition has loaded', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    vi.mocked(updateAgentDefinition).mockRejectedValue(new AgentApiError('Agent definition was changed', 409));
    vi.mocked(triggerAgentRun).mockResolvedValue({ created: true, run: { id: 'run-1' } } as unknown as Awaited<ReturnType<typeof triggerAgentRun>>);
    renderEditor('agent-1');

    // The form is unchanged, so only the conflict says the server holds something else.
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Changed elsewhere — reload');
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(screen.queryByText('Save your changes to run them')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(triggerAgentRun).not.toHaveBeenCalled();

    let finishReload: (loaded: AgentDefinitionRecord) => void = () => undefined;
    vi.mocked(getAgentDefinition).mockReturnValue(new Promise(resolve => { finishReload = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(getAgentDefinition).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(triggerAgentRun).not.toHaveBeenCalled();

    await act(async () => { finishReload({ ...definition, autonomyMode: 'auto', revision: 4 }); });
    expect(screen.getByRole('radio', { name: /^Auto/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(triggerAgentRun).toHaveBeenCalledWith('agent-1'));
  });

  it('keeps Run now blocked when reloading after a conflict fails', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    vi.mocked(updateAgentDefinition).mockRejectedValue(new AgentApiError('Agent definition was changed', 409));
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted: vi.fn() }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());

    await act(async () => { await result.current.save(); });
    expect(result.current.conflict).toBe(true);
    vi.mocked(getAgentDefinition).mockRejectedValue(new Error('Network down'));
    await act(async () => { await result.current.reload(); });
    await act(async () => { await result.current.run(); });
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it('ignores a run requested from the render before a conflict was reported', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    vi.mocked(updateAgentDefinition).mockRejectedValue(new AgentApiError('Agent definition was changed', 409));
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted: vi.fn() }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());

    const { save, run } = result.current;
    await act(async () => { await save(); });
    await act(async () => { await run(); });
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it.each([
    ['uploading an input file', 'upload'],
    ['removing an input file', 'remove'],
  ] as const)('holds Run now back while %s, even before the button re-renders', async (_label, change) => {
    const attachment = { id: 'file-1', originalName: 'notes.md', size: 10 } as AgentDefinitionRecord['attachments'][number];
    vi.mocked(getAgentDefinition).mockResolvedValue({ ...definition, attachments: change === 'remove' ? [attachment] : [] });
    let finish: () => void = () => undefined;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(uploadAgentAttachment).mockImplementation(async () => {
      await settled;
      return { definition: { ...definition, attachments: [attachment] }, attachments: [attachment] };
    });
    vi.mocked(deleteAgentAttachment).mockImplementation(async () => { await settled; return { ...definition, attachments: [] }; });
    vi.mocked(triggerAgentRun).mockResolvedValue({ created: true, run: { id: 'run-1' } } as unknown as Awaited<ReturnType<typeof triggerAgentRun>>);
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted: vi.fn() }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());

    const { upload, removeAttachment, run } = result.current;
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = change === 'upload' ? upload([new File(['x'], 'notes.md')]) : removeAttachment('file-1');
      await run();
    });
    expect(triggerAgentRun).not.toHaveBeenCalled();
    expect(result.current.attachmentsPending).toBe(true);

    await act(async () => { finish(); await pending; });
    expect(result.current.attachmentsPending).toBe(false);
    await act(async () => { await result.current.run(); });
    expect(triggerAgentRun).toHaveBeenCalledWith('agent-1');
  });

  it.each([
    ['uploading an input file', 'upload'],
    ['removing an input file', 'remove'],
  ] as const)('ignores a save requested while %s, even before the button re-renders', async (_label, change) => {
    const attachment = { id: 'file-1', originalName: 'notes.md', size: 10 } as AgentDefinitionRecord['attachments'][number];
    const before = change === 'remove' ? [attachment] : [];
    const after = change === 'remove' ? [] : [attachment];
    vi.mocked(getAgentDefinition).mockResolvedValue({ ...definition, attachments: before });
    let finish: () => void = () => undefined;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(uploadAgentAttachment).mockImplementation(async () => {
      await settled;
      return { definition: { ...definition, attachments: after }, attachments: after };
    });
    vi.mocked(deleteAgentAttachment).mockImplementation(async () => { await settled; return { ...definition, attachments: after }; });
    // A save answered after the attachment change would carry the file list from before it.
    vi.mocked(updateAgentDefinition).mockResolvedValue({ ...definition, attachments: before, revision: 4 });
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted: vi.fn() }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());

    const { upload, removeAttachment, save } = result.current;
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = change === 'upload' ? upload([new File(['x'], 'notes.md')]) : removeAttachment('file-1');
      await save();
    });
    expect(updateAgentDefinition).not.toHaveBeenCalled();

    await act(async () => { finish(); await pending; });
    expect(result.current.definition?.attachments).toEqual(after);
  });

  it('ignores an attachment change requested while a save is in flight, even before the inputs re-render', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    let finishSave: (saved: AgentDefinitionRecord) => void = () => undefined;
    vi.mocked(updateAgentDefinition).mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
    const { result } = renderHook(() => useAgentEditor('agent-1', { onSaved: vi.fn(), onDeleted: vi.fn() }));
    await waitFor(() => expect(result.current.definition).not.toBeNull());

    const { save, upload, removeAttachment } = result.current;
    let pendingSave: Promise<void> = Promise.resolve();
    await act(async () => {
      pendingSave = save();
      await upload([new File(['x'], 'notes.md')]);
      await removeAttachment('file-1');
    });
    expect(uploadAgentAttachment).not.toHaveBeenCalled();
    expect(deleteAgentAttachment).not.toHaveBeenCalled();
    await act(async () => { finishSave({ ...definition, revision: 4 }); await pendingSave; });
  });

  it('disables Save while an input file upload is in flight', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(uploadAgentAttachment).mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    renderEditor('agent-1');

    const saveButton = await screen.findByRole('button', { name: 'Save' });
    expect(saveButton).toBeEnabled();
    fireEvent.change(screen.getByTestId('agent-attachment-input'), { target: { files: [new File(['x'], 'notes.md')] } });
    await waitFor(() => expect(saveButton).toBeDisabled());

    await act(async () => { fail(new Error('Upload failed')); });
    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
    expect(saveButton).toBeEnabled();
  });

  it('disables Run now while an input file upload is in flight and re-enables it if the upload fails', async () => {
    vi.mocked(getAgentDefinition).mockResolvedValue(definition);
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(uploadAgentAttachment).mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    renderEditor('agent-1');

    const runButton = await screen.findByRole('button', { name: 'Run now' });
    fireEvent.change(screen.getByTestId('agent-attachment-input'), { target: { files: [new File(['x'], 'notes.md')] } });
    await waitFor(() => expect(runButton).toBeDisabled());

    await act(async () => { fail(new Error('Upload failed')); });
    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
    expect(runButton).toBeEnabled();
  });
});
