import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TaskSchedule, UnattendedAdmission } from '../../../api/scheduleApi';
import { ScheduledTasksSection } from './ScheduledTasksSection';
import { scheduleInputFromForm } from './ScheduleCreateForm';

const api = vi.hoisted(() => ({
  listSchedules: vi.fn(),
  getScheduleDetail: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
}));
vi.mock('../../../api/scheduleApi', () => api);
vi.mock('../../../components/RepositorySelector', () => ({
  RepositorySelector: ({ selectedRepo, onRepoChange }: { selectedRepo: string; onRepoChange(repo: string): void }) => (
    <select aria-label="Repository" value={selectedRepo} onChange={event => onRepoChange(event.target.value)}>
      <option value="">Select</option>
      <option value="acme/widgets">acme/widgets</option>
    </select>
  ),
}));

const schedule = (overrides: Partial<TaskSchedule> = {}): TaskSchedule => ({
  id: 'sch-1', name: 'Nightly dependency check', repository: 'acme/widgets', cron: '0 2 * * *', timezone: 'Europe/Riga',
  instruction: { text: 'Update dependencies' }, enabled: true, owner: { userId: '1', username: 'octocat' },
  lastRunAt: '2026-10-05T23:00:00.000Z', nextRunAt: '2026-10-06T23:00:00.000Z', consecutiveFailures: 0, pausedReason: null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...overrides,
});
const admission = (overrides: Partial<UnattendedAdmission> = {}): UnattendedAdmission =>
  ({ maxConcurrent: 1, window: '', windowError: null, running: 0, ...overrides });

const settings = { unattended_max_concurrent: 2, unattended_window: '', unattended_window_error: null as string | null };
const agents = [{ alias: 'claude', enabled: true, supportedModels: ['opus', 'sonnet'] }];

function renderSection(overrides: Partial<typeof settings> = {}) {
  const onChange = vi.fn(); const onBlur = vi.fn();
  render(<MemoryRouter><ScheduledTasksSection settings={{ ...settings, ...overrides }} agents={agents} onChange={onChange} onBlur={onBlur} /></MemoryRouter>);
  return { onChange, onBlur };
}

beforeEach(() => {
  Object.values(api).forEach(mock => mock.mockReset());
});

