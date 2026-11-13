import { useState } from 'react';
import { ExtensionItemPicker } from './ExtensionItemPicker';
import type { ExtensionChoices, ItemLimitFields } from './extensionUi';

/** Where one library item applies: repositories, automatic use and (advanced) agents. */
export function ExtensionItemLimits({ item, choices, onChange }: {
  item: ItemLimitFields;
  choices: ExtensionChoices;
  onChange: (patch: Partial<ItemLimitFields>) => void;
}) {
  // Opened for an item that already has agent limits.
  const [agentsOpen] = useState(item.agents.length > 0);
  return (
    <div className="space-y-3">
      {choices.unavailable && <p role="status" className="text-sm text-amber-800">Agent and repository choices could not be loaded. Reopen Settings to retry, or add an unlisted value.</p>}
      <ExtensionItemPicker label="Limit to repositories" options={choices.repositories} selected={item.repositories}
        onChange={repositories => onChange({ repositories })} manualLabel="Unlisted repository (owner/name)"
        hint="Optional. Leave all unchecked to apply in every repository." allowManual />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={item.autoApply} onChange={event => onChange({ autoApply: event.target.checked })} />
        <span>Apply automatically
          <span className="block text-xs text-slate-500">Used by issue tasks, pull request follow-ups and automations in matching repositories. When off, only automations that add it use it.</span>
        </span>
      </label>
      <details className="text-sm" open={agentsOpen || undefined}>
        <summary className="cursor-pointer text-slate-600">Advanced</summary>
        <div className="mt-2">
          <ExtensionItemPicker label="Limit to agents" options={choices.agents} selected={item.agents}
            onChange={agents => onChange({ agents })} manualLabel="Unlisted agent alias"
            hint="Optional. Leave all unchecked to apply for every agent." allowManual />
        </div>
      </details>
    </div>
  );
}
