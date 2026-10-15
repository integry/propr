import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { adaptersFor, localProfile, renderConnectedExperience } from './DesktopExperience.testSupport';
import { guidedAdapter } from './LocalSetupWizard.integration.testSupport';

vi.mock('../api/apiClient', () => ({ setApiBaseUrl: vi.fn() }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: vi.fn() }));

describe('DesktopExperience Linux window controls', () => {
  it('keeps native window actions outside the inert app and actionable while instance management is open', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    const minimize = vi.fn(async () => undefined);
    const toggleMaximize = vi.fn(async () => undefined);
    const closeWindow = vi.fn(async () => undefined);
    adapters.app = { ...adapters.app, minimize, toggleMaximize, closeWindow };
    renderConnectedExperience(adapters);

    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manage instances' });
    const controls = screen.getByRole('group', { name: 'Window controls' });

    expect(controls.closest('[inert]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize or restore window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));

    expect(minimize).toHaveBeenCalledOnce();
    expect(toggleMaximize).toHaveBeenCalledOnce();
    expect(closeWindow).toHaveBeenCalledOnce();
    expect(dialog).toBeInTheDocument();
  });

  it('offers the application menu on Linux entry, setup and recovery surfaces', async () => {
    const withMenu = (adapters: ReturnType<typeof adaptersFor>) => {
      const showApplicationMenu = vi.fn(async () => undefined);
      adapters.app = { ...adapters.app, minimize: vi.fn(async () => undefined), toggleMaximize: vi.fn(async () => undefined), closeWindow: vi.fn(async () => undefined), showApplicationMenu };
      return showApplicationMenu;
    };
    const entry = { ...adaptersFor([localProfile]), localSetup: guidedAdapter() };
    const showFromEntry = withMenu(entry);
    const { container, unmount } = render(<DesktopExperience adapters={entry}><div>Connected workspace</div></DesktopExperience>);
    await screen.findByRole('heading', { name: 'Choose an instance' });
    expect(container.querySelector('.desktop-entry')).toHaveClass('desktop-platform-linux', 'desktop-has-application-menu');
    fireEvent.click(screen.getByRole('button', { name: 'Application menu' }), { detail: 1 });
    expect(showFromEntry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /Set up this computer/ }));
    await screen.findByRole('heading', { name: 'Check the essentials' });
    fireEvent.keyDown(window, { key: 'F10' });
    expect(showFromEntry).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'keyboard' }));
    unmount();

    const recovery = adaptersFor([localProfile], localProfile.id, async () => ({ status: 'offline', message: 'The instance is offline.' }));
    const showFromRecovery = withMenu(recovery);
    render(<DesktopExperience adapters={recovery}><div>Connected workspace</div></DesktopExperience>);
    await screen.findByRole('button', { name: 'Open connection help' });
    fireEvent.click(screen.getByRole('button', { name: 'Application menu' }), { detail: 1 });
    expect(showFromRecovery).toHaveBeenCalledOnce();
  });

  it('keeps the application menu outside the inert connected app while instance management is open', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    const showApplicationMenu = vi.fn(async () => undefined);
    adapters.app = { ...adapters.app, minimize: vi.fn(async () => undefined), toggleMaximize: vi.fn(async () => undefined), closeWindow: vi.fn(async () => undefined), showApplicationMenu };
    const { container } = renderConnectedExperience(adapters);

    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
    await screen.findByRole('dialog', { name: 'Manage instances' });
    expect(container.querySelector('.desktop-app')).toHaveClass('desktop-has-application-menu');
    const menu = screen.getByRole('button', { name: 'Application menu' });
    expect(menu.closest('[inert]')).toBeNull();
    fireEvent.click(menu, { detail: 1 });
    expect(showApplicationMenu).toHaveBeenCalledOnce();
  });

  it('does not render a Linux application menu control on macOS', async () => {
    const adapters = { ...adaptersFor([localProfile], localProfile.id), platform: 'macos' as const };
    adapters.app = { ...adapters.app, showApplicationMenu: vi.fn(async () => undefined) };
    const { container } = renderConnectedExperience(adapters);
    await screen.findByRole('button', { name: 'Connected: This computer' });
    expect(screen.queryByRole('button', { name: 'Application menu' })).not.toBeInTheDocument();
    expect(container.querySelector('.desktop-has-application-menu')).toBeNull();
    fireEvent.keyDown(window, { key: 'F10' });
    expect(adapters.app.showApplicationMenu).not.toHaveBeenCalled();
  });
});
