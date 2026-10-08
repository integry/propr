import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UnattendedAgentRunsSettingsSection } from './UnattendedAgentRunsSettingsSection';
import { parseLoadedData } from './parseLoadedData';
import { unattendedNotice } from '../../components/Agents/agentRunPresentation';

const VALUES = { agent_run_usage_pause_percent: 90, unattended_max_concurrent: 1, unattended_window: '' };
// 17:30 in Riga (UTC+3).
const NOW = () => Date.UTC(2026, 9, 6, 14, 30);

it('commits valid limits and keeps invalid drafts unsaved with a reason', () => {
  const onCommit = vi.fn();
  render(<UnattendedAgentRunsSettingsSection values={VALUES} onCommit={onCommit} now={NOW} />);
  const cap = screen.getByLabelText('Concurrent unattended runs');
  fireEvent.change(cap, { target: { value: '3' } }); fireEvent.blur(cap);
  expect(onCommit).toHaveBeenLastCalledWith('unattended_max_concurrent', 3);
  fireEvent.change(cap, { target: { value: '0' } }); fireEvent.blur(cap);
  expect(screen.getByText('Enter a whole number from 1 to 100.')).toBeInTheDocument();

  const window = screen.getByLabelText('Unattended window (local time)');
  fireEvent.change(window, { target: { value: '2am-7am' } }); fireEvent.blur(window);
  expect(screen.getByText(/^Not saved: use the form HH:MM-HH:MM@Time\/Zone/)).toBeInTheDocument();
  fireEvent.change(window, { target: { value: '02:00-07:00@Europe/Riga' } }); fireEvent.blur(window);
  expect(onCommit).toHaveBeenLastCalledWith('unattended_window', '02:00-07:00@Europe/Riga');
  expect(onCommit).toHaveBeenCalledTimes(2);
});

it('shows whether the saved window is open now', () => {
  render(<UnattendedAgentRunsSettingsSection values={{ ...VALUES, unattended_window: '02:00-07:00@Europe/Riga' }} onCommit={vi.fn()} now={NOW} />);
  expect(screen.getByTestId('unattended-window-state')).toHaveTextContent(
    'Outside the window (02:00-07:00 Europe/Riga) until 02:00 Europe/Riga: unattended runs wait.');
});

it('warns that a malformed stored window blocks unattended runs, and clearing it saves an empty window', () => {
  const onCommit = vi.fn();
  render(<UnattendedAgentRunsSettingsSection values={{ ...VALUES, unattended_window: '25:00-07:00@UTC' }}
    windowError="times must be between 00:00 and 24:00" onCommit={onCommit} now={NOW} />);
  expect(screen.getByTestId('unattended-window-warning')).toHaveTextContent(
    'The stored window “25:00-07:00@UTC” is malformed (times must be between 00:00 and 24:00). Unattended agent runs are blocked');
  expect(screen.getByText('Blocked: window is malformed')).toBeInTheDocument();
  const window = screen.getByLabelText('Unattended window (local time)');
  fireEvent.change(window, { target: { value: '' } }); fireEvent.blur(window);
  expect(onCommit).toHaveBeenCalledWith('unattended_window', '');
});

it('loads the limits and the malformed-window warning from the settings response', () => {
  const loaded = parseLoadedData([
    { agent_run_usage_pause_percent: 80, unattended_max_concurrent: 2, unattended_window: 'x', unattended_window_error: 'bad' },
    {}, {}, {}, {}, { agents: [] }, {}, {},
  ]);
  expect(loaded.settings).toMatchObject({ agent_run_usage_pause_percent: 80, unattended_max_concurrent: 2, unattended_window: 'x', unattended_window_error: 'bad' });
  const older = parseLoadedData([{}, {}, {}, {}, {}, { agents: [] }, {}, {}]);
  expect(older.settings).toMatchObject({ agent_run_usage_pause_percent: 90, unattended_max_concurrent: 1, unattended_window: '' });
  expect(older.settings.unattended_window_error).toBeUndefined();
});

it('the agent editor notice names a closed window, a malformed window or a reached cap', () => {
  const closed = { configured: true as const, value: '02:00-07:00@Europe/Riga', description: '02:00-07:00 Europe/Riga', timeZone: 'Europe/Riga', open: false, opensAt: 1, opensAtLocal: '02:00' };
  const free = { active: 0, cap: 1, reached: false };
  expect(unattendedNotice({ unattended: { concurrency: free, window: closed } }))
    .toBe('Unattended runs wait: outside the unattended window until 02:00 Europe/Riga.');
  expect(unattendedNotice({ unattended: { concurrency: free, window: { configured: true, value: 'x', error: 'bad' } } }))
    .toMatch(/^Unattended runs are blocked: the unattended window setting "x" is malformed \(bad\)/);
  expect(unattendedNotice({ unattended: { concurrency: { active: 2, cap: 2, reached: true }, window: { configured: false } } }))
    .toBe('Unattended runs wait: 2 unattended runs are already active (cap 2).');
  expect(unattendedNotice({ unattended: { concurrency: free, window: { configured: false } } })).toBeNull();
  expect(unattendedNotice({})).toBeNull();
});
