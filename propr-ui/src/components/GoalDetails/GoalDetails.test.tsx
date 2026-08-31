import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GoalDetail } from '../../api/goalsApi';
import GoalControls from './GoalControls';
import GoalHierarchy from './GoalHierarchy';
import GoalStats from './GoalStats';
import { GOAL_EVENT_RETENTION_LIMIT, hierarchyChildren, mergeGoalEvents, scopedGoalKey } from './goalDetailUtils';
import { goalDetail as detail, goalEvent as event, goalMessage as message, timestamp } from './goalDetailsTestFixtures';

describe('goal detail utilities', () => {
  it('deduplicates replayed sequences, sorts gaps, and rejects cross-goal cache pollution', () => {
    expect(mergeGoalEvents([event(2)], [event(1), event(2, 'stderr'), { ...event(3), goalId: 'other' }], 'goal-1'))
      .toEqual([event(1), event(2, 'stderr')]);
    expect(scopedGoalKey('owner-a', 'integry/propr', 'goal-1')).not.toBe(scopedGoalKey('owner-b', 'integry/propr', 'goal-1'));
  });

  it('bounds retained tail and older-history windows while keeping dedupe and the authoritative tail', () => {
    const overBound = Array.from({ length: GOAL_EVENT_RETENTION_LIMIT + 500 }, (_, index) => event(index + 1));
    const tail = mergeGoalEvents([], overBound, 'goal-1');
    expect(tail).toHaveLength(GOAL_EVENT_RETENTION_LIMIT);
    expect(tail[0].sequence).toBe(501);
    expect(tail.at(-1)?.sequence).toBe(1_500);

    const withDuplicate = mergeGoalEvents(tail, [event(1_500, 'stderr'), event(1_501)], 'goal-1');
    expect(withDuplicate).toHaveLength(GOAL_EVENT_RETENTION_LIMIT);
    expect(withDuplicate.find(item => item.sequence === 1_500)?.type).toBe('stderr');
    expect(withDuplicate.at(-1)?.sequence).toBe(1_501);

    const older = mergeGoalEvents(withDuplicate, Array.from({ length: 700 }, (_, index) => event(index - 699)), 'goal-1', { ingestion: 'older' });
    expect(older).toHaveLength(GOAL_EVENT_RETENTION_LIMIT);
    expect(older[0].sequence).toBe(-699);
    expect(older.at(-1)?.sequence).toBe(1_501);
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

  it('preserves full message drafts through prepend, middle, append, and composition edits', () => {
    render(<GoalControls {...props()} />);
    const draft = screen.getByRole('textbox', { name: 'Message to the goal controller' });
    expect(draft).not.toHaveAttribute('maxlength');
    const full = `${'a'.repeat(3998)}YZ`;
    const insertions = [
      `P${full}`,
      `${full.slice(0, 2000)}M${full.slice(2000)}`,
      `${full}A`,
    ];

    for (const rawDraft of insertions) {
      fireEvent.change(draft, { target: { value: rawDraft } });
      expect(draft).toHaveValue(rawDraft);
      expect((draft as HTMLTextAreaElement).value.endsWith('YZ') || rawDraft.endsWith('A')).toBe(true);
      expect(screen.getByText('4001/4000')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    }

    const composingDraft = `${full.slice(0, 2000)}あ${full.slice(2000)}`;
    fireEvent.compositionStart(draft);
    fireEvent.change(draft, { target: { value: composingDraft } });
    fireEvent.compositionEnd(draft, { data: 'あ' });
    expect(draft).toHaveValue(composingDraft);
    expect((draft as HTMLTextAreaElement).value.endsWith('YZ')).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent('Remove at least 1 character');
  });

  it('preserves an over-limit message paste and recovers after editing under the limit', async () => {
    const handlers = props();
    render(<GoalControls {...handlers} />);
    const draft = screen.getByRole('textbox', { name: 'Message to the goal controller' });
    const pastedDraft = 'x'.repeat(4001);

    fireEvent.paste(draft, { clipboardData: { getData: () => pastedDraft } });
    fireEvent.change(draft, { target: { value: pastedDraft } });
    expect(draft).toHaveValue(pastedDraft);
    expect(screen.getByRole('alert')).toHaveTextContent('at most 4000 characters after trimming');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(handlers.onSend).not.toHaveBeenCalled();

    fireEvent.change(draft, { target: { value: pastedDraft.slice(0, -1) } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('4000/4000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(handlers.onSend).toHaveBeenCalledWith({ body: 'x'.repeat(4000) }));
  });

  it('aligns the message counter, validation, and payload for trimmed Unicode code points', async () => {
    const handlers = props();
    handlers.onSend.mockResolvedValue(false);
    render(<GoalControls {...handlers} />);
    const draft = screen.getByRole('textbox', { name: 'Message to the goal controller' });

    const astralDraft = `  ${'🚀'.repeat(4000)}  `;
    fireEvent.change(draft, { target: { value: astralDraft } });
    expect(draft).toHaveValue(astralDraft);
    expect(screen.getByText('4000/4000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();

    const canonicalMessage = `${'🚀'.repeat(3998)}e\u0301`;
    const rawDraft = ` \n${canonicalMessage}\t `;
    expect(Array.from(canonicalMessage)).toHaveLength(4000);
    fireEvent.change(draft, { target: { value: rawDraft } });
    expect(draft).toHaveValue(rawDraft);
    expect(screen.getByText('4000/4000')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(handlers.onSend).toHaveBeenCalledWith({ body: canonicalMessage }));
    expect(draft).toHaveValue(rawDraft);
  });

  it('disables every mutation for each pending action without unmounting the draft', () => {
    const handlers = props();
    const messages = [message(1, 'pending'), message(2, 'failed')];
    const view = render(<GoalControls {...handlers} detail={{ ...detail, messages }} />);
    const draft = screen.getByRole('textbox', { name: 'Message to the goal controller' });
    fireEvent.change(draft, { target: { value: 'Preserve this mounted draft' } });
    fireEvent.change(screen.getByLabelText('Requested model'), { target: { value: 'gpt-next' } });

    for (const pendingAction of ['pause', 'resume', 'cancel', 'model', 'message', 'cancel-message']) {
      view.rerender(<GoalControls {...handlers} detail={{ ...detail, messages }} pendingAction={pendingAction} />);
      for (const name of ['Cancel goal…', 'Request change', 'What’s done?', 'What’s left?', 'Retry', 'Cancel pending message']) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
      }
      expect(screen.getByRole('button', { name: /^(Pause|Requesting pause…)$/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /^(Send message|Sending…)$/ })).toBeDisabled();
      expect(screen.getByLabelText('Requested model')).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'Message to the goal controller' })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'Message to the goal controller' })).toHaveValue('Preserve this mounted draft');
    }
  });

  it('annotates and disables all mutations in read-only mode', () => {
    render(<GoalControls {...props()} readOnly />);
    expect(screen.getByText(/Controls are unavailable in demo\/read-only mode/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'What’s done?' })).toBeDisabled();
  });
});
