import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentNetworkSettingsSection } from './AgentNetworkSettingsSection';

const unset = { agent_network_mode: null, agent_network_mode_enforced: null, agent_network_allow: null, agent_network_ignore_repository_allow: null };

describe('AgentNetworkSettingsSection', () => {
  it('shows the environment defaults and saves a chosen mode', () => {
    const onCommit = vi.fn();
    render(<AgentNetworkSettingsSection values={unset} defaults={{ agent_network_mode: 'restricted', agent_network_mode_enforced: false }} onCommit={onCommit} />);
    expect(screen.getByRole('option', { name: 'Default (restricted)' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Network mode'), { target: { value: 'open' } });
    expect(onCommit).toHaveBeenCalledWith('agent_network_mode', 'open');
    fireEvent.change(screen.getByLabelText('Enforce restricted mode'), { target: { value: 'true' } });
    expect(onCommit).toHaveBeenCalledWith('agent_network_mode_enforced', true);
    fireEvent.change(screen.getByLabelText('Repository allowed hosts'), { target: { value: 'true' } });
    expect(onCommit).toHaveBeenCalledWith('agent_network_ignore_repository_allow', true);
    fireEvent.change(screen.getByLabelText('Repository allowed hosts'), { target: { value: '' } });
    expect(onCommit).toHaveBeenLastCalledWith('agent_network_ignore_repository_allow', null);
  });

  it('commits the edited allowlist on blur, normalized; emptying the default draft keeps the default', () => {
    const onCommit = vi.fn();
    render(<AgentNetworkSettingsSection values={unset} onCommit={onCommit} />);
    const allow = screen.getByLabelText('Additional allowed hosts');
    fireEvent.blur(allow);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(allow, { target: { value: 'Registry.Example.com\n*.internal.example.com, registry.example.com' } });
    fireEvent.blur(allow);
    expect(onCommit).toHaveBeenLastCalledWith('agent_network_allow', ['registry.example.com', '*.internal.example.com']);
    onCommit.mockClear();
    fireEvent.change(allow, { target: { value: '  ' } });
    fireEvent.blur(allow);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('distinguishes the environment default from an explicit empty list', () => {
    const onCommit = vi.fn();
    const defaults = { agent_network_mode: 'restricted' as const, agent_network_mode_enforced: false, agent_network_allow: ['env.example.com', 'cache.example.com'] };
    const { rerender } = render(<AgentNetworkSettingsSection values={unset} defaults={defaults} onCommit={onCommit} />);
    const source = screen.getByLabelText('Allowed hosts list');
    expect(source).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Environment default (2 hosts)' })).toBeInTheDocument();
    fireEvent.change(source, { target: { value: 'custom' } });
    expect(onCommit).toHaveBeenLastCalledWith('agent_network_allow', []);

    rerender(<AgentNetworkSettingsSection values={{ ...unset, agent_network_allow: ['registry.example.com'] }} defaults={defaults} onCommit={onCommit} />);
    expect(screen.getByLabelText('Allowed hosts list')).toHaveValue('custom');
    const allow = screen.getByLabelText('Additional allowed hosts');
    fireEvent.change(allow, { target: { value: '  ' } });
    fireEvent.blur(allow);
    expect(onCommit).toHaveBeenLastCalledWith('agent_network_allow', []);
    fireEvent.change(screen.getByLabelText('Allowed hosts list'), { target: { value: '' } });
    expect(onCommit).toHaveBeenLastCalledWith('agent_network_allow', null);
  });

  it('keeps an entry the API would reject in the draft, unsaved, with the reason', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<AgentNetworkSettingsSection values={{ ...unset, agent_network_allow: ['registry.example.com'] }} onCommit={onCommit} />);
    const allow = screen.getByLabelText('Additional allowed hosts');
    for (const invalid of ['*', 'example', 'registry.example.com:70000', 'a.*.example.com']) {
      fireEvent.change(allow, { target: { value: `registry.example.com\n${invalid}` } });
      fireEvent.blur(allow);
      expect(onCommit).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(`"${invalid}"`);
      expect(allow).toHaveAttribute('aria-invalid', 'true');
      expect(allow).toHaveValue(`registry.example.com\n${invalid}`);
    }
    // An unrelated save re-renders with the same saved list: the draft and its error stay.
    rerender(<AgentNetworkSettingsSection values={{ ...unset, agent_network_mode: 'restricted', agent_network_allow: ['registry.example.com'] }} onCommit={onCommit} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.change(allow, { target: { value: 'registry.example.com\n10.0.0.5:6379\n[fd00::1]:8080\n*.internal.example.com' } });
    fireEvent.blur(allow);
    expect(onCommit).toHaveBeenLastCalledWith('agent_network_allow', ['registry.example.com', '10.0.0.5:6379', '[fd00::1]:8080', '*.internal.example.com']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
