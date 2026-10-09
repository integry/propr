import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TaskUpdatePayload } from '@propr/shared';
import { AgentRunDetail } from './AgentRunDetail';
import { AGENT_RUN_REFRESH_MS } from './useAgentRun';
import { apiFetch } from '../../api/apiClient';
import type { AgentRunRecord } from '../../api/agentDefinitionsApi';
import { SocketContext } from '../../contexts/SocketContext';
import { createInertSocketContextValue } from '../../test/socketContext';

vi.mock('../../api/apiClient', () => ({
  API_BASE_URL: '',
  apiFetch: vi.fn(),
  handleApiResponse: vi.fn(async (response: Response) => { if (!response.ok) throw new Error('Request failed'); }),
}));

const baseRun: AgentRunRecord = {
  id: 'run-1', definitionId: 'agent-1', ownerId: '1', trigger: 'manual', triggerSource: 'user:octocat', idempotencyKey: null,
  state: 'completed', autonomyMode: 'dry_run', reportTaskId: 'task-report', actionTaskId: null,
  report: '# Weekly findings\n\n- **lodash** is outdated\n\n[advisory](https://example.com/advisory)',
  reportTruncated: false, actionSummary: null, skipReason: null, failureReason: null, approvedBy: null, operatorNote: null,
  deferredUntil: null, deferrals: 0, createdAt: 1_700_000_000_000, startedAt: 1_700_000_001_000,
  reportedAt: 1_700_000_060_000, finishedAt: 1_700_000_060_000, updatedAt: 1_700_000_060_000,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call { method: string; path: string; body: unknown }

/**
 * A fake run endpoint: GET answers with the current run, approve/reject/cancel
 * move it on. Every call is recorded with its parsed body.
 */
function serveRun(initial: AgentRunRecord, reads: AgentRunRecord[] = []) {
  let current = initial;
  const calls: Call[] = [];
  vi.mocked(apiFetch).mockImplementation(async (input, init = {}) => {
    const path = String(input);
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') {
      current = reads.shift() ?? current;
      return json({ run: current });
    }
    const action = path.split('/').pop();
    const note = (calls[calls.length - 1].body as { note?: string } | undefined)?.note ?? null;
    if (action === 'approve') current = { ...current, state: 'acting', approvedBy: '1', operatorNote: note, actionTaskId: 'task-act' };
    if (action === 'reject') current = { ...current, state: 'rejected', finishedAt: Date.now() };
    if (action === 'cancel') current = { ...current, state: 'cancelled', finishedAt: Date.now() };
    return json({ run: current });
  });
  return { calls, reads: () => calls.filter(call => call.method === 'GET') };
}

const renderDetail = (socket = createInertSocketContextValue()) => render(
  <SocketContext.Provider value={socket}>
    <MemoryRouter>
      <AgentRunDetail definitionId="agent-1" runId="run-1" agentName="Dependency review" repositories={['integry/propr']} />
    </MemoryRouter>
  </SocketContext.Provider>,
);

