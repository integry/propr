import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentEditor } from './AgentEditor';
import {
  createAutomationDefinition, getAutomationCapacity, getAutomationDefinition, updateAutomationDefinition, type AutomationDefinitionRecord,
} from '../../api/automationDefinitionsApi';
import { getInstanceCatalog } from '../../api/proprApi';

vi.mock('../../api/automationDefinitionsApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/automationDefinitionsApi')>()),
  createAutomationDefinition: vi.fn(), getAutomationDefinition: vi.fn(), getAutomationCapacity: vi.fn(), updateAutomationDefinition: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn().mockResolvedValue([]) }));

const definition: AutomationDefinitionRecord = {
  id: 'agent-1', ownerId: '1', name: 'Dependency review', description: null, repositories: [],
  prompt: 'Review dependencies', attachments: [], agentAlias: 'claude-main', modelName: 'claude-opus-5-5',
  capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null,
  autonomyMode: 'dry_run', enabled: true, revision: 3, createdAt: 0, updatedAt: 0,
};

const openSaved = async (scheduleCron: string) => {
  vi.mocked(getAutomationDefinition).mockResolvedValue({ ...definition, scheduleCron, scheduleEnabled: true });
  vi.mocked(updateAutomationDefinition).mockImplementation(async (_id, input) => ({ ...definition, ...input, revision: 4 } as unknown as AutomationDefinitionRecord));
  render(<AgentEditor definitionId="agent-1" onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });
  await screen.findByDisplayValue('Dependency review');
};

const saveChanges = async (schedule: string) => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(updateAutomationDefinition).toHaveBeenCalledWith('agent-1', expect.objectContaining({ schedule }), 3));
};

