import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesktopWindowControls } from './DesktopWindowControls';

describe('DesktopWindowControls', () => {
  it('exposes only keyboard-accessible fixed native window actions', () => {
    const actions = {
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
      closeWindow: vi.fn(async () => undefined),
    };
    render(<DesktopWindowControls actions={actions} />);

    expect(screen.getByRole('group', { name: 'Window controls' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize or restore window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));

    expect(actions.minimize).toHaveBeenCalledOnce();
    expect(actions.toggleMaximize).toHaveBeenCalledOnce();
    expect(actions.closeWindow).toHaveBeenCalledOnce();
  });

  it('renders nothing without the complete narrow control contract', () => {
    const { container } = render(<DesktopWindowControls actions={{ minimize: async () => undefined }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
