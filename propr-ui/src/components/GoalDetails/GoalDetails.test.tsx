import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GoalDetail, GoalEvent, GoalMessage } from '../../api/goalsApi';
import GoalControls from './GoalControls';
import GoalHierarchy from './GoalHierarchy';
import GoalStats from './GoalStats';
import GoalTerminal from './GoalTerminal';
import { hierarchyChildren, mergeGoalEvents, sanitizeTerminalText, scopedGoalKey } from './goalDetailUtils';

const timestamp = '2026-08-31T10:00:00.000Z';
const event = (sequence: number, type: GoalEvent['type'] = 'stdout', content = `line ${sequence}`): GoalEvent => ({
  goalId: 'goal-1', sequence, type, content, source: 'codex', timestamp, turnId: sequence < 3 ? 'turn-1' : 'turn-2', payload: null,
});

const message = (sequence: number, state: GoalMessage['state']): GoalMessage => ({
  messageId: `message-${sequence}`, sequence, body: `message ${sequence}`, predefinedKind: null, state,
  responseSource: state === 'acknowledged' ? 'provider' : null,
  response: state === 'acknowledged' ? 'Provider response' : null,
  error: state === 'failed' ? 'Delivery failed' : null, createdAt: timestamp, updatedAt: timestamp,
});

const detail: GoalDetail = {
  goal: {
    goalId: 'goal-1', objective: 'Ship the operator page', repository: 'integry/propr', state: 'running', agent: 'codex',
    requestedModel: 'gpt-new', effectiveModel: 'gpt-old', maxActiveTasks: 2, mergePolicy: 'manual', ultrafixEnabled: true,
    ultrafixGoal: 8, ultrafixMaxCycles: 10, version: 4, terminalReason: null, createdAt: timestamp, updatedAt: timestamp,
  },
  hierarchy: { nodes: [], dependencies: [] }, providerTodos: [], messages: [],
  stats: {
    issues: { total: 5, ready: 2, active: 1, processed: 3, failed: 1, blocked: 1 },
    pullRequests: { open: 2, reviewPending: 1, ultrafixPending: 1, mergeReady: 1, merged: 1 },
    tokens: { total: 175, byModel: [{ provider: 'openai', model: 'gpt-old', input: 100, output: 40, cacheRead: 20, cacheWrite: 5, reasoning: 10, total: 175 }] },
    time: { elapsedSeconds: 100, activeSeconds: 70, pausedSeconds: 20, recoverySeconds: 10 },
  },
  recovery: { state: 'healthy', attempt: 0, reason: null }, epicPrUrl: null, completionBlockers: [], latestSequence: 5,
};

describe('goal detail utilities', () => {
  it('deduplicates replayed sequences, sorts gaps, and rejects cross-goal cache pollution', () => {
    expect(mergeGoalEvents([event(2)], [event(1), event(2, 'stderr'), { ...event(3), goalId: 'other' }], 'goal-1'))
      .toEqual([event(1), event(2, 'stderr')]);
    expect(scopedGoalKey('owner-a', 'integry/propr', 'goal-1')).not.toBe(scopedGoalKey('owner-b', 'integry/propr', 'goal-1'));
  });

  it('builds nested hierarchy buckets without flattening sub-epics', () => {
    const base = { kind: 'root_epic', title: 'Root', state: 'active', orderIndex: 0, externalRef: null, externalUrl: null, blockedReason: null, ci: 'running', review: 'pending', ultrafix: 'pending', merge: 'pending' } as const;
    const nodes: GoalDetail['hierarchy']['nodes'] = [
      { ...base, nodeId: 'root', parentNodeId: null },
      { ...base, kind: 'sub_epic', nodeId: 'child', parentNodeId: 'root' },
    ];
    expect(hierarchyChildren(nodes).get('root')?.[0]?.nodeId).toBe('child');
  });
});

