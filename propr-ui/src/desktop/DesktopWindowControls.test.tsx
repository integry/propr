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

  it('omits the application menu control unless the Linux host provides it', () => {
    render(<DesktopWindowControls actions={{ minimize: async () => undefined, toggleMaximize: async () => undefined, closeWindow: async () => undefined }} />);
    expect(screen.queryByRole('button', { name: 'Application menu' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F10' });
  });

  it('opens the native application menu from pointer and keyboard below the control without stealing input focus', () => {
    const showApplicationMenu = vi.fn(async () => undefined);
    render(<>
      <input aria-label="Task title" />
      <DesktopWindowControls actions={{
        minimize: async () => undefined, toggleMaximize: async () => undefined, closeWindow: async () => undefined,
        showApplicationMenu,
      }} />
    </>);
    const button = screen.getByRole('button', { name: 'Application menu' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'F10 Alt+F');
    // Branded with the existing ProPR mark; decorative, so the name stays put.
    expect(button).toHaveAttribute('title', 'ProPR application menu (F10)');
    expect(button.querySelector('img')).toHaveAttribute('src', '/logo.png');
    expect(button.querySelector('img')).toHaveAttribute('alt', '');
    expect(button.querySelector('svg')).toBeNull();
    const group = screen.getByRole('group', { name: 'Window controls' });
    expect(group.firstElementChild).toBe(button);
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 696, bottom: 44, top: 0, right: 742, width: 46, height: 44, x: 696, y: 0, toJSON: () => ({}) });

    const input = screen.getByRole('textbox', { name: 'Task title' });
    input.focus();
    // Pointer activation must leave the field focused so Edit roles act on it.
    expect(fireEvent.mouseDown(button, { button: 0 })).toBe(false);
    fireEvent.click(button, { detail: 1 });
    expect(input).toHaveFocus();
    expect(showApplicationMenu).toHaveBeenLastCalledWith({ x: 696, y: 44, source: 'mouse' });

    // F10 and Alt+F open it from wherever focus is, without moving focus.
    fireEvent.keyDown(input, { key: 'F10' });
    expect(showApplicationMenu).toHaveBeenLastCalledWith({ x: 696, y: 44, source: 'keyboard' });
    fireEvent.keyDown(input, { key: 'f', code: 'KeyF', altKey: true });
    expect(showApplicationMenu).toHaveBeenCalledTimes(3);
    expect(input).toHaveFocus();
    for (const event of [{ key: 'F10', ctrlKey: true }, { key: 'F10', shiftKey: true }, { key: 'f', code: 'KeyF', ctrlKey: true, altKey: true }, { key: 'f', code: 'KeyF' }, { key: 'F10', repeat: true }]) {
      fireEvent.keyDown(input, event);
    }
    expect(showApplicationMenu).toHaveBeenCalledTimes(3);

    // A keyboard-activated button click (Enter/Space) reports keyboard input.
    button.focus();
    fireEvent.click(button, { detail: 0 });
    expect(showApplicationMenu).toHaveBeenLastCalledWith({ x: 696, y: 44, source: 'keyboard' });
  });

  it('stops listening for the menu shortcut once unmounted', () => {
    const showApplicationMenu = vi.fn(async () => { throw new Error('host unavailable'); });
    const { unmount } = render(<DesktopWindowControls actions={{
      minimize: async () => undefined, toggleMaximize: async () => undefined, closeWindow: async () => undefined,
      showApplicationMenu,
    }} />);
    fireEvent.keyDown(window, { key: 'F10' });
    expect(showApplicationMenu).toHaveBeenCalledOnce();
    unmount();
    fireEvent.keyDown(window, { key: 'F10' });
    expect(showApplicationMenu).toHaveBeenCalledOnce();
  });

  it('renders nothing without the complete narrow control contract', () => {
    const { container } = render(<DesktopWindowControls actions={{ minimize: async () => undefined }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
