import { useState } from 'react';
import { extensionAgentAliasSchema } from '@propr/shared';
import { ExtensionItemPicker } from './ExtensionItemPicker';
import { isRepositoryName } from './extensionValidation';
import type { ExtensionChoices, ItemLimitFields } from './extensionUi';

const repositoryProblem = (value: string) => (isRepositoryName(value) ? null : 'Use owner/name, for example acme/website.');
const agentProblem = (value: string) => (extensionAgentAliasSchema.safeParse(value).success ? null : 'Use letters, digits, - and _ only.');

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
      {choices.unavailable && <p role="status" className="text-[12px] leading-5 text-amber-800">Agent and repository choices could not be loaded. Reopen Settings to retry, or type a value below.</p>}
      <ExtensionItemPicker label="Limit to repositories" options={choices.repositories} selected={item.repositories}
        onChange={repositories => onChange({ repositories })} manualLabel="Other repository (owner/name)" manualPlaceholder="owner/name"
        validate={repositoryProblem} hint="Optional. Leave all unticked to apply in every repository." allowManual />
      <label className="flex items-start gap-2 text-sm text-slate-900">
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={item.autoApply} onChange={event => onChange({ autoApply: event.target.checked })} />
        <span>Apply automatically
          <span className="block text-[12px] leading-5 text-slate-500">When off, only automations that add it use it.</span>
        </span>
      </label>
      <details className="text-sm" open={agentsOpen || undefined}>
        <summary className="cursor-pointer text-slate-600">Advanced</summary>
        <div className="mt-2">
          <ExtensionItemPicker label="Limit to agents" options={choices.agents} selected={item.agents}
            onChange={agents => onChange({ agents })} manualLabel="Other agent" validate={agentProblem}
            hint="Optional. Leave all unticked to apply for every agent." allowManual />
        </div>
      </details>
    </div>
  );
}
