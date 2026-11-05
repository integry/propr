import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalAttention, GoalBlocker } from '@propr/shared';
import { GoalAttentionPanel, GoalNeedsYouBadge } from './GoalAttentionPanel';
import { NeedsAttentionPanel } from '../Dashboard/NeedsAttentionPanel';
import { getDashboardAttention } from '../../api/dashboardApi';

vi.mock('../../api/apiClient', () => ({ API_BASE_URL: 'https://example.test', getDesktopConnectionScope: vi.fn(() => null) }));
vi.mock('../../api/dashboardApi', () => ({ getDashboardAttention: vi.fn() }));

afterEach(() => cleanup());

const question: GoalBlocker = {
  id: 'blocker-1',
  goalId: 'goal-1',
  repository: 'acme/web',
  taskId: 'task-1',
  attempt: { generation: 2, claim: 'claim-2', sessionId: 'thread-1', turnId: 'turn-1' },
  category: 'question',
  provider: 'codex',
  summary: 'Which database should the migration target? <img src=x onerror=alert(1)>',
  questions: [{ id: 'db', header: 'Database', question: 'Which database should the migration target?', options: ['Postgres', 'SQLite'], confidential: false }],
  detection: { kind: 'provider_event', source: 'codex_app_server:item/tool/requestUserInput' },
  firstObservedAt: '2026-10-03T10:05:00.000Z',
  lastObservedAt: '2026-10-03T10:05:00.000Z',
  status: 'open',
  actionable: true,
  responseActions: ['send_input', 'pause', 'cancel'],
  responseHint: 'Send goal input to answer; ProPR delivers it as the reply to this question.',
};

const approval: GoalBlocker = {
  ...question,
  id: 'blocker-2',
  category: 'approval',
  summary: 'Approve command: npm publish',
  questions: [],
  responseActions: ['pause', 'cancel'],
  responseHint: 'ProPR never approves provider requests.',
};

const attention = (blockers: GoalBlocker[]): GoalAttention => ({
  waitingForOperator: blockers.length > 0,
  reason: blockers.length ? 'provider_question' : null,
  blockers,
});

const handlers = () => ({ answer: vi.fn(), resume: vi.fn(), pause: vi.fn(), cancel: vi.fn() });

describe('goal console attention', () => {
  it('shows the provider prompt as plain text with its suggested answers and supported actions', () => {
    const actions = handlers();
    render(<GoalAttentionPanel attention={attention([question, approval])} canAct busy={false} handlers={actions} />);
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
    const summary = screen.getAllByTestId('goal-blocker-summary')[0];
    expect(summary.textContent).toBe(question.summary);
    expect(summary.querySelector('img')).toBeNull();
    expect(screen.getByText('Postgres')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(actions.answer).toHaveBeenCalledTimes(1);
    // An approval is never approvable from ProPR: only the pause/cancel handoff is offered.
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Pause' })[1]);
    expect(actions.pause).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel goal' })[0]);
    expect(actions.cancel).toHaveBeenCalledTimes(1);
  });

  it('offers resume for a confirmed pause and no actions when the operator cannot act', () => {
    const paused: GoalBlocker = { ...question, id: 'goal-pause:goal-1', category: 'paused', summary: 'Goal is paused.',
      questions: [], detection: { kind: 'goal_control', source: 'pause_confirmed' }, responseActions: ['resume', 'send_input', 'cancel'] };
    const actions = handlers();
    const { rerender } = render(<GoalAttentionPanel attention={attention([paused])} canAct busy={false} handlers={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(actions.resume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Send input' })).toBeInTheDocument();
    rerender(<GoalAttentionPanel attention={attention([paused])} canAct={false} busy={false} handlers={actions} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing for a goal that is not waiting', () => {
    const { container } = render(<GoalAttentionPanel attention={attention([])} canAct busy={false} handlers={handlers()} />);
    expect(container).toBeEmptyDOMElement();
    render(<GoalNeedsYouBadge attention={attention([])} />);
    expect(screen.queryByTestId('goal-needs-you')).toBeNull();
  });

  it('marks list rows waiting on a provider question', () => {
    render(<GoalNeedsYouBadge attention={attention([question])} />);
    expect(screen.getByTestId('goal-needs-you')).toHaveTextContent('Question');
  });
});

describe('dashboard attention for goal blockers', () => {
  it('names the blocker and links to the goal console', async () => {
    vi.mocked(getDashboardAttention).mockResolvedValue({
      repository: 'all',
      items: [{
        id: 'goal-blocker:blocker-1', category: 'blocked', kind: 'goal_blocker', taskId: 'task-1', repository: 'acme/web',
        issueNumber: null, prNumber: null, taskType: 'goal', title: 'Migrate the database', state: 'question',
        detail: question.summary, since: new Date().toISOString(), goalId: 'goal-1',
        goalBlocker: { id: 'blocker-1', category: 'question', actionable: true, responseActions: ['send_input', 'pause', 'cancel'] },
      }],
      counts: { blocked: 1, decisions: 0, total: 1 },
    });
    render(<MemoryRouter><NeedsAttentionPanel repository="all" refreshToken={0} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Goal asked a question')).toBeInTheDocument());
    expect(screen.getByText('Migrate the database')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open goal' })).toHaveAttribute('href', '/goals/goal-1');
  });
});
