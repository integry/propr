import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CurrentUser } from '../../api/proprTypes';
import IdleShutdownSection from './IdleShutdownSection';
import * as api from '../../api/idleShutdownApi';
import { idleShutdownSections } from './settingsDataSections';

vi.mock('../../api/idleShutdownApi', () => ({ getIdleShutdownSettings: vi.fn(), updateIdleShutdownSettings: vi.fn() }));

const base: api.IdleShutdownSettings = {
  enabled: false, afterMs: 900_000, after: '15m', source: 'default', environmentManaged: false,
  environment: { PROPR_IDLE_SHUTDOWN: null, PROPR_IDLE_SHUTDOWN_AFTER: null }, warnings: [],
  status: {
    enabled: false, afterMs: 900_000, source: 'default', idle: false, idleSince: null, shutdownAt: null,
    blockers: [{ signal: 'ui_sessions', detail: '1 open Web UI session' }], nextDueAt: null,
    checkedAt: '2026-11-24T12:00:00.000Z', lastShutdown: null,
    lastWake: { wokeAt: '2026-11-24T08:00:00.000Z', source: 'connect_ping', coldStartMs: 6200, sleptMs: 1000, shutdownAt: '2026-11-24T02:00:00.000Z' },
  },
};
const admin = { id: 'admin', username: 'admin', role: 'admin', permissions: ['instance.manage_settings'] } as CurrentUser;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getIdleShutdownSettings).mockResolvedValue(base);
});
afterEach(cleanup);

describe('idle shutdown settings', () => {
  it('is listed under Maintenance for administrators who manage settings only', () => {
    expect(idleShutdownSections(admin).map(section => [section.id, section.category])).toEqual([['idle-shutdown', 'maintenance']]);
    expect(idleShutdownSections({ ...admin, role: 'member' })).toEqual([]);
    expect(idleShutdownSections({ ...admin, permissions: [] })).toEqual([]);
  });

  it('shows it off by default with what keeps the instance awake and the last wake', async () => {
    render(<IdleShutdownSection />);
    expect(await screen.findByText('1 open Web UI session')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Off');
    expect(screen.getByLabelText('Stop the instance when idle')).not.toBeChecked();
    expect(screen.getByText(/Connect wake ping · cold start 6\.2 s/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves the switch and window', async () => {
    vi.mocked(api.updateIdleShutdownSettings).mockResolvedValue({ ...base, enabled: true, after: '30m', afterMs: 1_800_000, source: 'settings' });
    render(<IdleShutdownSection />);
    fireEvent.click(await screen.findByLabelText('Stop the instance when idle'));
    fireEvent.change(screen.getByLabelText('Idle window'), { target: { value: '30m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateIdleShutdownSettings).toHaveBeenCalledWith({ enabled: true, after: '30m' }));
    expect(await screen.findByText(/applies it within 30 seconds/)).toBeInTheDocument();
  });

  it('is read-only when the environment pins it', async () => {
    vi.mocked(api.getIdleShutdownSettings).mockResolvedValue({
      ...base, enabled: true, source: 'environment', environmentManaged: true,
      environment: { PROPR_IDLE_SHUTDOWN: 'on', PROPR_IDLE_SHUTDOWN_AFTER: null },
    });
    render(<IdleShutdownSection />);
    expect(await screen.findByText(/PROPR_IDLE_SHUTDOWN=on/)).toBeInTheDocument();
    expect(screen.getByLabelText('Stop the instance when idle')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
