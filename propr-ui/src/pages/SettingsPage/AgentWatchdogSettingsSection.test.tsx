import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentWatchdogSettingsSection } from './AgentWatchdogSettingsSection';
import { parseLoadedData } from './parseLoadedData';

const DEFAULTS = { agent_stall_timeout_ms: 600_000, agent_tool_stall_timeout_ms: 1_800_000, agent_degenerate_output_limit: 50 };

it('shows environment defaults as placeholders and stored overrides in minutes', () => {
  render(<AgentWatchdogSettingsSection
    values={{ agent_stall_timeout_ms: 300_000, agent_tool_stall_timeout_ms: null, agent_degenerate_output_limit: null }}
    defaults={DEFAULTS} onCommit={vi.fn()} />);
  expect(screen.getByLabelText('Stall timeout (minutes)')).toHaveValue(5);
  expect(screen.getByLabelText('Tool stall timeout (minutes)')).toHaveAttribute('placeholder', 'Default: 30');
  expect(screen.getByLabelText('Whitespace-only output limit')).toHaveAttribute('placeholder', 'Default: 50');
});

it('commits minutes as milliseconds, an empty field as the default, and ignores invalid input', () => {
  const onCommit = vi.fn();
  render(<AgentWatchdogSettingsSection
    values={{ agent_stall_timeout_ms: 300_000, agent_tool_stall_timeout_ms: null, agent_degenerate_output_limit: null }}
    defaults={DEFAULTS} onCommit={onCommit} />);
  const stall = screen.getByLabelText('Stall timeout (minutes)');
  fireEvent.change(stall, { target: { value: '15' } }); fireEvent.blur(stall);
  expect(onCommit).toHaveBeenLastCalledWith('agent_stall_timeout_ms', 900_000);
  fireEvent.change(stall, { target: { value: '' } }); fireEvent.blur(stall);
  expect(onCommit).toHaveBeenLastCalledWith('agent_stall_timeout_ms', null);
  const limit = screen.getByLabelText('Whitespace-only output limit');
  fireEvent.change(limit, { target: { value: '0' } }); fireEvent.blur(limit);
  expect(onCommit).toHaveBeenLastCalledWith('agent_degenerate_output_limit', 0);
  expect(onCommit).toHaveBeenCalledTimes(3);
});

it('focusing and leaving a timeout field without editing keeps a value that does not round to minutes', () => {
  const onCommit = vi.fn();
  render(<AgentWatchdogSettingsSection
    values={{ agent_stall_timeout_ms: 100, agent_tool_stall_timeout_ms: 1_234, agent_degenerate_output_limit: 7 }}
    defaults={DEFAULTS} onCommit={onCommit} />);
  const stall = screen.getByLabelText('Stall timeout (minutes)');
  const toolStall = screen.getByLabelText('Tool stall timeout (minutes)');
  expect(stall).not.toHaveValue(0);
  expect(toolStall).not.toHaveValue(0);
  for (const field of [stall, toolStall, screen.getByLabelText('Whitespace-only output limit')]) {
    fireEvent.focus(field); fireEvent.blur(field);
  }
  expect(onCommit).not.toHaveBeenCalled();
  // The displayed minutes convert back to the exact stored milliseconds.
  fireEvent.change(stall, { target: { value: (stall as HTMLInputElement).value } }); fireEvent.blur(stall);
  fireEvent.change(toolStall, { target: { value: (toolStall as HTMLInputElement).value } }); fireEvent.blur(toolStall);
  expect(onCommit).not.toHaveBeenCalled();
});

it('loads stored overrides and treats missing ones as the environment default', () => {
  const load = (settings: object) => parseLoadedData([settings, {}, {}, {}, {}, {}, {}, {}]).settings;
  expect(load({})).toMatchObject({ agent_stall_timeout_ms: null, agent_tool_stall_timeout_ms: null, agent_degenerate_output_limit: null });
  expect(load({ agent_stall_timeout_ms: 0, agent_degenerate_output_limit: 20, agent_watchdog_defaults: DEFAULTS }))
    .toMatchObject({ agent_stall_timeout_ms: 0, agent_degenerate_output_limit: 20, agent_watchdog_defaults: DEFAULTS });
});
