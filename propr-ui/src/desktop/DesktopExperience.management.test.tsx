import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adaptersFor, deferred, localProfile, remoteProfile, renderConnectedExperience } from './DesktopExperience.testUtils';
import type { DesktopConnectionResult } from './types';

const apiMock = vi.hoisted(() => ({ setApiBaseUrl: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({ setDesktopApiBaseUrl: vi.fn() }));

vi.mock('../api/apiClient', () => ({ setApiBaseUrl: apiMock.setApiBaseUrl }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: runtimeMock.setDesktopApiBaseUrl }));

describe('DesktopExperience profile management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  it('opens instance management with the desktop shortcut and exposes connection status', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    renderConnectedExperience(adapters);
    expect(await screen.findByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Manage instances' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('traps modal focus, makes the app inert, and restores focus to the opener', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    renderConnectedExperience(adapters);
    const opener = await screen.findByRole('button', { name: 'Connected: This computer' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Manage instances' });
    const app = opener.closest('.desktop-app');
    const close = screen.getByRole('button', { name: 'Close instance manager' });
    const last = screen.getByRole('button', { name: /Add instance/i });
    expect(app).toHaveAttribute('inert');
    expect(app).toHaveAttribute('aria-hidden', 'true');
    expect(dialog).toContainElement(close);
    expect(close).toHaveFocus();
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(app).not.toHaveAttribute('inert');
    expect(opener).toHaveFocus();
  });

  it('connects a new instance added from the manager', async () => {
    const adapters = adaptersFor([localProfile], localProfile.id);
    renderConnectedExperience(adapters, 'Connected app');
    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    vi.clearAllMocks();
    await waitFor(() => {
      fireEvent.keyDown(document, { key: ',', ctrlKey: true });
      expect(screen.getByRole('dialog', { name: 'Manage instances' })).toBeInTheDocument();
    });
    fireEvent.click(await screen.findByRole('button', { name: /Add instance/i }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New server' } });
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://new.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({ name: 'New server', baseUrl: 'https://new.example.com' }));
    expect(adapters.profiles.setActiveId).toHaveBeenCalledWith(expect.any(String));
    expect(runtimeMock.setDesktopApiBaseUrl).toHaveBeenLastCalledWith('https://new.example.com');
    expect(apiMock.setApiBaseUrl).toHaveBeenLastCalledWith('https://new.example.com');
  });

  it.each(['new', 'active'] as const)('closes the instance manager after a %s profile starts connecting', async profileKind => {
    const pendingProbe = deferred<DesktopConnectionResult>();
    const probe = vi.fn().mockResolvedValueOnce({ status: 'ready', version: '0.8.15' }).mockImplementationOnce(() => pendingProbe.promise);
    const adapters = adaptersFor([localProfile], localProfile.id, probe);
    renderConnectedExperience(adapters, 'Connected app');
    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    await waitFor(() => {
      fireEvent.keyDown(document, { key: ',', ctrlKey: true });
      expect(screen.getByRole('dialog', { name: 'Manage instances' })).toBeInTheDocument();
    });
    if (profileKind === 'new') {
      fireEvent.click(await screen.findByRole('button', { name: /Add instance/i }));
      fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New server' } });
      fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://new.example.com/' } });
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
      fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://active.example.com/' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    }
    expect(await screen.findByRole('heading', { name: new RegExp(`Connecting to ${profileKind === 'new' ? 'New server' : 'This computer'}`) })).toBeInTheDocument();
    await act(async () => { pendingProbe.resolve({ status: 'ready', version: '0.8.15' }); });
    const app = await screen.findByText('Connected app');
    expect(screen.queryByRole('dialog', { name: 'Manage instances' })).not.toBeInTheDocument();
    expect(app.closest('.desktop-app')).not.toHaveAttribute('inert');
    expect(app.closest('.desktop-app')).not.toHaveAttribute('aria-hidden');
  });

  it('reconnects an edited active instance but saves an inactive edit without connecting', async () => {
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    renderConnectedExperience(adapters, 'Connected app');
    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    vi.clearAllMocks();
    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://active.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    expect(adapters.connection.probe).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://active.example.com' }));
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://active.example.com' }));
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    expect(apiMock.setApiBaseUrl).toHaveBeenLastCalledWith('https://active.example.com');
    vi.clearAllMocks();
    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Team server' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Renamed team server' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Renamed team server')).toBeInTheDocument();
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote', name: 'Renamed team server' }));
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    expect(apiMock.setApiBaseUrl).not.toHaveBeenCalled();
  });

  it('does not persist an active profile edit until the updated connection is ready', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ status: 'ready', version: '0.8.15' }).mockResolvedValueOnce({ status: 'offline', message: 'The updated server is unavailable.' });
    const adapters = adaptersFor([localProfile], localProfile.id, probe);
    renderConnectedExperience(adapters, 'Connected app');
    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    vi.clearAllMocks();
    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit This computer' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://unavailable.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('The updated server is unavailable.')).toBeInTheDocument();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    expect(adapters.profiles.setActiveId).not.toHaveBeenCalled();
    expect(runtimeMock.setDesktopApiBaseUrl).not.toHaveBeenCalled();
    expect(apiMock.setApiBaseUrl).not.toHaveBeenCalled();
  });

  it('keeps a failed save in the manager editor so it can be retried', async () => {
    const adapters = adaptersFor([localProfile, remoteProfile], localProfile.id);
    vi.mocked(adapters.profiles.save).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Profile storage is locked.')).mockResolvedValueOnce(undefined);
    renderConnectedExperience(adapters, 'Connected app');
    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Connected: This computer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Team server' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Retryable edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save this instance.*storage is locked.*try again/i);
    expect(screen.getByLabelText('Display name')).toHaveValue('Retryable edit');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Retryable edit')).toBeInTheDocument();
  });

  it('keeps a profile visible and reports a rejected removal', async () => {
    const adapters = adaptersFor([remoteProfile]);
    vi.mocked(adapters.profiles.remove).mockRejectedValueOnce(new Error('Profile storage is locked.'));
    renderConnectedExperience(adapters);
    expect(await screen.findByText('Team server')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Team server' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not remove this instance.*storage is locked.*try again/i);
    expect(screen.getByText('Team server')).toBeInTheDocument();
    expect(adapters.profiles.remove).toHaveBeenCalledWith(remoteProfile.id);
  });
});
