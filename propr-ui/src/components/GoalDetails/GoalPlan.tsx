import type { GoalPlanProjection } from '../../api/goalContracts';

const statusTone = {
  pending: 'bg-slate-100 text-slate-700',
  in_progress: 'bg-blue-100 text-blue-800',
  completed: 'bg-teal-100 text-teal-800',
  blocked: 'bg-amber-100 text-amber-800',
  cancelled: 'bg-gray-100 text-gray-500',
} as const;

export default function GoalPlan({ plan }: { plan: GoalPlanProjection }) {
  return (
    <section aria-labelledby="provider-plan-title" className="rounded-lg border border-violet-200 bg-violet-50/40 p-3">
      <h2 id="provider-plan-title" className="text-sm font-semibold text-slate-800">Coding agent plan</h2>
      {plan.status === 'not-reported' ? (
        <p className="mt-2 text-xs text-slate-500">The coding agent has not reported a native plan or checklist.</p>
      ) : (
        <>
          <p className="mt-1 text-[11px] text-slate-500">
            Authoritative provider projection · {plan.provider} · session {plan.sessionId} · generation {plan.generation} · event {plan.eventSequence}
          </p>
          {plan.title && <p className="mt-2 text-xs font-medium text-slate-700">{plan.title}</p>}
          {plan.items.length === 0 ? <p className="mt-2 text-xs text-slate-500">The provider reported an empty plan.</p> : (
            <ol aria-label="Coding agent checklist" className="mt-2 space-y-1.5">
              {plan.items.map(item => (
                <li key={item.itemId} className="rounded border border-violet-100 bg-white p-2 text-xs text-slate-700">
                  <div className="flex items-start gap-2">
                    <span aria-hidden="true">{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◉' : item.status === 'blocked' ? '!' : '○'}</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.text}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusTone[item.status]}`}>{item.status.replace('_', ' ')}</span>
                  </div>
                  {item.detail && <p className="mt-1 pl-5 text-[11px] text-slate-500">{item.detail}</p>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