describe('AgentEditor schedule modes', () => {
  beforeEach(() => {
    vi.mocked(getAutomationCapacity).mockResolvedValue({ capacity: { status: 'ok', sessionPercent: 20, provider: 'claude' }, threshold: 90 });
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [{ alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5' }],
      defaultAgentAlias: 'claude-main',
      repositories: [],
    } as unknown as Awaited<ReturnType<typeof getInstanceCatalog>>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('creates "every 3 hours" from the Repeat controls without typing cron', async () => {
    vi.mocked(createAutomationDefinition).mockResolvedValue({ ...definition, id: 'agent-2' });
    render(<AgentEditor definitionId={null} onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly triage' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Summarize new issues' } });

    const modes = screen.getByRole('radiogroup', { name: 'Schedule' });
    expect(within(modes).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['Off', 'Repeat', 'Custom (cron)']);
    fireEvent.click(within(modes).getByRole('radio', { name: 'Repeat' }));
    // Turning a schedule on starts from every day at 09:00 UTC.
    expect(screen.getByLabelText('Every')).toHaveValue('days');
    expect(screen.getByLabelText('Hour (UTC)')).toHaveValue('9');
    expect(screen.getByLabelText('Minute')).toHaveValue('0');
    expect(screen.getByText('UTC')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Every'), { target: { value: 'hours' } });
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '3' } });
    expect(screen.getByLabelText('Unit')).toHaveValue('hours');
    expect(screen.queryByLabelText('Hour (UTC)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Cron expression')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-schedule-feedback')).toHaveTextContent(/^Next run: \w{3} \d{1,2} \w{3} (00|03|06|09|12|15|18|21):00 UTC$/);

    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(createAutomationDefinition).toHaveBeenCalledWith(expect.objectContaining({ schedule: '0 */3 * * *' })));
  });

  it('offers only minute intervals that repeat evenly and pass the 15-minute minimum', async () => {
    render(<AgentEditor definitionId={null} onSaved={vi.fn()} onDeleted={vi.fn()} />, { wrapper: MemoryRouter });
    fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: 'minutes' } });
    expect(within(screen.getByLabelText('Every')).getAllByRole('option').map(option => option.textContent)).toEqual(['15', '20', '30']);
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'hours' } });
    expect(within(screen.getByLabelText('Every')).getAllByRole('option').map(option => option.textContent)).toEqual(['1', '2', '3', '4', '6', '8', '12']);
  });

  it('opens 0 9 * * 1-5 as weekly on Monday to Friday at 09:00 and saves it unchanged', async () => {
    await openSaved('0 9 * * 1-5');
    expect(screen.getByRole('radio', { name: 'Repeat' })).toBeChecked();
    expect(screen.getByLabelText('Every')).toHaveValue('weeks');
    expect(screen.getByLabelText('Hour (UTC)')).toHaveValue('9');
    expect(screen.getByLabelText('Minute')).toHaveValue('0');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) expect(screen.getByRole('checkbox', { name: day })).toBeChecked();
    for (const day of ['Saturday', 'Sunday']) expect(screen.getByRole('checkbox', { name: day })).not.toBeChecked();
    await saveChanges('0 9 * * 1-5');
  });

  it('writes the chosen days and time of a weekly schedule', async () => {
    await openSaved('0 9 * * 1-5');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Friday' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sunday' }));
    fireEvent.change(screen.getByLabelText('Hour (UTC)'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '30' } });
    await saveChanges('30 7 * * 0-4');
  });

  it('keeps the last chosen day of a weekly schedule', async () => {
    await openSaved('0 9 * * 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Monday' }));
    expect(screen.getByRole('checkbox', { name: 'Monday' })).toBeChecked();
    await saveChanges('0 9 * * 1');
  });

  it('opens a hand-written expression in Custom (cron) and saves it unchanged', async () => {
    await openSaved('15 9,17 * * 1-5');
    expect(screen.getByRole('radio', { name: 'Custom (cron)' })).toBeChecked();
    expect(screen.getByLabelText('Cron expression')).toHaveValue('15 9,17 * * 1-5');
    await saveChanges('15 9,17 * * 1-5');
  });

  it('shows the generated expression under Custom (cron)', async () => {
    await openSaved('0 9 * * 1-5');
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: 'days' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Custom (cron)' }));
    expect(screen.getByLabelText('Cron expression')).toHaveValue('0 9 * * *');
    // The presets stay as shortcuts there.
    fireEvent.click(screen.getByRole('button', { name: 'Weekly Mon 09:00' }));
    expect(screen.getByLabelText('Cron expression')).toHaveValue('0 9 * * 1');
    // Back in Repeat, a representable expression fills the controls.
    fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
    expect(screen.getByLabelText('Every')).toHaveValue('weeks');
    expect(screen.getByRole('checkbox', { name: 'Monday' })).toBeChecked();
  });

  it('keeps a custom expression Repeat cannot show until a control changes', async () => {
    await openSaved('*/45 * * * *');
    fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
    expect(screen.getByTestId('agent-schedule-kept')).toHaveTextContent('Keeps */45 * * * * until you change a control.');
    fireEvent.click(screen.getByRole('radio', { name: 'Custom (cron)' }));
    expect(screen.getByLabelText('Cron expression')).toHaveValue('*/45 * * * *');
    fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
    fireEvent.change(screen.getByLabelText('Hour (UTC)'), { target: { value: '6' } });
    expect(screen.queryByTestId('agent-schedule-kept')).not.toBeInTheDocument();
    await saveChanges('0 6 * * *');
  });

  it('shows the validator message inline in Repeat for a kept expression it refuses', async () => {
    await openSaved('*/5 * * * *');
    expect(screen.getByTestId('agent-schedule-feedback')).toHaveTextContent('Run at most every 15 minutes.');
    fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
    expect(screen.getByTestId('agent-schedule-feedback')).toHaveTextContent('Run at most every 15 minutes.');
    expect(screen.getByLabelText('Every')).toHaveAttribute('aria-invalid', 'true');
  });

  it('turns the schedule off and back on without losing it', async () => {
    await openSaved('0 */6 * * *');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Schedule' })).getByRole('radio', { name: 'Off' }));
    expect(screen.queryByLabelText('Every')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
    expect(screen.getByLabelText('Every')).toHaveValue('6');
    await saveChanges('0 */6 * * *');
  });
});
