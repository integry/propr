import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPlugin, getPluginActivity, PluginApiError, resumePluginDeliveries, retryPluginDelivery,
  type PluginActivityView, type PluginDeliveryView, type PluginHealthView,
} from '../../api/pluginsApi';
import { exampleAt, renderPluginsPage } from './pluginFixtures.testUtils';

vi.mock('../../api/pluginsApi', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPlugin: vi.fn(), getPluginActivity: vi.fn(), retryPluginDelivery: vi.fn(), resumePluginDeliveries: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({ agents: [], repositories: [{ name: 'acme/web' }] }) }));
vi.mock('../../api/extensionProfilesApi', () => ({
  getExtensionLibrary: vi.fn().mockResolvedValue({ oauth: { redirectUri: 'https://propr.example.com/api/instance/extensions/v1/oauth/callback', clientMetadataUrl: null, connections: {} } }),
}));

const AT = Date.UTC(2026, 10, 15, 12, 0, 0);
const healthy: PluginHealthView = { state: 'healthy', consecutiveFailures: 0, pauseAfterFailures: 10, lastError: null, lastErrorAt: null, degradedAt: null, pausedAt: null };
const delivery = (overrides: Partial<PluginDeliveryView>): PluginDeliveryView => ({
  id: 1, deliveryId: 'evt-41-onMerged', kind: 'event', repository: 'acme/web', eventSeq: 41, eventType: 'pull_request.merged', handler: 'onMerged',
  status: 'succeeded', attempt: 1, nextAttemptAt: null, createdAt: AT, startedAt: AT, finishedAt: AT + 120, durationMs: 120, timedOut: false,
  error: null, logs: [{ level: 'info', message: 'posted to #releases', at: AT }], ...overrides,
});
const failed = delivery({ id: 3, deliveryId: 'evt-43-onMerged', eventSeq: 43, status: 'failed', attempt: 5, error: 'chat API answered 503', logs: [] });
const retrying = delivery({ id: 2, deliveryId: 'evt-42-onTask', eventSeq: 42, eventType: 'task.completed', handler: 'onTask', status: 'retrying', attempt: 2, nextAttemptAt: AT + 300_000, durationMs: 30_000, timedOut: true, error: 'The handler did not finish within 30 seconds', logs: [] });
const gap = delivery({ id: 4, deliveryId: 'gap-10-20-acme/web', kind: 'gap', eventSeq: 10, eventType: null, handler: null, status: 'skipped', attempt: 0, durationMs: null, error: 'Events after 9 up to 20 may have left the journal (retention) before they were delivered', logs: [] });

const open = async (activity: PluginActivityView) => {
  vi.mocked(getPlugin).mockResolvedValue({ plugin: { ...exampleAt('enabled'), audit: [] } });
  vi.mocked(getPluginActivity).mockResolvedValue(activity);
  renderPluginsPage('/plugins/example-pack');
  await screen.findByRole('heading', { level: 1, name: /Example pack/ });
  return screen.findByRole('list', { name: 'Deliveries' }).catch(() => null);
};
const region = () => screen.getByRole('region', { name: 'Activity' });
const items = () => within(region()).getAllByTestId('plugin-delivery');

