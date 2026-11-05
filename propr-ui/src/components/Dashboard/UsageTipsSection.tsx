import { useCallback, useEffect, useRef, useState } from 'react';
import { Lightbulb, X } from 'lucide-react';
import type { UsageTip } from '@propr/shared';
import { dismissUsageTip, getUsageTips, USAGE_TIPS_SETTINGS_CHANGED } from '../../api/usageTipsApi';

export function UsageTipsSection() {
  const [tips, setTips] = useState<UsageTip[]>([]);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const hidden = useRef(new Set<string>());
  const mounted = useRef(false);
  const enabled = useRef(false);
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++version.current;
    try {
      const result = await getUsageTips();
      if (mounted.current && version.current === request) {
        enabled.current = result.enabled;
        setTips(result.enabled ? result.tips.filter(t => !hidden.current.has(t.id)) : []);
      }
    } catch {
      if (mounted.current && version.current === request) { enabled.current = false; setTips([]); }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    window.addEventListener(USAGE_TIPS_SETTINGS_CHANGED, refresh);
    return () => { mounted.current = false; window.removeEventListener(USAGE_TIPS_SETTINGS_CHANGED, refresh); };
  }, [refresh]);

  const dismiss = async (tip: UsageTip) => {
    if (hidden.current.has(tip.id)) return;
    const eventId = failures[tip.id] ?? crypto.randomUUID();
    hidden.current.add(tip.id);
    version.current++; // discard reads started before this deliberate action
    setTips(current => current.filter(t => t.id !== tip.id));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await dismissUsageTip(tip.id, eventId);
        hidden.current.delete(tip.id);
        if (mounted.current) {
          setFailures(current => { const next = { ...current }; delete next[tip.id]; return next; });
          await refresh();
        }
        return;
      } catch {
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    hidden.current.delete(tip.id);
    if (mounted.current && enabled.current) {
      setFailures(current => ({ ...current, [tip.id]: eventId }));
      setTips(current => current.some(t => t.id === tip.id) ? current : [tip, ...current].slice(0, 3));
    }
  };
  if (!tips.length) return null;
  return (
    <section aria-label="Usage tips" className="border-t border-slate-200 bg-slate-50/70 px-4 py-4">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        <Lightbulb aria-hidden="true" size={13} /> For your workflow
      </div>
      <div className="space-y-3">
        {tips.map(tip => (
          <div key={tip.id} className="flex items-start gap-3 text-xs">
            <div className="min-w-0 flex-1">
              <a href={tip.docUrl} target="_blank" rel="noreferrer" className="font-medium text-slate-800 hover:underline">{tip.title}</a>
              {tip.kind === 'discovery' && <span className="ml-2 text-[10px] text-slate-500">New to you</span>}
              <p className="mt-0.5 leading-5 text-slate-500">{tip.body}</p>
              {failures[tip.id] && <button className="mt-1 text-slate-600 underline" onClick={() => void dismiss(tip)}>Dismissal not saved. Retry</button>}
            </div>
            <button type="button" aria-label={`Dismiss ${tip.title}`} title="Dismiss for now" onClick={() => void dismiss(tip)}
              className="-mr-1 -mt-1 rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X size={14} aria-hidden="true" /></button>
          </div>
        ))}
      </div>
    </section>
  );
}