describe('ScheduledTasksSection', () => {
  it('lists schedules with state, owner, cron and the running count', async () => {
    api.listSchedules.mockResolvedValue({
      schedules: [schedule(), schedule({ id: 'sch-2', name: 'Weekly cleanup', enabled: false, pausedReason: 'Paused after 3 consecutive failed runs' })],
      admission: admission({ running: 1 }),
    });
    renderSection();
    const rows = await screen.findAllByTestId('schedule-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Nightly dependency check')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Active')).toBeInTheDocument();
    expect(within(rows[0]).getByText('0 2 * * *')).toBeInTheDocument();
    expect(within(rows[0]).getByText('(Europe/Riga)')).toBeInTheDocument();
    expect(within(rows[0]).getByText('by @octocat')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Paused')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Paused after 3 consecutive failed runs')).toBeInTheDocument();
    expect(within(rows[1]).getByLabelText('Enable Weekly cleanup')).not.toBeChecked();
    expect(screen.getByText('1 unattended running')).toBeInTheDocument();
    expect(screen.getByLabelText('Max concurrent unattended tasks')).toHaveValue(2);
    expect(screen.getByLabelText('Unattended window')).toHaveAttribute('placeholder', '02:00-07:00@Europe/Riga');
  });

  it('warns that unattended work is blocked when the window is malformed', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [], admission: admission({ window: '25:00-07:00', windowError: '"25:00-07:00" is not a window such as 02:00-07:00@Europe/Riga' }) });
    renderSection({ unattended_window: '25:00-07:00' });
    expect(await screen.findByText('Unattended work is blocked: "25:00-07:00" is not a window such as 02:00-07:00@Europe/Riga')).toBeInTheDocument();
  });

  it('shows the settings window error before the schedule list has loaded', () => {
    api.listSchedules.mockReturnValue(new Promise(() => undefined));
    renderSection({ unattended_window_error: 'bad window' });
    expect(screen.getByRole('alert')).toHaveTextContent('Unattended work is blocked: bad window');
  });

  it('runs a schedule now, toggles it and expands recent runs with task links', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [schedule()], admission: admission() });
    api.runScheduleNow.mockResolvedValue({ schedule: schedule({ lastRunAt: '2026-10-06T10:00:00.000Z' }), run: { id: 7, status: 'dispatched', reason: null } });
    api.updateSchedule.mockResolvedValue({ schedule: schedule({ enabled: false }) });
    api.getScheduleDetail.mockResolvedValue({ schedule: schedule(), runs: [
      { id: 7, scheduleId: 'sch-1', slot: 'manual', trigger: 'manual', status: 'succeeded', reason: null, submissionId: 's', taskId: 'task-42', createdAt: '2026-10-06T10:00:00.000Z', finishedAt: null },
      { id: 6, scheduleId: 'sch-1', slot: 'x', trigger: 'schedule', status: 'skipped', reason: 'Outside the unattended window', submissionId: null, taskId: null, createdAt: '2026-10-05T23:00:00.000Z', finishedAt: null },
    ] });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Run Nightly dependency check now' }));
    await waitFor(() => expect(api.runScheduleNow).toHaveBeenCalledWith('sch-1'));
    expect(await screen.findByText('Nightly dependency check run started.')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Enable Nightly dependency check'));
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalledWith('sch-1', { enabled: false }));
    expect(await screen.findByText('Disabled')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Recent runs' }));
    const runs = await screen.findByRole('list', { name: 'Recent runs' });
    expect(within(runs).getByRole('link', { name: 'View task' })).toHaveAttribute('href', '/tasks/task-42');
    expect(within(runs).getByText('Outside the unattended window')).toBeInTheDocument();
    expect(within(runs).getByText('skipped')).toBeInTheDocument();
  });

  it('deletes a schedule only after confirmation', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [schedule()], admission: admission() });
    api.deleteSchedule.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderSection();
    const button = await screen.findByRole('button', { name: 'Delete Nightly dependency check' });
    fireEvent.click(button);
    expect(api.deleteSchedule).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId('schedule-row')).not.toBeInTheDocument());
    expect(api.deleteSchedule).toHaveBeenCalledWith('sch-1');
    confirm.mockRestore();
  });

  it('submits the create form payload and shows server validation errors', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [], admission: admission() });
    api.createSchedule.mockRejectedValueOnce(new Error('cron fires more often than every 5 minutes'))
      .mockResolvedValueOnce({ schedule: schedule({ id: 'sch-9', name: 'Weekly audit' }) });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'New schedule' }));
    const form = screen.getByRole('form', { name: 'New scheduled task' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Weekly audit' } });
    fireEvent.change(within(form).getByLabelText('Repository'), { target: { value: 'acme/widgets' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Weekly Monday 03:00' }));
    fireEvent.change(within(form).getByLabelText('Time zone'), { target: { value: 'Europe/Riga' } });
    fireEvent.change(within(form).getByLabelText('Instruction'), { target: { value: 'Audit dependencies' } });
    fireEvent.change(within(form).getByLabelText('Agent'), { target: { value: 'claude' } });
    fireEvent.change(within(form).getByLabelText('Model'), { target: { value: 'opus' } });
    fireEvent.click(within(form).getByLabelText('Run Ultrafix'));
    fireEvent.click(within(form).getByLabelText('Auto-merge'));
    fireEvent.change(within(form).getByLabelText('Max cost (USD)'), { target: { value: '4.5' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));

    expect(await within(form).findByRole('alert')).toHaveTextContent('cron fires more often than every 5 minutes');
    const expected = {
      name: 'Weekly audit', repository: 'acme/widgets', cron: '0 3 * * 1', timezone: 'Europe/Riga',
      instruction: { text: 'Audit dependencies', agentAlias: 'claude', model: 'opus', runUltrafix: true, autoMerge: true, maxCostUsd: 4.5 },
    };
    expect(api.createSchedule).toHaveBeenCalledWith(expected);

    fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));
    expect(await screen.findByText('Weekly audit scheduled.')).toBeInTheDocument();
    expect(api.createSchedule).toHaveBeenLastCalledWith(expected);
    expect(screen.getAllByTestId('schedule-row')).toHaveLength(1);
  });
});

describe('scheduleInputFromForm', () => {
  const base = { name: '', repository: 'acme/widgets', cron: '0 2 * * *', timezone: 'UTC', text: 'Do it', agentAlias: '', model: '', runUltrafix: false, autoMerge: false, maxCostUsd: '' };
  it('omits optional fields that were left empty', () => {
    expect(scheduleInputFromForm(base)).toEqual({ repository: 'acme/widgets', cron: '0 2 * * *', timezone: 'UTC', instruction: { text: 'Do it' } });
  });
  it('rejects missing required values before calling the server', () => {
    expect(scheduleInputFromForm({ ...base, repository: '' })).toBe('Choose a repository.');
    expect(scheduleInputFromForm({ ...base, text: ' ' })).toBe('Enter the instruction the schedule should run.');
    expect(scheduleInputFromForm({ ...base, maxCostUsd: '-1' })).toBe('Max cost must be a non-negative USD amount.');
  });
});
