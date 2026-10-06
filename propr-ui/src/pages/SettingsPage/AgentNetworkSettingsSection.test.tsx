import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentNetworkSettingsSection } from './AgentNetworkSettingsSection';

const unset = { agent_network_mode: null, agent_network_mode_enforced: null, agent_network_allow: null };

describe('AgentNetworkSettingsSection', () => {
  it('shows the environment defaults and saves a chosen mode', () => {
    const onCommit = vi.fn();
    render(<AgentNetworkSettingsSection values={unset} defaults={{ agent_network_mode: 'restricted', agent_network_mode_enforced: false }} onCommit={onCommit} />);
    expect(screen.getByRole('option', { name: 'Default (restricted)' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Network mode'), { target: { value: 'open' } });
    expect(onCommit).toHaveBeenCalledWith('agent_network_mode', 'open');
    fireEvent.change(screen.getByLabelText('Enforce restricted mode'), { target: { value: 'true' } });
    expect(onCommit).toHaveBeenCalledWith('agent_network_mode_enforced', true);
  });

  it('commits the edited allowlist on blur, normalized, and an empty list as the default', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<AgentNetworkSettingsSection values={unset} onCommit={onCommit} />);
    const allow = screen.getByLabelText('Additional allowed hosts');
    fireEvent.blur(allow);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(allow, { target: { value: 'Registry.Example.com\n*.internal.example.com, registry.example.com' } });
    fireEvent.blur(allow);
    expect(onCommit).toHaveBeenLastCalledWith('agent_network_allow', ['registry.example.com', '*.internal.example.com']);
    rerender(<AgentNetworkSettingsSection values={{ ...unset, agent_network_allow: ['registry.example.com'] }} onCommit={onCommit} />);
    fireEvent.change(screen.getByLabelText('Additional allowed hosts'), { target: { value: '  ' } });
    fireEvent.blur(screen.getByLabelText('Additional allowed hosts'));
    expect(onCommit).toHaveBeenLastCalledWith('agent_network_allow', null);
  });
});
