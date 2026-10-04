import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { USAGE_TIPS_CATALOG } from '@propr/shared';
import { UsageTipsSection } from './UsageTipsSection';
import { dismissUsageTip, getUsageTips, USAGE_TIPS_SETTINGS_CHANGED } from '../../api/usageTipsApi';

vi.mock('../../api/usageTipsApi', () => ({
  getUsageTips: vi.fn(), dismissUsageTip: vi.fn(), USAGE_TIPS_SETTINGS_CHANGED: 'tips-settings-changed',
}));
const tips = USAGE_TIPS_CATALOG.slice(0, 3);
beforeEach(() => { vi.resetAllMocks(); vi.mocked(getUsageTips).mockResolvedValue({ enabled: true, tips: [...tips] }); });

describe('usage tips', () => {
  it('labels only discovery tips while mounting still only reads once', async () => {
    const discovery = USAGE_TIPS_CATALOG.find(t => t.kind === 'discovery')!;
    vi.mocked(getUsageTips).mockResolvedValue({ enabled: true, tips: [tips[0], discovery] });
    render(<UsageTipsSection />);
    const label = await screen.findByText('New to you');
    expect(screen.getAllByText('New to you')).toHaveLength(1);
    expect(label.parentElement).toContainElement(screen.getByRole('link', { name: discovery.title }));
    expect(label.parentElement).not.toContainElement(screen.getByRole('link', { name: tips[0].title }));
    expect(getUsageTips).toHaveBeenCalledTimes(1);
    expect(dismissUsageTip).not.toHaveBeenCalled();
  });
  it('shows the complete personalized recommendation supplied by the API', async () => {
    const body = 'Your instance has recent tasks but few manual reviews. Try /review on a PR to get AI feedback before deciding what needs fixing.';
    vi.mocked(getUsageTips).mockResolvedValue({ enabled: true, tips: [{ ...tips[0], body }] });
    render(<UsageTipsSection />);
    expect(await screen.findByText(body)).toBeVisible();
    expect(screen.getByText('For your workflow')).toBeVisible();
    expect(screen.queryByText(tips[0].body)).toBeNull();
    expect(screen.getByRole('link', { name: tips[0].title })).toHaveAttribute('href', tips[0].docUrl);
  });
  it('mount, rerender, and reload only read, never acknowledge', async () => {
    const view = render(<UsageTipsSection />);
    await screen.findByText(tips[0].title);
    view.rerender(<UsageTipsSection />);
    expect(getUsageTips).toHaveBeenCalledTimes(1);
    expect(dismissUsageTip).not.toHaveBeenCalled();
    view.unmount();
    render(<UsageTipsSection />);
    await screen.findByText(tips[0].title);
    expect(getUsageTips).toHaveBeenCalledTimes(2);
    expect(dismissUsageTip).not.toHaveBeenCalled();
  });
  it.each(['loading', 'failed', 'disabled', 'empty'])('renders nothing when %s', async state => {
    if (state === 'loading') vi.mocked(getUsageTips).mockReturnValue(new Promise(() => {}));
    if (state === 'failed') vi.mocked(getUsageTips).mockRejectedValue(new Error('offline'));
    if (state === 'disabled') vi.mocked(getUsageTips).mockResolvedValue({ enabled: false, tips: [...tips] });
    if (state === 'empty') vi.mocked(getUsageTips).mockResolvedValue({ enabled: true, tips: [] });
    const { container } = render(<UsageTipsSection />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement(); expect(dismissUsageTip).not.toHaveBeenCalled();
  });
  it('removes immediately, reuses event ID on bounded retries, and fetches replacements', async () => {
    let finish!: () => void;
    vi.mocked(dismissUsageTip).mockRejectedValueOnce(new Error('lost response')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<UsageTipsSection />);
    await screen.findByText(tips[0].title);
    vi.mocked(getUsageTips).mockResolvedValue({ enabled: true, tips: [tips[1], tips[2], USAGE_TIPS_CATALOG[3]] });
    fireEvent.click(screen.getByRole('button', { name: `Dismiss ${tips[0].title}` }));
    expect(screen.queryByText(tips[0].title)).toBeNull();
    await waitFor(() => expect(dismissUsageTip).toHaveBeenCalledTimes(2));
    expect(vi.mocked(dismissUsageTip).mock.calls[1]).toEqual(vi.mocked(dismissUsageTip).mock.calls[0]);
    expect(vi.mocked(dismissUsageTip).mock.calls[0][1]).toMatch(/^[\da-f-]{36}$/);
    await act(async () => finish());
    await screen.findByText(USAGE_TIPS_CATALOG[3].title);
    expect(getUsageTips).toHaveBeenCalledTimes(2);
  });
  it('restores a failed dismissal with a retry control using the original event', async () => {
    vi.mocked(dismissUsageTip).mockRejectedValue(new Error('offline'));
    render(<UsageTipsSection />);
    await screen.findByText(tips[0].title);
    fireEvent.click(screen.getByRole('button', { name: `Dismiss ${tips[0].title}` }));
    const retry = await screen.findByRole('button', { name: 'Dismissal not saved. Retry' }, { timeout: 2000 });
    expect(dismissUsageTip).toHaveBeenCalledTimes(3);
    const first = vi.mocked(dismissUsageTip).mock.calls[0];
    expect(vi.mocked(dismissUsageTip).mock.calls.every(call => call[1] === first[1])).toBe(true);
    vi.mocked(dismissUsageTip).mockResolvedValue();
    fireEvent.click(retry);
    await waitFor(() => expect(dismissUsageTip).toHaveBeenCalledTimes(4));
    expect(vi.mocked(dismissUsageTip).mock.calls[3]).toEqual(first);
  });
  it('only explicit settings invalidation refreshes a mounted strip', async () => {
    render(<UsageTipsSection />);
    await screen.findByText(tips[0].title);
    vi.mocked(getUsageTips).mockResolvedValue({ enabled: false, tips: [] });
    await act(async () => { window.dispatchEvent(new Event(USAGE_TIPS_SETTINGS_CHANGED)); });
    expect(screen.queryByRole('region', { name: 'Usage tips' })).toBeNull();
    expect(getUsageTips).toHaveBeenCalledTimes(2); expect(dismissUsageTip).not.toHaveBeenCalled();
  });
});
