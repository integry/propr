import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { adaptersFor, localProfile, renderConnectedExperience } from './DesktopExperience.testSupport';

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
});
