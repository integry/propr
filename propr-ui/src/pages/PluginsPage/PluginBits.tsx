import { Activity, BookOpen, CircleCheck, CircleDashed, MessageSquare, Puzzle, Rocket, Ticket } from 'lucide-react';
import type { ReactNode } from 'react';
import type { PluginManifestView, PluginView } from '../../api/pluginsApi';
import { BADGES, pluginBadge } from './pluginUi';

const CATEGORY_ICONS = {
  messaging: MessageSquare, 'issue-tracking': Ticket, observability: Activity,
  deployment: Rocket, context: BookOpen, other: Puzzle,
} as const;

/** ProPR draws the icon from the plugin's category; no plugin-supplied image or markup is rendered. */
export function PluginIcon({ category }: { category?: PluginManifestView['category'] }) {
  const Icon = (category && CATEGORY_ICONS[category]) || Puzzle;
  return (
    <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
      <Icon className="h-5 w-5" />
    </span>
  );
}

export function PluginStateBadge({ view }: { view: PluginView }) {
  const badge = pluginBadge(view);
  const shown = BADGES[badge];
  return (
    <span data-testid="plugin-state" data-state={badge}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-4 font-semibold uppercase tracking-wide ${shown.className}`}>
      {shown.label}
    </span>
  );
}

/** One step of the plugin detail: a numbered heading with its done / to do state. */
export function PluginStep({ number, title, done, children }: { number: number; title: string; done: boolean; children: ReactNode }) {
  const id = `plugin-step-${number}`;
  return (
    <section aria-labelledby={id} data-testid="plugin-step" data-done={done} className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      <h2 id={id} className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900">
        {done ? <CircleCheck aria-hidden="true" className="h-5 w-5 text-teal-700" /> : <CircleDashed aria-hidden="true" className="h-5 w-5 text-slate-400" />}
        <span>{number}. {title}</span>
        <span className={`text-xs font-medium ${done ? 'text-teal-800' : 'text-slate-500'}`}>{done ? 'Done' : 'To do'}</span>
      </h2>
      <div className="mt-3 space-y-3 text-sm text-slate-700">{children}</div>
    </section>
  );
}

/** A manifest link: only `https` URLs reach this component. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="break-all font-medium text-teal-700 underline hover:text-teal-800">{children}</a>;
}
