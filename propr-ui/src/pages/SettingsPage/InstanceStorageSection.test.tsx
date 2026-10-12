import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser } from '../../api/proprTypes';
import InstanceStorageSection from './InstanceStorageSection';
import * as api from '../../api/instanceStorageApi';
vi.mock('../../api/instanceStorageApi', async importOriginal => ({ ...await importOriginal<typeof import('../../api/instanceStorageApi')>(), storageCapabilities: vi.fn(), storageInventory: vi.fn(), storagePreview: vi.fn(), storageExecute: vi.fn(), startDatabaseExport: vi.fn(), databaseExportStatus: vi.fn(), downloadDatabaseExport: vi.fn(), cancelDatabaseExport: vi.fn(), verifyStorageActor: vi.fn() }));
const user = { id: 'admin', username: 'admin', role: 'admin', permissions: ['instance.manage_settings'] } as CurrentUser;
const capabilities = { version: 1 as const, instanceId: 'instance', generation: 'generation', features: ['repository_inventory', 'repository_cleanup', 'database_export'] as const };
const inventory = { version: 1 as const, instanceId: 'instance', state: 'partial' as const, observedAt: new Date().toISOString(), lastUseAt: null, repositories: [{ id: 'repo', name: 'example/project', category: 'repository_caches' as const, estimatedBytes: null, protectedReasons: [] }] };
const view = (actor = user) => <AuthProvider user={actor}><InstanceStorageSection /></AuthProvider>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.verifyStorageActor).mockResolvedValue(undefined);
  vi.mocked(api.storageCapabilities).mockResolvedValue({ ...capabilities, features: [...capabilities.features] });
  vi.mocked(api.storageInventory).mockResolvedValue(inventory);
  vi.mocked(api.storagePreview).mockResolvedValue({ version: 1, instanceId: 'instance', confirmation: 'confirmation', expiresAt: new Date(Date.now() + 60_000).toISOString(), categories: ['repository_caches'], candidates: inventory.repositories, impact: 'Caches will be refetched.' });
  vi.mocked(api.storageExecute).mockResolvedValue({ version: 1, instanceId: 'instance', operationId: 'confirmation', state: 'completed', deleted: ['repo'], retained: [] });
});
afterEach(cleanup);
describe('native instance storage', () => {
  it('hides controls for ordinary members even if repository access or stale permissions exist', () => {
    render(view({ ...user, role: 'member' }));
    expect(screen.queryByText('Instance data')).not.toBeInTheDocument();
    expect(api.storageCapabilities).not.toHaveBeenCalled();
  });
  it('shows self-hosted inventory with unknown sizes and requires explicit cleanup confirmation', async () => {
    render(view());
    expect(await screen.findByText('example/project')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview cache cleanup' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm cleanup' });
    expect(confirm).toBeDisabled(); expect(api.storageExecute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirm);
    expect(await screen.findByText('Cleanup completed: 1 deleted, 0 retained.')).toBeInTheDocument();
    expect(api.storageExecute).toHaveBeenCalledTimes(1);
  });
  it('old/offline runtime clears authority without fabricating an empty inventory', async () => {
    vi.mocked(api.storageCapabilities).mockRejectedValue(new Error('Runtime unsupported'));
    render(view());
    expect(await screen.findByRole('alert')).toHaveTextContent('Runtime unsupported');
    expect(screen.getByRole('button', { name: 'Create database export' })).toBeDisabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
  it('server account switch clears a pending confirmation before execution', async () => {
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Preview cache cleanup' }));
    await screen.findByRole('button', { name: 'Confirm cleanup' });
    fireEvent.click(screen.getByRole('checkbox'));
    vi.mocked(api.verifyStorageActor).mockRejectedValue(new Error('Account changed'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cleanup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Account changed');
    expect(api.storageExecute).not.toHaveBeenCalled();
    expect(screen.queryByText('example/project')).not.toBeInTheDocument();
  });
  it('an expired or consumed confirmation clears the dead preview but keeps instance data and the export job', async () => {
    vi.mocked(api.startDatabaseExport).mockResolvedValue({ version: 1, instanceId: 'instance', generation: 'generation', operationId: 'job', scope: 'customer_database', state: 'ready', expiresAt: new Date(Date.now() + 60_000).toISOString(), sizeBytes: 1, sha256: 'a'.repeat(64), schemaVersion: 7, migration: null });
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Create database export' }));
    await screen.findByRole('button', { name: 'Download once' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview cache cleanup' }));
    await screen.findByRole('button', { name: 'Confirm cleanup' });
    fireEvent.click(screen.getByRole('checkbox'));
    vi.mocked(api.storageExecute).mockRejectedValue(new api.StorageConfirmationError('Confirmation expired. Preview cleanup again.'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cleanup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirmation expired');
    expect(screen.queryByRole('button', { name: 'Confirm cleanup' })).not.toBeInTheDocument();
    expect(screen.getByText('example/project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview cache cleanup' })).toBeEnabled();
  });
  it('a transient cleanup failure keeps the preview for a retry', async () => {
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Preview cache cleanup' }));
    await screen.findByRole('button', { name: 'Confirm cleanup' });
    fireEvent.click(screen.getByRole('checkbox'));
    vi.mocked(api.storageExecute).mockRejectedValueOnce(new api.StorageTransientError('Storage is busy. Try again shortly.'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cleanup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('busy');
    expect(screen.getByRole('button', { name: 'Confirm cleanup' })).toBeInTheDocument();
  });
  it('account change unmounts old results; a late inventory cannot repopulate them', async () => {
    let resolve!: (value: typeof inventory) => void;
    vi.mocked(api.storageInventory).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const rendered = render(view());
    await waitFor(() => expect(api.storageInventory).toHaveBeenCalled());
    rendered.rerender(view({ ...user, id: 'member', role: 'member', permissions: [] }));
    resolve(inventory);
    await waitFor(() => expect(screen.queryByText('example/project')).not.toBeInTheDocument());
    expect(screen.queryByText('Instance data')).not.toBeInTheDocument();
  });
  it('creates an export without a Connect account and presents a server failure safely', async () => {
    vi.mocked(api.startDatabaseExport).mockResolvedValue({ version: 1, instanceId: 'instance', generation: 'generation', operationId: 'job', scope: 'customer_database', state: 'failed', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Create database export' }));
    expect(await screen.findByText('Export failed; no download is available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download once' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard export' }));
    await waitFor(() => expect(api.cancelDatabaseExport).toHaveBeenCalled());
  });
});

describe('database export job across transient and authority-bearing failures', () => {
  const running = { version: 1 as const, instanceId: 'instance', generation: 'generation', operationId: 'job', scope: 'customer_database' as const, state: 'running' as const, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  const ready = { ...running, state: 'ready' as const, sizeBytes: 4096, sha256: 'a'.repeat(64), schemaVersion: 7, migration: 'customer-schema-v1' };
  const transient = () => new api.StorageTransientError('Storage operation temporarily unavailable. Try again.');
  async function started() {
    vi.mocked(api.startDatabaseExport).mockResolvedValue(running);
    vi.mocked(api.databaseExportStatus).mockReturnValue(new Promise(() => {}));
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Create database export' }));
    expect(await screen.findByText(/Export: running/)).toBeInTheDocument();
  }
  const jobShown = () => screen.queryByRole('button', { name: 'Discard export' });

  it('a transient status-poll failure keeps the job and polling continues until ready', async () => {
    vi.mocked(api.startDatabaseExport).mockResolvedValue(running);
    vi.mocked(api.databaseExportStatus).mockRejectedValueOnce(transient()).mockResolvedValue(ready);
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Create database export' }));
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('temporarily unavailable');
    expect(screen.getByText(/Export: running/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Download once' }, { timeout: 5000 })).toBeInTheDocument();
    expect(api.databaseExportStatus).toHaveBeenCalledTimes(2);
  }, 10_000);

  for (const [name, failure] of [
    ['inventory 503', () => vi.mocked(api.storageInventory).mockRejectedValue(transient())],
    ['network failure', () => vi.mocked(api.storageCapabilities).mockRejectedValue(new api.StorageTransientError('Storage service unreachable. Check the connection and try again.'))],
    ['409 busy', () => vi.mocked(api.storageInventory).mockRejectedValue(new api.StorageTransientError('Another database export is in progress. Wait for it to finish or expire, then try again.'))],
  ] as const) {
    it(`a transient refresh failure (${name}) keeps the job so it can still be discarded`, async () => {
      await started();
      failure();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/Export: running/)).toBeInTheDocument();
      vi.mocked(api.storageCapabilities).mockResolvedValue({ ...capabilities, features: [...capabilities.features] });
      fireEvent.click(jobShown()!);
      await waitFor(() => expect(api.cancelDatabaseExport).toHaveBeenCalledWith(running));
      await waitFor(() => expect(jobShown()).not.toBeInTheDocument());
    });
  }

  it('a transient discard failure keeps the job for a retry', async () => {
    await started();
    vi.mocked(api.cancelDatabaseExport).mockRejectedValueOnce(transient());
    fireEvent.click(jobShown()!);
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(jobShown()).toBeInTheDocument();
    fireEvent.click(jobShown()!);
    await waitFor(() => expect(jobShown()).not.toBeInTheDocument());
    expect(api.cancelDatabaseExport).toHaveBeenCalledTimes(2);
  });

  it('a 409 lock state from export creation is shown without clearing instance authority', async () => {
    vi.mocked(api.startDatabaseExport).mockRejectedValue(new api.StorageTransientError('A previous database export expired and its lock can be recovered after 2026-10-12T20:00:00.000Z. Try again then.'));
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Create database export' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('can be recovered after');
    expect(screen.getByText('example/project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create database export' })).toBeEnabled();
  });

  for (const [name, failure] of [
    ['401/403 on status refresh', () => vi.mocked(api.storageCapabilities).mockRejectedValue(new Error('Current instance administrator access is required.'))],
    ['actor/account switch', () => vi.mocked(api.verifyStorageActor).mockRejectedValue(new Error('Account or instance authority changed. Reload Settings.'))],
    ['instance mismatch', () => vi.mocked(api.storageCapabilities).mockResolvedValue({ ...capabilities, instanceId: 'other-instance', features: [...capabilities.features] })],
    ['generation mismatch', () => vi.mocked(api.storageCapabilities).mockResolvedValue({ ...capabilities, generation: 'restarted', features: [...capabilities.features] })],
    ['generation mismatch followed by a transient inventory failure', () => {
      vi.mocked(api.storageCapabilities).mockResolvedValue({ ...capabilities, generation: 'restarted', features: [...capabilities.features] });
      vi.mocked(api.storageInventory).mockRejectedValue(transient());
    }],
  ] as const) {
    it(`${name} clears the job`, async () => {
      await started();
      failure();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
      await waitFor(() => expect(jobShown()).not.toBeInTheDocument());
      expect(screen.queryByText(/Export: running/)).not.toBeInTheDocument();
    });
  }

  it('401/403 from a status poll clears the job and authority', async () => {
    vi.mocked(api.startDatabaseExport).mockResolvedValue(running);
    vi.mocked(api.databaseExportStatus).mockRejectedValue(new Error('Current instance administrator access is required.'));
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Create database export' }));
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('administrator access is required');
    expect(jobShown()).not.toBeInTheDocument();
    expect(screen.queryByText('example/project')).not.toBeInTheDocument();
  });

  it('a status poll for a different generation clears the job', async () => {
    vi.mocked(api.startDatabaseExport).mockResolvedValue(running);
    vi.mocked(api.databaseExportStatus).mockResolvedValue({ ...running, generation: 'restarted' });
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Create database export' }));
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('Instance selection changed');
    expect(jobShown()).not.toBeInTheDocument();
  });

  it('an export the server no longer holds is dropped while instance data remains', async () => {
    vi.mocked(api.startDatabaseExport).mockResolvedValue(running);
    vi.mocked(api.databaseExportStatus).mockRejectedValue(new api.StorageExportGoneError('This export is no longer available. Create a new export.'));
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Create database export' }));
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('no longer available');
    expect(jobShown()).not.toBeInTheDocument();
    expect(screen.getByText('example/project')).toBeInTheDocument();
  });
});
