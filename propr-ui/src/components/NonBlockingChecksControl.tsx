import React, { useEffect, useState } from 'react';
import type { MonitoredRepo } from '../api/proprApi';
import { formatWorkflowInput, parseWorkflowInput } from './workflowSelectionInput';

export const NonBlockingChecksControl: React.FC<{
  repo: MonitoredRepo;
  onUpdate: (repoId: string, checks: string[]) => void;
}> = ({ repo, onUpdate }) => {
  const stored = repo.nonBlockingChecks ?? [];
  // Compared by value so a poll that re-renders the bar keeps unsaved typing.
  const storedText = formatWorkflowInput(stored);
  const [text, setText] = useState(storedText);
  useEffect(() => setText(storedText), [repo.id, storedText]);
  const parsed = parseWorkflowInput(text);
  const commit = () => {
    if (text === storedText || parsed === null) return;
    if (parsed.join('\u0000').toLowerCase() !== stored.join('\u0000').toLowerCase()) onUpdate(repo.id, parsed);
  };

  return (
    <div className="w-full min-w-0 py-2 text-xs text-slate-600" onClick={(event) => event.stopPropagation()}>
      <label className="block w-full min-w-0">
        <span className="block">Checks that never block automation</span>
        <span className="mt-1 mb-1 block text-slate-500">Failures of these check runs never hold back auto-merge or ultrafix and never start a failed-CI follow-up. GitHub still shows them. Use <code>*</code> to match any text, for example <code>Validate unsigned * package</code>.</span>
        <textarea
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } }}
          aria-invalid={parsed === null}
          maxLength={4000}
          aria-label={`Checks that never block automation for ${repo.name}`}
          className="min-w-0 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-400"
          placeholder="Packaged Connect*, Validate unsigned * package"
        />
      </label>
      {parsed === null && <p role="alert">Close quoted check names and separate them with commas. Changes have not been saved.</p>}
    </div>
  );
};
