import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GoalDetail, GoalEvent } from '../../api/goalsApi';
import GoalControls from './GoalControls';
import GoalPlan from './GoalPlan';
import GoalStats from './GoalStats';
import { GOAL_EVENT_RETENTION_LIMIT, mergeGoalEvents, scopedGoalKey } from './goalDetailUtils';
import { projectGoalEvent } from './goalEventProjection';
import { detail as makeDetail, event, message, timestamp } from './goalDetailsTestFixtures';

const detail = makeDetail();

describe('goal detail utilities', () => {
  it('deduplicates replayed sequences, sorts gaps, and rejects cross-goal cache pollution', () => {
    expect(mergeGoalEvents([event(2)], [event(1), event(2, 'provider.status'), { ...event(3), goalId: 'other' }], 'goal-1'))
      .toEqual([event(1), event(2, 'provider.status')]);
    expect(scopedGoalKey('owner-a', 'integry/propr', 'goal-1')).not.toBe(scopedGoalKey('owner-b', 'integry/propr', 'goal-1'));
  });

  it('bounds retained tail and older-history windows while keeping dedupe and the authoritative tail', () => {
    const overBound = Array.from({ length: GOAL_EVENT_RETENTION_LIMIT + 500 }, (_, index) => event(index + 1));
    const tail = mergeGoalEvents([], overBound, 'goal-1');
    expect(tail).toHaveLength(GOAL_EVENT_RETENTION_LIMIT);
    expect(tail[0].sequence).toBe(501);
    expect(tail.at(-1)?.sequence).toBe(1_500);

    const withDuplicate = mergeGoalEvents(tail, [event(1_500, 'provider.status'), event(1_501)], 'goal-1');
    expect(withDuplicate).toHaveLength(GOAL_EVENT_RETENTION_LIMIT);
    expect(withDuplicate.find(item => item.sequence === 1_500)?.eventType).toBe('provider.status');
    expect(withDuplicate.at(-1)?.sequence).toBe(1_501);

    const older = mergeGoalEvents(withDuplicate, Array.from({ length: 700 }, (_, index) => event(index - 699)), 'goal-1', { ingestion: 'older' });
    expect(older).toHaveLength(GOAL_EVENT_RETENTION_LIMIT);
    expect(older[0].sequence).toBe(-699);
    expect(older.at(-1)?.sequence).toBe(1_501);
  });

});
describe('provider plan and statistics', () => {
  it('projects canonical provider-native events without rewriting their envelopes', () => {
    const events: GoalEvent[] = [
      { ...event(6, 'provider.plan'), payload: { items: [{ id: 'native-1', text: 'Inspect canonical DTOs', status: 'in_progress' }] } },
      { ...event(7, 'provider.status'), payload: { status: 'working', detail: 'Inspecting' } },
      { ...event(8, 'provider.model'), payload: { requestedModel: 'gpt-next', effectiveModel: 'gpt-next' } },
      { ...event(9, 'usage.reported'), payload: { provider: 'openai', model: 'gpt-next', occurrenceId: 'turn-1', inputTokens: 12, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 } },
      { ...event(10, 'checkpoint.saved'), payload: { checkpointId: 'checkpoint-10', label: 'Tests green' } },
      { ...event(11, 'provider.completed'), payload: { status: 'completed', summary: 'Native goal complete' } },
    ];
    const projected = events.reduce(projectGoalEvent, detail);

    expect(projected.plan).toMatchObject({ status: 'reported', sessionId: 'session-1', generation: 1, eventSequence: 6, items: [{ itemId: 'native-1' }] });
    expect(projected.provider).toMatchObject({ status: 'completed', statusDetail: 'Native goal complete', eventSequence: 11, checkpoint: { checkpointId: 'checkpoint-10', eventSequence: 10 } });
    expect(projected.goal).toMatchObject({ requestedModel: 'gpt-next', effectiveModel: 'gpt-next' });
    expect(projected.stats.tokens.total).toBe(198);
    expect(projected.stats.tokens.byProviderModel).toEqual(expect.arrayContaining([{ provider: 'openai', model: 'gpt-next', input: 12, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, total: 23 }]));
    expect(events[0]).toMatchObject({ eventType: 'provider.plan', kind: 'domain', payload: { items: [{ id: 'native-1' }] } });
  });

  it('renders the provider-native checklist with its session/generation/event fence', () => {
    render(<GoalPlan plan={{ status: 'reported', provider: 'codex', sessionId: 'session-1', generation: 2, eventSequence: 19, title: 'Native plan', items: [{ itemId: 'todo-1', text: 'Inspect files', status: 'in_progress', detail: null }], updatedAt: timestamp }} />);
    expect(screen.getByText('Coding agent plan')).toBeInTheDocument();
    expect(screen.getByText(/Authoritative provider projection.*session session-1.*generation 2.*event 19/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Coding agent checklist')).getByText('Inspect files')).toBeInTheDocument();
    expect(screen.queryByText(/ProPR checklist|advisory/i)).not.toBeInTheDocument();
  });

  it('shows token dimensions, active/paused timing, message lag, and passive artifacts', () => {
    render(<GoalStats stats={detail.stats} />);
    expect(screen.getByText('1h elapsed · 50m active · 8m paused')).toBeInTheDocument();
    expect(screen.getByText('2 issues · 1 pull requests')).toBeInTheDocument();
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
    expect(screen.getByText(/gpt-new requested, awaiting provider acknowledgement/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Requested model'), { target: { value: 'gpt-next' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request change' }));
    expect(handlers.onChangeModel).toHaveBeenCalledWith('gpt-next');
    rerender(<GoalControls {...handlers} detail={{ ...detail, goal: { ...detail.goal, requestedModel: 'gpt-next', effectiveModel: 'gpt-next' } }} />);
    expect(screen.queryByText(/awaiting provider acknowledgement/)).not.toBeInTheDocument();
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

  it('renders every FIFO delivery state and supports failed retry and queued cancellation', () => {
    const handlers = props();
    const messages = (['queued', 'delivering', 'delivered', 'acknowledged', 'failed', 'cancelled'] as const).map((state, index) => message(index + 1, state));
    render(<GoalControls {...handlers} detail={{ ...detail, messages }} />);
    for (const state of ['queued', 'delivering', 'delivered', 'acknowledged', 'failed', 'cancelled']) expect(screen.getByText(state)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(handlers.onRetryMessage).toHaveBeenCalledWith(messages[4]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }));
    expect(handlers.onCancelMessage).toHaveBeenCalledWith('message-1');
  });

  it('preserves full message drafts through prepend, middle, append, and composition edits', () => {
    render(<GoalControls {...props()} />);
    const draft = screen.getByRole('textbox', { name: 'Message to the coding agent' });
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
    const draft = screen.getByRole('textbox', { name: 'Message to the coding agent' });
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
    const draft = screen.getByRole('textbox', { name: 'Message to the coding agent' });

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
    const messages = [message(1, 'queued'), message(2, 'failed')];
    const view = render(<GoalControls {...handlers} detail={{ ...detail, messages }} />);
    const draft = screen.getByRole('textbox', { name: 'Message to the coding agent' });
    fireEvent.change(draft, { target: { value: 'Preserve this mounted draft' } });
    fireEvent.change(screen.getByLabelText('Requested model'), { target: { value: 'gpt-next' } });

    for (const pendingAction of ['pause', 'resume', 'cancel', 'model', 'message', 'cancel-message']) {
      view.rerender(<GoalControls {...handlers} detail={{ ...detail, messages }} pendingAction={pendingAction} />);
      for (const name of ['Cancel goal…', 'Request change', 'What’s done?', 'What’s left?', 'Retry', 'Cancel queued message']) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
      }
      expect(screen.getByRole('button', { name: /^(Pause|Requesting pause…)$/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /^(Send message|Sending…)$/ })).toBeDisabled();
      expect(screen.getByLabelText('Requested model')).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'Message to the coding agent' })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'Message to the coding agent' })).toHaveValue('Preserve this mounted draft');
    }
  });

  it('annotates and disables all mutations in read-only mode', () => {
    render(<GoalControls {...props()} readOnly />);
    expect(screen.getByText(/Controls are unavailable in demo\/read-only mode/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'What’s done?' })).toBeDisabled();
  });
});