describe('AgentRunDetail', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('renders a completed run report as Markdown with copy, the truncation note and its task link', async () => {
    serveRun({ ...baseRun, reportTruncated: true });
    renderDetail();

    const report = await screen.findByTestId('agent-run-report');
    expect(within(report).getByRole('heading', { name: 'Weekly findings' })).toBeInTheDocument();
    expect(within(report).getByText('lodash').tagName).toBe('STRONG');
    expect(within(report).getByRole('link', { name: 'advisory' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(report).toHaveTextContent('Report truncated — full output in the task log');
    expect(screen.getByTestId('agent-run-state')).toHaveTextContent('Completed');
    expect(screen.getByRole('link', { name: 'Open report task' })).toHaveAttribute('href', '/tasks/task-report');
    expect(screen.queryByRole('link', { name: 'Open acting task' })).not.toBeInTheDocument();
    expect(document.title).toBe('Run · Dependency review | ProPR');
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(baseRun.report);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('refuses a run that belongs to another agent and links to its own agent instead', async () => {
    const server = serveRun({ ...baseRun, definitionId: 'agent-2', state: 'awaiting_approval', finishedAt: null });
    renderDetail();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This run belongs to a different automation, so it is not shown under Dependency review.');
    expect(within(alert).getByRole('link', { name: 'Open it under its own automation' })).toHaveAttribute('href', '/automations/agent-2/runs/run-1');
    expect(screen.queryByTestId('agent-run-detail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-run-approval')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve and act/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(server.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('does not render raw HTML from the report', async () => {
    serveRun({ ...baseRun, report: 'Before <img src="x" onerror="alert(1)"> after' });
    renderDetail();
    const report = await screen.findByTestId('agent-run-report');
    expect(report.querySelector('img')).toBeNull();
  });

  it('shows the cost-gate reason of a skipped run verbatim', async () => {
    const reason = 'Claude is at 96% of its session window (pause threshold 90%); scheduled runs wait for capacity.';
    serveRun({ ...baseRun, state: 'skipped', trigger: 'schedule', report: null, reportedAt: null, reportTaskId: null, skipReason: reason });
    renderDetail();

    expect(await screen.findByRole('alert')).toHaveTextContent('Run skipped');
    expect(screen.getByTestId('agent-run-reason').textContent).toBe(reason);
  });

  it('explains why an automatic run stopped for approval before acting', async () => {
    const reason = 'Acting paused: claude is at 93% of its session window (pause threshold 90%).';
    serveRun({ ...baseRun, state: 'awaiting_approval', trigger: 'schedule', autonomyMode: 'auto', finishedAt: null, skipReason: reason });
    renderDetail();

    expect(await screen.findByRole('alert')).toHaveTextContent('Automatic acting paused for approval');
    expect(screen.getByTestId('agent-run-reason').textContent).toBe(reason);
    expect(screen.getByTestId('agent-run-approval')).toBeInTheDocument();
  });

  it('moves focus into the confirmation, keeps Tab inside it and returns focus on dismissal', async () => {
    serveRun({ ...baseRun, state: 'awaiting_approval', autonomyMode: 'preview', finishedAt: null });
    const { container } = renderDetail();

    const trigger = await screen.findByRole('button', { name: 'Approve and act' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    const [cancel, confirm] = within(dialog).getAllByRole('button');
    expect(cancel).toHaveFocus();
    expect(container.inert).toBe(true);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.inert).toBeFalsy();
    expect(trigger).toHaveFocus();
  });

  it('approves an awaiting run with a note, then hides the decision', async () => {
    const server = serveRun({ ...baseRun, state: 'awaiting_approval', autonomyMode: 'preview', finishedAt: null });
    renderDetail();

    const panel = await screen.findByTestId('agent-run-approval');
    expect(panel).toHaveTextContent('cannot merge pull requests or change settings');
    fireEvent.change(within(panel).getByLabelText('Note for the acting agent (optional)'), { target: { value: '  Only fix lodash.  ' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Approve and act' }));

    const dialog = screen.getByRole('dialog');
    expect(server.calls.some(call => call.method === 'POST')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and act' }));

    await waitFor(() => expect(screen.getByTestId('agent-run-state')).toHaveTextContent('Acting'));
    const approve = server.calls.find(call => call.method === 'POST');
    expect(approve).toEqual({ method: 'POST', path: '/api/agent-runs/run-1/approve', body: { note: 'Only fix lodash.' } });
    expect(screen.queryByTestId('agent-run-approval')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and act' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open acting task' })).toHaveAttribute('href', '/tasks/task-act');
    expect(screen.getByTestId('agent-run-action-summary')).toHaveTextContent('The acting agent is working');
  });

  it('rejects an awaiting run after confirmation, and a dismissed confirmation sends nothing', async () => {
    const server = serveRun({ ...baseRun, state: 'awaiting_approval', autonomyMode: 'preview', finishedAt: null });
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(server.calls.some(call => call.method === 'POST')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(screen.getByTestId('agent-run-state')).toHaveTextContent('Rejected'));
    expect(server.calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/api/agent-runs/run-1/reject']);
    expect(screen.queryByTestId('agent-run-approval')).not.toBeInTheDocument();
  });

  it('renders what the acting agent did', async () => {
    serveRun({ ...baseRun, autonomyMode: 'auto', actionTaskId: 'task-act', actionSummary: 'Opened **issue #12** for lodash.' });
    renderDetail();
    const summary = await screen.findByTestId('agent-run-action-summary');
    expect(within(summary).getByText('issue #12').tagName).toBe('STRONG');
  });

  it('cancels a running run after confirmation', async () => {
    const server = serveRun({ ...baseRun, state: 'running', report: null, reportedAt: null, finishedAt: null });
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel run' }));

    await waitFor(() => expect(screen.getByTestId('agent-run-state')).toHaveTextContent('Cancelled'));
    expect(server.calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/api/agent-runs/run-1/cancel']);
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  });

  it('refreshes every 10 seconds while the run is in progress and stops once it is terminal', async () => {
    vi.useFakeTimers();
    const running = { ...baseRun, state: 'running' as const, report: null, reportedAt: null, finishedAt: null };
    const server = serveRun(running, [running, running, { ...baseRun }]);
    renderDetail();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(server.reads()).toHaveLength(1);
    expect(screen.getByTestId('agent-run-state')).toHaveTextContent('Running');

    await act(async () => { await vi.advanceTimersByTimeAsync(AGENT_RUN_REFRESH_MS - 1); });
    expect(server.reads()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(server.reads()).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(AGENT_RUN_REFRESH_MS); });
    expect(server.reads()).toHaveLength(3);
    expect(screen.getByTestId('agent-run-state')).toHaveTextContent('Completed');

    await act(async () => { await vi.advanceTimersByTimeAsync(AGENT_RUN_REFRESH_MS * 5); });
    expect(server.reads()).toHaveLength(3);
  });

  it('reads the run again as soon as one of its tasks reports an update', async () => {
    let deliver: ((payload: TaskUpdatePayload) => void) | null = null;
    const socket = createInertSocketContextValue({
      onTaskUpdate: callback => { deliver = callback; return () => { deliver = null; }; },
    });
    const running = { ...baseRun, state: 'running' as const, report: null, reportedAt: null, finishedAt: null };
    const server = serveRun(running, [running, { ...baseRun }]);
    renderDetail(socket);
    await waitFor(() => expect(deliver).not.toBeNull());

    act(() => deliver!({ eventType: 'task:update', taskId: 'unrelated', state: 'completed', timestamp: '' } as TaskUpdatePayload));
    expect(server.reads()).toHaveLength(1);

    act(() => deliver!({ eventType: 'task:update', taskId: 'task-report', state: 'completed', timestamp: '' } as TaskUpdatePayload));
    await waitFor(() => expect(screen.getByTestId('agent-run-state')).toHaveTextContent('Completed'));
    expect(server.reads()).toHaveLength(2);
    // Terminal: the subscription is released.
    expect(deliver).toBeNull();
  });
});
