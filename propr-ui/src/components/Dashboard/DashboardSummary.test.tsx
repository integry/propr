import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardSummary } from './DashboardSummary';
import { SUMMARY_COALESCE_MS } from './useDashboardSummary';
import { useCurrentUser } from '../../contexts/AuthContext';
import { getDashboardNarrative } from '../../api/dashboardApi';

vi.mock('../../api/apiClient', () => ({ API_BASE_URL: 'https://example.test', getDesktopConnectionScope: vi.fn(() => null) }));
vi.mock('../../contexts/AuthContext', () => ({ useCurrentUser: vi.fn(() => ({ id: 'user-a' })) }));
vi.mock('../../api/dashboardApi', () => ({ getDashboardNarrative: vi.fn() }));
const narrative = vi.mocked(getDashboardNarrative);
const response = { repository: 'all', enabled: true, summary: 'Retry handling is running. A review needs your attention.' };
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(SUMMARY_COALESCE_MS); }); };
const visible = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
};
const mount = async () => {
  const result = render(<DashboardSummary repository="all" activityToken={0} />);
  await act(async () => {});
  return result;
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(useCurrentUser).mockReturnValue({ id: 'user-a' } as ReturnType<typeof useCurrentUser>);
  visible('visible');
  narrative.mockReset().mockResolvedValue(response);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('dashboard narrative', () => {
  it('ticks freshness without requests and retains its age after failures or while paused', async () => {
    const view = await mount();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('Updated 0s ago')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByText('Updated 4s ago')).toBeInTheDocument();
    expect(narrative).toHaveBeenCalledTimes(1);
    narrative.mockRejectedValueOnce(new Error('Offline'));
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Updated 4s ago')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause automatic summary updates' }));
    expect(screen.getByText('Paused')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText('Updated 6s ago')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity summary' }));
    await act(async () => {});
    expect(screen.getByText('Updated 0s ago')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    view.unmount();
    // Flush the storage notification queued by persisting the last response.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reserves the bar before the first response and keeps concise prose as text', async () => {
    let resolve!: (value: typeof response) => void;
    narrative.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await mount();
    const strip = screen.getByTestId('dashboard-summary');
    expect(screen.getByText('Gathering the latest activity…')).toBeInTheDocument();
    expect(screen.getByText('Syncing')).toBeInTheDocument();
    await act(async () => resolve(response));
    expect(screen.getByTestId('dashboard-summary')).toBe(strip);
    expect(screen.getByTitle(response.summary)).toHaveTextContent(response.summary);
  });

  it('restores cached prose and age immediately on reopening, then refreshes it', async () => {
    const first = await mount();
    first.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    narrative.mockImplementationOnce(() => new Promise(() => {}));
    visible('hidden');
    render(<DashboardSummary repository="all" activityToken={0} />);
    expect(screen.getByText(response.summary)).toBeInTheDocument();
    expect(screen.getByText('Updated 5s ago')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
    visible('visible');
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
    expect(screen.getByText(response.summary)).toBeInTheDocument();
  });

  it('isolates cached prose by repository and account and restores the matching scope', async () => {
    const view = await mount();
    narrative.mockImplementation(() => new Promise(() => {}));
    view.rerender(<DashboardSummary repository="example/docs" activityToken={0} />);
    expect(screen.queryByText(response.summary)).not.toBeInTheDocument();
    view.rerender(<DashboardSummary repository="all" activityToken={0} />);
    expect(screen.getByText(response.summary)).toBeInTheDocument();
    vi.mocked(useCurrentUser).mockReturnValue({ id: 'user-b' } as ReturnType<typeof useCurrentUser>);
    view.rerender(<DashboardSummary repository="all" activityToken={0} />);
    expect(screen.queryByText(response.summary)).not.toBeInTheDocument();
  });

  it('ignores malformed storage and works when caching is blocked', async () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{broken');
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked'); });
    try {
      await mount();
      expect(screen.getByText(response.summary)).toBeInTheDocument();
    } finally { read.mockRestore(); write.mockRestore(); }
  });

  it('shows idle for an empty activity summary and clears freshness when repository scope changes', async () => {
    narrative.mockResolvedValueOnce({ ...response, summary: 'No work is active, and there are no recent completions.' });
    const view = await mount();
    expect(screen.getByText('Idle')).toBeInTheDocument();
    narrative.mockResolvedValueOnce({ ...response, summary: null });
    view.rerender(<DashboardSummary repository="acme/web" activityToken={0} />);
    await act(async () => {});
    expect(screen.getByText('Awaiting data')).toBeInTheDocument();
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument();
  });

  it('coalesces activity updates and does not regenerate on a timer', async () => {
    const view = await mount();
    expect(screen.getByText(response.summary)).toBeInTheDocument();
    for (const token of [1, 2, 3]) view.rerender(<DashboardSummary repository="all" activityToken={token} />);
    expect(narrative).toHaveBeenCalledTimes(1);
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(narrative).toHaveBeenCalledTimes(2);
  });

  it('defers hidden activity updates to one request when visible, including a timer scheduled before hiding', async () => {
    const view = await mount();
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    visible('hidden');
    view.rerender(<DashboardSummary repository="all" activityToken={2} />);
    await tick();
    expect(narrative).toHaveBeenCalledTimes(1);
    visible('visible');
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
    visible('hidden');
    visible('visible');
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
  });

  it('does not generate on a hidden initial mount', async () => {
    visible('hidden');
    await mount();
    await tick();
    expect(narrative).not.toHaveBeenCalled();
    visible('visible');
    await tick();
    expect(narrative).toHaveBeenCalledTimes(1);
  });

  it('persists pause across mounts, suppresses automatic updates, and permits forced refresh', async () => {
    const view = await mount();
    expect(screen.getByRole('button', { name: 'Pause automatic summary updates' })).toHaveAttribute('title', 'Pause automatic summary updates');
    expect(screen.getByRole('button', { name: 'Refresh activity summary' })).toHaveAttribute('title', 'Refresh activity summary');
    fireEvent.click(screen.getByRole('button', { name: 'Pause automatic summary updates' }));
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(narrative).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity summary' }));
    await act(async () => {});
    expect(narrative).toHaveBeenLastCalledWith('all', true);
    view.unmount();
    const reloaded = await mount();
    expect(screen.getByRole('button', { name: 'Resume automatic summary updates' })).toHaveAttribute('aria-pressed', 'true');
    narrative.mockClear();
    reloaded.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(narrative).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume automatic summary updates' }));
    await tick();
    expect(narrative).toHaveBeenCalledTimes(1);
  });

  it('retains prose on model or network failure, but hides everything when disabled', async () => {
    const view = await mount();
    narrative.mockResolvedValueOnce({ ...response, summary: null });
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(screen.getByText(response.summary)).toBeInTheDocument();
    narrative.mockRejectedValueOnce(new Error('Network unavailable'));
    view.rerender(<DashboardSummary repository="all" activityToken={2} />);
    await tick();
    expect(screen.getByText(response.summary)).toBeInTheDocument();
    narrative.mockResolvedValue({ ...response, enabled: false, summary: null });
    view.rerender(<DashboardSummary repository="all" activityToken={3} />);
    await tick();
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<DashboardSummary repository="all" activityToken={4} />);
    await tick();
    expect(narrative).toHaveBeenCalledTimes(4);
  });

  it('shows quiet unavailability without a model and renders output as text', async () => {
    narrative.mockResolvedValueOnce({ ...response, summary: null });
    const view = await mount();
    expect(screen.getByText('Activity overview is temporarily unavailable.')).toBeInTheDocument();
    narrative.mockResolvedValueOnce({ ...response, summary: '<img src=x onerror=alert(1)>' });
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('changes repository scope immediately and ignores late results from the old scope', async () => {
    let resolveOld!: (value: typeof response) => void;
    narrative.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const view = await mount();
    narrative.mockResolvedValueOnce({ ...response, repository: 'acme/web', summary: 'Web work is running.' });
    view.rerender(<DashboardSummary repository="acme/web" activityToken={0} />);
    await act(async () => {});
    expect(narrative).toHaveBeenLastCalledWith('acme/web', false);
    await act(async () => { resolveOld(response); });
    expect(screen.getByText('Web work is running.')).toBeInTheDocument();
    expect(screen.queryByText(response.summary)).not.toBeInTheDocument();
  });

  it('remembers activity updates during an in-flight request and cleans up on unmount', async () => {
    let resolve!: (value: typeof response) => void;
    narrative.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = await mount();
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(narrative).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(response); });
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
    view.rerender(<DashboardSummary repository="all" activityToken={2} />);
    view.unmount();
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
  });
});