describe('GoalTerminal', () => {
  it('renders ANSI and HTML as inert text, filters streams, and bounds large mounted histories', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const events = Array.from({ length: 300 }, (_, index) => event(index + 1));
    events[299] = event(300, 'stderr', '\u001b[31m<script>alert(1)</script>\u001b[0m');
    render(<GoalTerminal events={events} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={vi.fn()} />);
    expect(screen.getByText('Events 51–300 of 300')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(sanitizeTerminalText('\u001b[31mred\u001b[0m')).toBe('red');
    fireEvent.click(screen.getByRole('button', { name: 'stdout' }));
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible terminal output' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(expect.not.stringContaining('\u001b')));
  });

  it('navigates through every loaded middle window and reapplies windowing after search', () => {
    const events = Array.from({ length: 800 }, (_, index) => event(index + 1));
    render(<GoalTerminal events={events} connectionState="connected" hasMoreBefore={false} loadingOlder={false} onLoadOlder={vi.fn()} />);
    expect(screen.getByText('Events 551–800 of 800')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier event window' }));
    expect(screen.getByText('Events 301–550 of 800')).toBeInTheDocument();
    expect(screen.getByText('line 420')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier event window' }));
    expect(screen.getByText('Events 51–300 of 800')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search terminal output' }), { target: { value: 'line 420' } });
    expect(screen.getByText('line 420')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Terminal event windows' })).not.toBeInTheDocument();
  });

  it('stops following when the operator scrolls away and exposes explicit follow-tail recovery', () => {
    const { rerender } = render(<GoalTerminal events={[event(1)]} connectionState="recovering" hasMoreBefore={false} loadingOlder={false} onLoadOlder={vi.fn()} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    rerender(<GoalTerminal events={[event(1), event(2)]} connectionState="recovering" hasMoreBefore={false} loadingOlder={false} onLoadOlder={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Follow latest' })).toBeInTheDocument();
    expect(viewport.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole('button', { name: 'Follow latest' }));
    expect(viewport.scrollTop).toBe(1000);
  });

  it('preserves the visible position when an older page is prepended', async () => {
    let height = 500;
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() {
      return (this as HTMLElement).dataset.eventSequence === '1' ? (height === 500 ? 100 : 300) : 0;
    } });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 20 });
    let view: ReturnType<typeof render>;
    const onLoadOlder = vi.fn(async () => {
      height = 700;
      view.rerender(<GoalTerminal events={[event(0), event(1)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    });
    view = render(<GoalTerminal events={[event(1)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => height });
    viewport.scrollTop = 30;
    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    await waitFor(() => expect(viewport.scrollTop).toBe(230));
    delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  });

  it('restores tail-follow after repeated empty older loads and follows the next live event', async () => {
    let height = 500;
    const onLoadOlder = vi.fn().mockResolvedValue(undefined);
    const view = render(<GoalTerminal events={[event(1)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => height });
    viewport.scrollTop = height;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
      await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(attempt));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument());
    }

    height = 700;
    view.rerender(<GoalTerminal events={[event(1), event(2)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    await waitFor(() => expect(viewport.scrollTop).toBe(700));
    expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument();
  });

  it('preserves a pre-existing non-tail state after an empty older load', async () => {
    const onLoadOlder = vi.fn().mockResolvedValue(undefined);
    const view = render(<GoalTerminal events={[event(1), event(2)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);

    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Follow latest' })).toBeInTheDocument());
    view.rerender(<GoalTerminal events={[event(1), event(2), event(3)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    expect(viewport.scrollTop).toBe(100);
  });

  it('restores tail-follow after a rejected older load across rerenders and follows the next live event', async () => {
    let rejectLoad: (reason: Error) => void = () => undefined;
    let height = 500;
    const onLoadOlder = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLoad = reject; }));
    const view = render(<GoalTerminal events={[event(1)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => height });
    viewport.scrollTop = height;

    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    expect(screen.getByRole('button', { name: 'Follow latest' })).toBeInTheDocument();
    view.rerender(<GoalTerminal events={[event(1)]} connectionState="recovering" hasMoreBefore loadingOlder onLoadOlder={onLoadOlder} />);
    await act(async () => { rejectLoad(new Error('older history unavailable')); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument());

    height = 700;
    view.rerender(<GoalTerminal events={[event(1), event(2)]} connectionState="recovering" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    await waitFor(() => expect(viewport.scrollTop).toBe(700));
    expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument();
  });
});

describe('goal hierarchy and statistics', () => {
  it('renders nested blocked dependencies and keeps provider todos visibly advisory', () => {
    const root = { nodeId: 'root', parentNodeId: null, kind: 'root_epic', title: 'Root epic', state: 'active', orderIndex: 0, externalRef: '#1', externalUrl: 'https://github.com/integry/propr/issues/1', blockedReason: null, ci: 'running', review: 'pending', ultrafix: 'pending', merge: 'pending' } as const;
    const sub = { ...root, nodeId: 'sub', parentNodeId: 'root', kind: 'sub_epic', title: 'Sub epic', state: 'blocked', blockedReason: 'Waiting for API' } as const;
    render(<GoalHierarchy nodes={[root, sub]} dependencies={[{ nodeId: 'sub', dependsOnNodeId: 'root' }]} providerTodos={[{ todoId: 'todo-1', provider: 'Codex', content: 'Inspect files', status: 'in_progress', updatedAt: timestamp }]} />);
    expect(screen.getAllByRole('treeitem')[0]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Blocked by Root epic: Waiting for API/)).toBeInTheDocument();
    expect(screen.getByText('Provider advisory todos')).toBeInTheDocument();
    expect(screen.getByText(/Advisory only/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Goal work hierarchy')).queryByText('Inspect files')).not.toBeInTheDocument();
  });

  it('shows authoritative token dimensions and active, paused, and recovery timing', () => {
    render(<GoalStats stats={detail.stats} />);
    expect(screen.getByText('5 total · 2 ready · 1 active · 3 processed · 1 failed · 1 blocked')).toBeInTheDocument();
    expect(screen.getByText('1m elapsed · 1m active · 20s paused · 10s recovery')).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('openai / gpt-old');
    expect(screen.getByRole('table')).toHaveTextContent('175');
  });
});

describe('GoalControls', () => {
  const props = () => ({
    detail, models: ['gpt-old', 'gpt-new', 'gpt-next'], readOnly: false, pendingAction: null,
    onPause: vi.fn().mockResolvedValue(true), onResume: vi.fn().mockResolvedValue(true), onCancel: vi.fn().mockResolvedValue(true),
    onChangeModel: vi.fn().mockResolvedValue(true), onSend: vi.fn().mockResolvedValue(true), onRetryMessage: vi.fn().mockResolvedValue(true), onCancelMessage: vi.fn().mockResolvedValue(undefined),
  });

  it('covers pause acknowledgement, resume, cancellation confirmation, and pending model visibility', async () => {
    const handlers = props();
    const { rerender } = render(<GoalControls {...handlers} />);
    expect(screen.getByText(/gpt-new requested, awaiting runtime acknowledgement/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Requested model'), { target: { value: 'gpt-next' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request change' }));
    expect(handlers.onChangeModel).toHaveBeenCalledWith('gpt-next');
    rerender(<GoalControls {...handlers} detail={{ ...detail, goal: { ...detail.goal, requestedModel: 'gpt-next', effectiveModel: 'gpt-next' } }} />);
    expect(screen.queryByText(/awaiting runtime acknowledgement/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(handlers.onPause).toHaveBeenCalledOnce();
    rerender(<GoalControls {...handlers} detail={{ ...detail, goal: { ...detail.goal, state: 'pausing' } }} />);
    expect(screen.getByRole('button', { name: 'Pausing…' })).toBeDisabled();
    rerender(<GoalControls {...handlers} detail={{ ...detail, goal: { ...detail.goal, state: 'paused' } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(handlers.onResume).toHaveBeenCalledOnce();
    rerender(<GoalControls {...handlers} detail={{ ...detail, goal: { ...detail.goal, state: 'running' } }} />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel goal…' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep running' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel goal' }));
    await waitFor(() => expect(handlers.onCancel).toHaveBeenCalledWith('Cancelled by operator'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel goal…' })).toHaveFocus());
  });

  it('traps modal focus, closes with Escape only while idle, and restores the trigger', () => {
    const handlers = props();
    const { rerender } = render(<GoalControls {...handlers} />);
    const trigger = screen.getByRole('button', { name: 'Cancel goal…' });
    trigger.focus(); fireEvent.click(trigger);
    const confirm = screen.getByRole('button', { name: 'Cancel goal' });
    const reason = screen.getByLabelText('Cancellation reason');
    reason.focus(); fireEvent.keyDown(reason, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(reason).toHaveFocus();
    rerender(<GoalControls {...handlers} pendingAction="cancel" />);
    expect(screen.getByLabelText('Cancellation reason')).toHaveFocus();
    fireEvent.keyDown(screen.getByLabelText('Cancellation reason'), { key: 'Tab' });
    expect(screen.getByLabelText('Cancellation reason')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    rerender(<GoalControls {...handlers} />);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('restores focus to the controls region when successful cancellation removes its trigger', async () => {
    const onCancel = vi.fn(async (reason: string) => reason.length > 0);
    function TerminalCancellation() {
      const [state, setState] = useState<GoalDetail['goal']['state']>('running');
      return <GoalControls {...props()} detail={{ ...detail, goal: { ...detail.goal, state } }} onCancel={async reason => {
        setState('cancelled');
        return onCancel(reason);
      }} />;
    }
    render(<TerminalCancellation />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel goal…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel goal' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onCancel).toHaveBeenCalledWith('Cancelled by operator');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Controls' })).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Cancel goal…' })).not.toBeInTheDocument();
  });

  it('renders every message state and supports failed retry and pending cancellation', () => {
    const handlers = props();
    const messages = (['pending', 'delivered', 'acknowledged', 'failed', 'cancelled'] as const).map((state, index) => message(index + 1, state));
    render(<GoalControls {...handlers} detail={{ ...detail, messages }} />);
    for (const state of ['pending', 'delivered', 'acknowledged', 'failed', 'cancelled']) expect(screen.getByText(state)).toBeInTheDocument();
    expect(screen.getByText(/Provider response/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(handlers.onRetryMessage).toHaveBeenCalledWith(messages[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel pending message' }));
    expect(handlers.onCancelMessage).toHaveBeenCalledWith('message-1');
  });

  it('annotates and disables all mutations in read-only mode', () => {
    render(<GoalControls {...props()} readOnly />);
    expect(screen.getByText(/Controls are unavailable in demo\/read-only mode/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'What’s done?' })).toBeDisabled();
  });
});
