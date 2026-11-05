import { CirclePause, CirclePlay, CircleStop, HelpCircle, MessageSquareReply, ShieldAlert } from 'lucide-react';
import type { GoalAttention, GoalBlocker, GoalBlockerAction } from '@propr/shared';

/**
 * What the goal needs from its operator, from the same projection `get_goal`,
 * the attention listing and the dashboard read. Only explicit signals appear
 * here — a confirmed pause or a structured provider question or approval —
 * never silence or slow work.
 *
 * Provider text is untrusted: it is rendered as plain text, never as markup or
 * links, and is already bounded and secret-redacted by the server.
 */

const CATEGORY_LABELS: Record<GoalBlocker['category'], string> = {
  question: 'The agent asked a question',
  approval: 'The agent is waiting for an approval',
  paused: 'Paused and waiting for you',
};

const CATEGORY_ICONS: Record<GoalBlocker['category'], typeof HelpCircle> = {
  question: HelpCircle,
  approval: ShieldAlert,
  paused: CirclePause,
};

const buttonClass = 'inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';

export interface GoalAttentionHandlers {
  answer(): void;
  resume(): void;
  pause(): void;
  cancel(): void;
}

function observedLabel(blocker: GoalBlocker): string | null {
  if (!blocker.firstObservedAt) return null;
  const first = new Date(blocker.firstObservedAt).toLocaleString();
  return blocker.detection.kind === 'goal_control' ? `Since ${first}` : `First seen ${first}`;
}

const ACTION_BUTTONS: Record<GoalBlockerAction, { label: (blocker: GoalBlocker) => string; Icon: typeof HelpCircle; className: string }> = {
  send_input: {
    label: blocker => blocker.category === 'question' ? 'Answer' : 'Send input',
    Icon: MessageSquareReply,
    className: 'bg-primary-600 text-white hover:bg-primary-700',
  },
  resume: { label: () => 'Resume', Icon: CirclePlay, className: 'border border-green-300 bg-white text-green-800 hover:bg-green-50' },
  pause: { label: () => 'Pause', Icon: CirclePause, className: 'border border-amber-300 bg-white text-amber-800 hover:bg-amber-50' },
  cancel: { label: () => 'Cancel goal', Icon: CircleStop, className: 'border border-red-300 bg-white text-red-700 hover:bg-red-50' },
};

const HANDLER: Record<GoalBlockerAction, keyof GoalAttentionHandlers> = {
  send_input: 'answer', resume: 'resume', pause: 'pause', cancel: 'cancel',
};

function QuestionDetail({ question }: { question: GoalBlocker['questions'][number] }) {
  return <>
    {question.options.length > 0 && <ul aria-label="Suggested answers" className="mt-1.5 flex flex-wrap gap-1.5">{question.options.map(option => <li key={option} className="rounded border border-amber-200 bg-white px-2 py-0.5 text-xs text-slate-700">{option}</li>)}</ul>}
    {question.confidential && <p className="mt-1 text-xs text-slate-500">This answer is secret; ProPR will not relay it.</p>}
  </>;
}

function BlockerItem({ blocker, canAct, busy, handlers }: {
  blocker: GoalBlocker;
  canAct: boolean;
  busy: boolean;
  handlers: GoalAttentionHandlers;
}) {
  const Icon = CATEGORY_ICONS[blocker.category];
  const observed = observedLabel(blocker);
  // One question is the summary itself: show it once, with its header and suggested answers.
  const single = blocker.questions.length === 1 ? blocker.questions[0] : null;
  const listed = blocker.questions.length > 1 ? blocker.questions : [];
  return <li data-testid="goal-blocker" data-blocker-category={blocker.category} className="py-4 first:pt-0 last:pb-0">
    <div className="flex items-start gap-3">
      <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 flex-none text-amber-600" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-amber-950">{CATEGORY_LABELS[blocker.category]}</p>
        {single?.header && <p className="mt-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">{single.header}</p>}
        {blocker.category !== 'paused' && <p className={`${single?.header ? 'mt-0.5' : 'mt-1'} whitespace-pre-wrap break-words text-sm leading-6 text-slate-800`} data-testid="goal-blocker-summary">{blocker.summary}</p>}
        {single && <QuestionDetail question={single} />}
        {listed.length > 0 && <ol className="mt-2 space-y-2">{listed.map(question => <li key={question.id} className="text-sm text-slate-800">
          {question.header && <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{question.header}</p>}
          <p className="whitespace-pre-wrap break-words">{question.question}</p>
          <QuestionDetail question={question} />
        </li>)}</ol>}
        <p className="mt-2 text-xs text-amber-900">{blocker.responseHint}</p>
        <p className="mt-1 text-xs text-slate-500">
          {observed && <time dateTime={blocker.firstObservedAt ?? undefined}>{observed}</time>}
          {observed && blocker.provider && <span aria-hidden="true"> · </span>}
          {blocker.provider && <span className="capitalize">{blocker.provider}</span>}
        </p>
        {canAct && blocker.responseActions.length > 0 && <div className="mt-3 flex flex-wrap gap-2">
          {blocker.responseActions.map(action => {
            const { label, Icon: ActionIcon, className } = ACTION_BUTTONS[action];
            return <button key={action} type="button" disabled={busy} onClick={() => handlers[HANDLER[action]]()} className={`${buttonClass} ${className}`}>
              <ActionIcon aria-hidden="true" className="h-4 w-4" />{label(blocker)}
            </button>;
          })}
        </div>}
      </div>
    </div>
  </li>;
}

export function GoalAttentionPanel({ attention, canAct, busy, handlers }: {
  attention: GoalAttention | undefined;
  canAct: boolean;
  busy: boolean;
  handlers: GoalAttentionHandlers;
}) {
  if (!attention?.waitingForOperator || attention.blockers.length === 0) return null;
  return <section aria-labelledby="goal-attention-heading" data-testid="goal-attention" className="border border-amber-300 bg-amber-50 p-4">
    <h2 id="goal-attention-heading" className="text-[10px] font-bold uppercase tracking-widest text-amber-800">Needs you</h2>
    <ul className="mt-3 divide-y divide-amber-200">
      {attention.blockers.map(blocker => <BlockerItem key={blocker.id} blocker={blocker} canAct={canAct} busy={busy} handlers={handlers} />)}
    </ul>
  </section>;
}

/** A compact list badge: the goal is waiting on its operator. */
export function GoalNeedsYouBadge({ attention }: { attention: GoalAttention | undefined }) {
  const blocker = attention?.waitingForOperator ? attention.blockers[0] : undefined;
  if (!blocker || blocker.category === 'paused') return null;
  return <span data-testid="goal-needs-you" title={blocker.summary} className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
    {blocker.category === 'question' ? 'Question' : 'Approval'}
  </span>;
}
