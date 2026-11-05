import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DashboardSummary } from './DashboardSummary';

vi.mock('../../contexts/AuthContext', () => ({ useCurrentUser: vi.fn(() => ({ id: 'user-a' })) }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const summary = 'Retry handling is running. A review needs your attention.';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Real dashboardApi/apiClient: the 503 body is the one getNarrativeStatus sends
// when `dashboard_summary_enabled` cannot be read or parsed by the production
// strict reader (packages/api/test/dashboardNarrativeStatus.test.ts).
it('treats the backend 503 for an unreadable opt-in as unavailable and recovers on the next activity', async () => {
  let settingReadable = false;
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url.endsWith('/api/dashboard/narrative/status')) {
      return settingReadable
        ? json({ enabled: true })
        : json({ error: 'Dashboard summary status is unavailable' }, 503);
    }
    if (url.includes('/api/dashboard/narrative?')) return json({ repository: 'all', enabled: true, summary });
    throw new Error(`Unexpected request ${url}`);
  });
  const statusCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/narrative/status')).length;
  const narrativeCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes('/narrative?')).length;

  const view = render(<DashboardSummary repository="all" activityToken={0} />);
  await waitFor(() => expect(statusCalls()).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(view.container).toBeEmptyDOMElement();
  expect(narrativeCalls()).toBe(0);

  settingReadable = true;
  view.rerender(<DashboardSummary repository="all" activityToken={1} />);
  await waitFor(() => expect(screen.getByTestId('dashboard-summary')).toHaveTextContent(summary));
  expect(statusCalls()).toBe(2);
  expect(narrativeCalls()).toBe(1);
});
