import React from 'react';
import { AUTOMATION_CAPABILITIES, type AutomationAutonomyMode, type AutomationCapability } from '@propr/shared';
import { AgentFormRow } from './AgentFormRow';
import { agentTypeLabel } from './agentPresentation';
import { mergeAvailableFor } from './agentEditorForm';

/**
 * Whether the selected agent can use ProPR's MCP tools: `supported`, `unsupported`
 * (its runtime cannot receive an MCP config), or `unknown` (a pool or the default
 * agent, which the server checks on save).
 */
export type ProprMcpSupport = 'supported' | 'unsupported' | 'unknown';

interface AgentCapabilitiesSectionProps {
  capabilities: AutomationCapability[];
  onChange: (capabilities: AutomationCapability[]) => void;
  proprMcpSupport: ProprMcpSupport;
  /** Runtime of the selected agent, for the hints; null when not known. */
  agentType: string | null;
  /** Merging happens in the action step, which a Report only automation does not have. */
  autonomy: AutomationAutonomyMode;
  disabled: boolean;
}

const CAPABILITY_TEXT: Record<AutomationCapability, { label: string; description: string }> = {
  repository_read: {
    label: 'Read repositories',
    description: 'Check out the selected repositories read-only so the agent can inspect the code.',
  },
  web: {
    label: 'Web access',
    description: 'Let the agent search and fetch web pages while it researches.',
  },
  propr_mcp: {
    label: 'ProPR tools',
    description: 'Let the report step read tasks, goals and plans through the ProPR MCP server.',
  },
  merge: {
    label: 'Merge pull requests',
    description: 'Let the action step merge pull requests that pass review and checks.',
  },
};

const NATIVE_WEB_RUNTIMES = new Set(['claude', 'codex']);

/** Independent capability toggles, each with what it allows. */
export const AgentCapabilitiesSection: React.FC<AgentCapabilitiesSectionProps> = ({
  capabilities, onChange, proprMcpSupport, agentType, autonomy, disabled,
}) => {
  const runtimeName = agentType ? agentTypeLabel(agentType) : 'this coding agent';
  /** Why a capability cannot be chosen now, or null when it can. */
  const lockReason = (capability: AutomationCapability): string | null => {
    if (capability === 'propr_mcp' && proprMcpSupport === 'unsupported') {
      return `Not available for ${runtimeName}: ProPR tools need Claude, Codex, Antigravity, Vibe or OpenCode 2.x.`;
    }
    if (capability !== 'merge') return null;
    if (proprMcpSupport === 'unsupported') return `Not available for ${runtimeName}: merging happens in the action step, which needs ProPR tools.`;
    if (!mergeAvailableFor(autonomy)) return 'Not available with Report only: there is no action step to merge in.';
    return null;
  };
  const toggle = (capability: AutomationCapability, enabled: boolean) => {
    const next = new Set(capabilities);
    if (enabled) next.add(capability);
    else next.delete(capability);
    onChange(AUTOMATION_CAPABILITIES.filter(candidate => next.has(candidate)));
  };

  const hintFor = (capability: AutomationCapability): string | null => {
    const locked = lockReason(capability);
    if (locked) return locked;
    if (capability === 'web' && agentType && !NATIVE_WEB_RUNTIMES.has(agentType)) {
      return `Best effort on ${agentTypeLabel(agentType)}: web access depends on what the runtime provides.`;
    }
    return null;
  };

  return (
    <AgentFormRow label="Capabilities" hint="What the coding agent may use while it writes the report.">
      <ul className="space-y-3">
        {AUTOMATION_CAPABILITIES.map(capability => {
          const text = CAPABILITY_TEXT[capability];
          const locked = lockReason(capability) !== null;
          const hint = hintFor(capability);
          const id = `agent-capability-${capability}`;
          return (
            <li key={capability} className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3">
              {/* A label around the 16px box answers a tap across 32px on touch layouts. */}
              <label htmlFor={id} className="touch-hit mt-0.5 inline-flex h-4 w-4">
              <input
                id={id}
                type="checkbox"
                role="switch"
                checked={capabilities.includes(capability) && !locked}
                disabled={disabled || locked}
                onChange={event => toggle(capability, event.target.checked)}
                aria-describedby={hint ? `${id}-description ${id}-hint` : `${id}-description`}
                className="h-4 w-4 flex-none rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-50"
              />
              </label>
              <div className="min-w-0">
                <label htmlFor={id} className={`text-sm font-medium ${locked ? 'text-slate-400' : 'text-slate-900'}`}>
                  {text.label}
                </label>
                <p id={`${id}-description`} className="text-xs text-slate-500">{text.description}</p>
                {hint && <p id={`${id}-hint`} className="mt-0.5 text-xs text-amber-700" data-testid={`${id}-hint`}>{hint}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </AgentFormRow>
  );
};
