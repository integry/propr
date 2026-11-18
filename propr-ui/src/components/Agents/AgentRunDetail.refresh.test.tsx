import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentRunDetail } from './AgentRunDetail';
import { AGENT_RUN_REFRESH_MS } from './useAgentRun';
import { apiFetch } from '../../api/apiClient';
import type { AutomationRunRecord } from '../../api/automationDefinitionsApi';
import { SocketContext } from '../../contexts/SocketContext';
import { createInertSocketContextValue } from '../../test/socketContext';

vi.mock('../../api/apiClient', () => ({
  API_BASE_URL: '',
  apiFetch: vi.fn(),
  handleApiResponse: vi.fn(async (response: Response) => { if (!response.ok) throw new Error('Request failed'); }),
}));

const REPORT = '# Weekly findings\n\nThe **lodash** dependency is outdated.\n\n- first finding\n- second finding';

const baseRun: AutomationRunRecord = {
  id: 'run-1', definitionId: 'agent-1', ownerId: '1', trigger: 'manual', triggerSource: 'user:octocat', idempotencyKey: null,
  state: 'completed', autonomyMode: 'preview', reportTaskId: 'task-report', actionTaskId: null,
  report: REPORT, reportTruncated: false, actionSummary: null, skipReason: null, failureReason: null, approvedBy: null,
  operatorNote: null, deferredUntil: null, deferrals: 0, createdAt: 1_700_000_000_000, startedAt: 1_700_000_001_000,
  reportedAt: 1_700_000_060_000, finishedAt: 1_700_000_060_000, updatedAt: 1_700_000_060_000,
};

const awaitingApproval: AutomationRunRecord = { ...baseRun, state: 'awaiting_approval', finishedAt: null };

/** Every GET answers with a fresh copy of the next run (the last one repeats), as the server would. */
function serveReads(reads: AutomationRunRecord[]) {
  let gets = 0;
  vi.mocked(apiFetch).mockImplementation(async () => {
    const run = reads[Math.min(gets, reads.length - 1)];
    gets += 1;
    return new Response(JSON.stringify({ run: structuredClone(run) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { gets: () => gets };
}

const detail = (agentName = 'Dependency review') => (
  <SocketContext.Provider value={createInertSocketContextValue()}>
    <MemoryRouter>
      <AgentRunDetail definitionId="agent-1" runId="run-1" agentName={agentName} repositories={['integry/propr']} />
    </MemoryRouter>
  </SocketContext.Provider>
);

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** The report's paragraph and its first list item: the nodes a reader's selection lives in. */
const reportNodes = () => {
  const report = screen.getByTestId('agent-run-report');
  return {
    report,
    paragraph: within(report).getByText(/dependency is outdated/).closest('p'),
    item: within(report).getByText('first finding'),
  };
};

describe('AgentRunDetail background refresh', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('reads a finished run once and keeps its report nodes when the page re-renders around it', async () => {
    vi.useFakeTimers();
    const server = serveReads([baseRun]);
    const { rerender } = render(detail());
    await tick(0);
    const before = reportNodes();
    expect(before.paragraph).not.toBeNull();

    // The automations page re-renders the detail whenever its own run-state reads land.
    for (let round = 0; round < 3; round += 1) {
      rerender(detail());
      await tick(AGENT_RUN_REFRESH_MS);
    }

    expect(server.gets()).toBe(1);
    const after = reportNodes();
    expect(after.report).toBe(before.report);
    expect(after.paragraph).toBe(before.paragraph);
    expect(after.item).toBe(before.item);
  });

  it('keeps the report nodes of a run waiting for approval across refreshes that return the same run', async () => {
    vi.useFakeTimers();
    const server = serveReads([awaitingApproval]);
    render(detail());
    await tick(0);
    const before = reportNodes();

    await tick(AGENT_RUN_REFRESH_MS * 3);

    expect(server.gets()).toBe(4);
    const after = reportNodes();
    expect(after.paragraph).toBe(before.paragraph);
    expect(after.item).toBe(before.item);
    expect(screen.queryByText('Loading run…')).not.toBeInTheDocument();
  });

  it('shows a report that really changed, and keeps the unchanged part of it in place', async () => {
    vi.useFakeTimers();
    const extended = { ...awaitingApproval, report: `${REPORT}\n- third finding`, updatedAt: awaitingApproval.updatedAt + 1 };
    serveReads([awaitingApproval, extended]);
    render(detail());
    await tick(0);
    const before = reportNodes();
    expect(screen.queryByText('third finding')).not.toBeInTheDocument();

    await tick(AGENT_RUN_REFRESH_MS);

    expect(within(screen.getByTestId('agent-run-report')).getByText('third finding')).toBeInTheDocument();
    expect(reportNodes().paragraph).toBe(before.paragraph);
  });
});
