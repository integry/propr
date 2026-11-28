import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser } from '../../api/proprTypes';
import InstanceSpritesSection from './InstanceSpritesSection';
import * as api from '../../api/instanceSpritesApi';
import { agentRuntimeSections } from './settingsDataSections';

vi.mock('../../api/instanceSpritesApi', () => ({ getInstanceSprites: vi.fn(), removeInstanceSprites: vi.fn() }));

const PREFIX = 'propr-a21b1d274add47ba-';
const admin = { id: 'admin', username: 'admin', role: 'admin', permissions: ['instance.manage_runtime'] } as CurrentUser;
const listed: api.InstanceSprites = {
  configured: true, prefix: PREFIX, count: 2, busy: 0,
  sprites: [
    { name: `${PREFIX}aaa`, status: 'cold', createdAt: '2026-11-27T22:56:00.000Z' },
    { name: `${PREFIX}bbb`, status: 'warm', createdAt: null },
  ],
};
const view = (user = admin) => <AuthProvider user={user}><InstanceSpritesSection /></AuthProvider>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getInstanceSprites).mockResolvedValue(listed);
});
afterEach(cleanup);

describe('agent runtime Sprites cleanup', () => {
  it('is listed under Maintenance for administrators who manage the runtime only', () => {
    expect(agentRuntimeSections(admin).map(section => [section.id, section.category])).toEqual([['agent-runtime', 'maintenance']]);
    expect(agentRuntimeSections({ ...admin, role: 'member' })).toEqual([]);
    expect(agentRuntimeSections({ ...admin, permissions: ['instance.manage_settings'] })).toEqual([]);
  });

  it('hides itself from members without calling the API', () => {
    render(view({ ...admin, role: 'member' }));
    expect(screen.queryByText('Agent runtime')).not.toBeInTheDocument();
    expect(api.getInstanceSprites).not.toHaveBeenCalled();
  });

  it('lists the instance Sprites and confirms with the count before removing them', async () => {
    vi.mocked(api.removeInstanceSprites).mockResolvedValue({ deleted: 2, failed: [] });
    render(view());
    expect(await screen.findByText(`${PREFIX}aaa`)).toBeInTheDocument();
    expect(screen.getByTestId('instance-sprites-prefix')).toHaveTextContent(PREFIX);
    fireEvent.click(screen.getByRole('button', { name: 'Remove all Sprites of this instance' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove 2 Sprites?' });
    expect(api.removeInstanceSprites).not.toHaveBeenCalled();
    vi.mocked(api.getInstanceSprites).mockResolvedValue({ ...listed, count: 0, sprites: [] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 2 Sprites' }));
    await waitFor(() => expect(api.removeInstanceSprites).toHaveBeenCalledWith(2));
    expect(await screen.findByText('Removed 2 Sprites.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove all Sprites of this instance' })).not.toBeInTheDocument();
  });

  it('cancelling the confirmation removes nothing', async () => {
    render(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Remove all Sprites of this instance' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.removeInstanceSprites).not.toHaveBeenCalled();
  });

  it('blocks removal while an agent run uses a Sprite', async () => {
    vi.mocked(api.getInstanceSprites).mockResolvedValue({ ...listed, busy: 1 });
    render(view());
    expect(await screen.findByText(/An agent run is using a Sprite/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove all Sprites of this instance' })).toBeDisabled();
  });

  it('shows the error and the refreshed list when removal fails', async () => {
    vi.mocked(api.removeInstanceSprites).mockRejectedValue(new Error('This instance now has 3 Sprites; confirm again'));
    render(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Remove all Sprites of this instance' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove 2 Sprites' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('confirm again');
    await waitFor(() => expect(api.getInstanceSprites).toHaveBeenCalledTimes(2));
  });

  it('explains when no Sprites token is configured', async () => {
    vi.mocked(api.getInstanceSprites).mockResolvedValue({ configured: false, prefix: null, count: 0, busy: 0, sprites: [] });
    render(view());
    expect(await screen.findByText(/No Sprites token is set on this instance/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove all Sprites of this instance' })).not.toBeInTheDocument();
  });
});
