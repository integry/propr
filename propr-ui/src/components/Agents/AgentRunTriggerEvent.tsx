import React from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import type { AutomationRunRecord } from '../../api/automationDefinitionsApi';
import { formatTimestamp } from './agentRunPresentation';

const LINK = 'inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:underline';

/** The event that started an `event` run: what was blocked, why, and links to the plan and the issue. */
export const AgentRunTriggerEvent: React.FC<{ run: Pick<AutomationRunRecord, 'trigger' | 'triggerEvent'> }> = ({ run }) => {
  const event = run.triggerEvent;
  if (run.trigger !== 'event' || !event || event.type !== 'plan.issue_blocked') return null;
  return (
    <section aria-labelledby="agent-run-event-title" className="rounded-lg border border-slate-200 bg-white" data-testid="agent-run-trigger-event">
      <h2 id="agent-run-event-title" className="border-b border-slate-200 px-4 py-2 text-sm font-semibold text-slate-900">Started by an event</h2>
      <div className="space-y-2 px-4 py-3 text-sm">
        <p className="text-slate-800">
          Issue <span className="font-medium">#{event.issueNumber}</span> in <span className="font-mono text-xs">{event.repository}</span> became
          blocked in {event.planName ? <span className="font-medium">{event.planName}</span> : 'an epic plan'}
          <span className="text-slate-500"> · {formatTimestamp(event.occurredAt)}</span>
        </p>
        <p className="text-slate-700">
          <code className="rounded-sm bg-slate-100 px-1 font-mono text-[11px] text-slate-600">{event.reasonKind}</code>
          {event.reason && <span className="ml-2 whitespace-pre-wrap">{event.reason}</span>}
        </p>
        <nav aria-label="Event links" className="flex flex-wrap gap-4 pt-1">
          <Link to={`/studio/${encodeURIComponent(event.planId)}`} className={LINK}>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Open plan
          </Link>
          {/^https:\/\//.test(event.issueUrl) && <a href={event.issueUrl} target="_blank" rel="noreferrer" className={LINK}>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Open issue
          </a>}
        </nav>
      </div>
    </section>
  );
};
