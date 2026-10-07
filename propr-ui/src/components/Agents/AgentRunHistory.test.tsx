import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AGENT_RUN_PAGE_SIZE, AgentRunHistory } from './AgentRunHistory';
import { forgetReportPreviews } from './agentRunPresentation';
import { getAgentRun, listAgentRuns, type AgentRunRecord } from '../../api/agentDefinitionsApi';

vi.mock('../../api/agentDefinitionsApi', () => ({
  listAgentRuns: vi.fn(),
  getAgentRun: vi.fn(),
}));

const NOW = 1_800_000_000_000;

const run = (id: string, patch: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  id, definitionId: 'agent-1', ownerId: '1', trigger: 'schedule', triggerSource: 'scheduler', idempotencyKey: null,
  state: 'completed', autonomyMode: 'dry_run', reportTaskId: `task-${id}`, actionTaskId: null, reportTruncated: false,
  actionSummary: null, skipReason: null, failureReason: null, approvedBy: null, operatorNote: null, deferredUntil: null,
  deferrals: 0, createdAt: NOW - 3 * 3_600_000, startedAt: NOW - 3 * 3_600_000, reportedAt: NOW - 3 * 3_600_000 + 90_000,
  finishedAt: NOW - 3 * 3_600_000 + 90_000, updatedAt: NOW,
  ...patch,
});

const LocationProbe = () => <output data-testid="location">{useLocation().pathname}</output>;

const renderHistory = () => render(
  <MemoryRouter initialEntries={['/agents/agent-1/runs']}>
    <Routes>
      <Route path="/agents/:definitionId/runs" element={<AgentRunHistory definitionId="agent-1" now={NOW} />} />
      <Route path="/agents/:definitionId/runs/:runId" element={<p>run detail</p>} />
    </Routes>
    <LocationProbe />
  </MemoryRouter>,
);

describe('AgentRunHistory', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    forgetReportPreviews();
  });

  it('shows a skeleton, then rows newest first with trigger, state and duration', async () => {
    vi.mocked(listAgentRuns).mockResolvedValue({
      runs: [
        run('r2', { trigger: 'manual', triggerSource: 'user:octocat', state: 'awaiting_approval', startedAt: NOW - 5 * 60_000, createdAt: NOW - 5 * 60_000, finishedAt: null }),
        run('r1'),
      ],
      total: 2, limit: AGENT_RUN_PAGE_SIZE, offset: 0, nextOffset: null,
    });
    renderHistory();
    expect(screen.getByText('Loading runs…')).toBeInTheDocument();

    const rows = await screen.findAllByTestId('agent-run-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('5m ago');
    expect(within(rows[0]).getByText('Run now')).toHaveAttribute('title', 'user:octocat');
    expect(rows[0]).toHaveTextContent('Awaiting approval');
    expect(rows[0]).toHaveTextContent('5m');
    expect(rows[1]).toHaveTextContent('3h ago');
    expect(within(rows[1]).getByText('Schedule')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Completed');
    expect(rows[1]).toHaveTextContent('2m');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('loads the next page from nextOffset and appends it', async () => {
    const first = Array.from({ length: AGENT_RUN_PAGE_SIZE }, (_, index) => run(`a${index}`));
    vi.mocked(listAgentRuns)
      .mockResolvedValueOnce({ runs: first, total: AGENT_RUN_PAGE_SIZE + 1, limit: AGENT_RUN_PAGE_SIZE, offset: 0, nextOffset: AGENT_RUN_PAGE_SIZE })
      .mockResolvedValueOnce({ runs: [run('oldest')], total: AGENT_RUN_PAGE_SIZE + 1, limit: AGENT_RUN_PAGE_SIZE, offset: AGENT_RUN_PAGE_SIZE, nextOffset: null });
    renderHistory();

    expect(await screen.findAllByTestId('agent-run-row')).toHaveLength(AGENT_RUN_PAGE_SIZE);
    expect(listAgentRuns).toHaveBeenLastCalledWith('agent-1', { limit: AGENT_RUN_PAGE_SIZE, offset: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getAllByTestId('agent-run-row')).toHaveLength(AGENT_RUN_PAGE_SIZE + 1));
    expect(listAgentRuns).toHaveBeenLastCalledWith('agent-1', { limit: AGENT_RUN_PAGE_SIZE, offset: AGENT_RUN_PAGE_SIZE });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('opens a run when its row is clicked', async () => {
    vi.mocked(listAgentRuns).mockResolvedValue({ runs: [run('r1')], total: 1, limit: AGENT_RUN_PAGE_SIZE, offset: 0, nextOffset: null });
    renderHistory();

    fireEvent.click(await screen.findByTestId('agent-run-row'));
    expect(screen.getByTestId('location')).toHaveTextContent('/agents/agent-1/runs/r1');
    expect(screen.getByText('run detail')).toBeInTheDocument();
  });

  it('reads the report preview once, on first hover', async () => {
    vi.mocked(listAgentRuns).mockResolvedValue({ runs: [run('r1')], total: 1, limit: AGENT_RUN_PAGE_SIZE, offset: 0, nextOffset: null });
    vi.mocked(getAgentRun).mockResolvedValue({ ...run('r1'), report: '\n\n## Three outdated packages\n\nDetails…' });
    renderHistory();

    const row = await screen.findByTestId('agent-run-row');
    fireEvent.mouseEnter(row);
    expect(await within(row).findByText('Three outdated packages')).toBeInTheDocument();
    fireEvent.mouseEnter(row);
    expect(getAgentRun).toHaveBeenCalledTimes(1);
  });

  it('explains an empty history', async () => {
    vi.mocked(listAgentRuns).mockResolvedValue({ runs: [], total: 0, limit: AGENT_RUN_PAGE_SIZE, offset: 0, nextOffset: null });
    renderHistory();
    expect(await screen.findByTestId('agent-runs-empty')).toHaveTextContent('No runs yet');
  });
});
