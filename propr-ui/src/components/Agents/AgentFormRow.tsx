import React from 'react';

interface AgentFormRowProps {
  label: string;
  hint?: React.ReactNode;
  /** Id of the control the label names, when there is a single one. */
  htmlFor?: string;
  children: React.ReactNode;
}

/**
 * Settings layout: label and technical subtext in a column of at most 15rem
 * on the left, the control taking the rest of the pane up to max-w-2xl (672px),
 * so a wide pane does not leave a void beside short inputs.
 */
export const AgentFormRow: React.FC<AgentFormRowProps> = ({ label, hint, htmlFor, children }) => (
  <div className="grid gap-2 border-b border-slate-100 px-4 py-4 md:grid-cols-[minmax(10rem,15rem)_minmax(0,42rem)] md:gap-6">
    <div className="min-w-0">
      {htmlFor
        ? <label htmlFor={htmlFor} className="text-sm font-medium text-slate-900">{label}</label>
        : <p className="text-sm font-medium text-slate-900">{label}</p>}
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
    <div className="min-w-0">{children}</div>
  </div>
);

export const AGENT_INPUT_CLASSES = 'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:bg-slate-50 disabled:text-slate-500';

export const AGENT_CHIP_CLASSES = 'inline-flex items-center gap-1 rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700';
