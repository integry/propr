import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { AgentTankMode } from '@propr/shared';
import AgentTankSection, { type AgentTankSettings } from './AgentTankSection';

function settings(mode: AgentTankMode): AgentTankSettings {
  return { mode, enabled: mode !== 'disabled', url: 'http://0.0.0.0:3456' };
}

describe('AgentTankSection', () => {
  test('hides the daemon URL for disabled and bundled modes', () => {
    const { rerender } = render(
      <AgentTankSection settings={settings('disabled')} onChange={vi.fn()} />
    );
    expect(screen.queryByLabelText('Daemon URL')).toBeNull();

    rerender(<AgentTankSection settings={settings('bundled')} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('Daemon URL')).toBeNull();
  });

  test('shows the daemon URL only for external mode', () => {
    render(<AgentTankSection settings={settings('external')} onChange={vi.fn()} />);

    expect(screen.getByLabelText('Daemon URL')).toHaveValue('http://0.0.0.0:3456');
  });

  test('selecting a mode reports that mode with a consistent derived enabled flag', () => {
    const onChange = vi.fn();
    render(<AgentTankSection settings={settings('disabled')} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText(/Bundled/));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'bundled', enabled: true }));
  });

  test('selecting disabled reports enabled false', () => {
    const onChange = vi.fn();
    render(<AgentTankSection settings={settings('external')} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Disabled'));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'disabled', enabled: false }));
  });

  test('bundled mode never claims a URL is unreachable', () => {
    const { rerender } = render(
      <AgentTankSection settings={settings('bundled')} onChange={vi.fn()} isAvailable={false} />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Bundled Agent Tank unavailable');

    rerender(<AgentTankSection settings={settings('external')} onChange={vi.fn()} isAvailable={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Agent Tank unreachable');
  });

  test('disabled mode shows no connection status at all', () => {
    render(<AgentTankSection settings={settings('disabled')} onChange={vi.fn()} isAvailable={false} />);

    expect(screen.queryByRole('status')).toBeNull();
  });
});