describe('Plugin activity', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists each delivery with its time, kind, handler, outcome, duration, attempt, error and log lines', async () => {
    await open({ health: healthy, deliveries: [gap, failed, retrying, delivery({})] });
    expect(getPluginActivity).toHaveBeenCalledWith('example-pack');
    expect(items().map(item => item.dataset.status)).toEqual(['skipped', 'failed', 'retrying', 'succeeded']);
    const [gapItem, failedItem, retryingItem, succeeded] = items();
    expect(gapItem).toHaveTextContent('Events not delivered');
    expect(gapItem).toHaveTextContent('may have left the journal');
    expect(within(gapItem).queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(failedItem).toHaveTextContent('pull_request.merged');
    expect(failedItem).toHaveTextContent('onMerged');
    expect(failedItem).toHaveTextContent('Attempt 5');
    expect(failedItem).toHaveTextContent('chat API answered 503');
    expect(retryingItem).toHaveTextContent('30.0 s (timed out)');
    expect(retryingItem).toHaveTextContent('Next attempt');
    expect(within(retryingItem).queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(succeeded).toHaveTextContent('120 ms');
    expect(succeeded).toHaveTextContent(new Date(AT).toLocaleString());
    expect(within(succeeded).getByText('Log (1 line)')).toBeInTheDocument();
    expect(succeeded).toHaveTextContent('posted to #releases');
    expect(screen.queryByTestId('plugin-health')).toBeNull();
    expect(screen.queryByTestId('plugin-health-notice')).toBeNull();
  });

  it('retries a failed delivery and reads the activity again', async () => {
    await open({ health: healthy, deliveries: [failed] });
    vi.mocked(retryPluginDelivery).mockResolvedValue({ delivery: { ...failed, status: 'pending', nextAttemptAt: AT } });
    vi.mocked(getPluginActivity).mockResolvedValue({ health: healthy, deliveries: [{ ...failed, status: 'pending', nextAttemptAt: AT }] });
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Retry pull_request.merged to onMerged' })); });
    expect(retryPluginDelivery).toHaveBeenCalledWith('example-pack', 3);
    expect(getPluginActivity).toHaveBeenCalledTimes(2);
    expect(items()[0].dataset.status).toBe('pending');
    expect(within(region()).getByRole('status')).toHaveTextContent('Retry scheduled');
  });

  it('shows the API refusal of a retry', async () => {
    await open({ health: healthy, deliveries: [failed] });
    vi.mocked(retryPluginDelivery).mockRejectedValue(new PluginApiError(409, 'Only a failed event delivery can be retried'));
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: /^Retry / })); });
    expect(within(region()).getByRole('alert')).toHaveTextContent('Only a failed event delivery can be retried');
  });

  it('shows Degraded with the last error in the header and the activity', async () => {
    await open({ health: { ...healthy, state: 'degraded', consecutiveFailures: 3, lastError: 'chat API answered 503', lastErrorAt: AT, degradedAt: AT }, deliveries: [failed] });
    expect(screen.getByTestId('plugin-health')).toHaveTextContent('Degraded');
    const notice = screen.getByTestId('plugin-health-notice');
    expect(notice).toHaveTextContent('Degraded: 3 deliveries failed in a row. Deliveries pause after 10.');
    expect(notice).toHaveTextContent('Last error');
    expect(notice).toHaveTextContent('chat API answered 503');
    expect(within(notice).queryByRole('button', { name: 'Resume deliveries' })).toBeNull();
  });

  it('shows Paused with Resume, and resumes', async () => {
    await open({ health: { ...healthy, state: 'paused', consecutiveFailures: 10, lastError: 'chat API answered 503', lastErrorAt: AT, degradedAt: AT, pausedAt: AT }, deliveries: [failed] });
    expect(screen.getByTestId('plugin-health')).toHaveTextContent('Paused');
    const notice = screen.getByTestId('plugin-health-notice');
    expect(notice).toHaveTextContent('Deliveries are paused after 10 failures in a row');
    vi.mocked(resumePluginDeliveries).mockResolvedValue({ health: healthy });
    vi.mocked(getPluginActivity).mockResolvedValue({ health: healthy, deliveries: [failed] });
    await act(async () => { fireEvent.click(within(notice).getByRole('button', { name: 'Resume deliveries' })); });
    expect(resumePluginDeliveries).toHaveBeenCalledWith('example-pack');
    expect(screen.queryByTestId('plugin-health-notice')).toBeNull();
    expect(screen.queryByTestId('plugin-health')).toBeNull();
    expect(within(region()).getByRole('status')).toHaveTextContent('Deliveries resumed.');
  });

  it('lists a webhook delivery by its webhook, without a repository, event number or Retry (its request is not kept)', async () => {
    const webhook = delivery({ id: 5, deliveryId: 'whk-events-d-1', kind: 'webhook', repository: '', eventSeq: 0, eventType: 'webhook.events', handler: 'onEvent', status: 'failed', attempt: 5, error: 'chat API answered 503', logs: [] });
    await open({ health: healthy, deliveries: [webhook] });
    const [item] = items();
    expect(item).toHaveTextContent('webhook.events');
    expect(item).toHaveTextContent('onEvent');
    expect(item).toHaveTextContent('Attempt 5');
    expect(item).not.toHaveTextContent('Event #');
    expect(within(item).queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('says so when nothing was delivered yet', async () => {
    await open({ health: healthy, deliveries: [] });
    expect(await within(region()).findByText(/No activity yet/)).toBeInTheDocument();
  });
});
