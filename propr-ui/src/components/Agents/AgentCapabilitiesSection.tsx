import React from 'react';
import { AGENT_CAPABILITIES, type AgentCapability } from '@propr/shared';
import { AgentFormRow } from './AgentFormRow';

/**
 * Whether the selected agent can use ProPR's MCP tools: `supported`, `unsupported`
 * (its runtime cannot receive an MCP config), or `unknown` (a pool or the default
 * agent, which the server checks on save).
 */
export type ProprMcpSupport = 'supported' | 'unsupported' | 'unknown';

interface AgentCapabilitiesSectionProps {
  capabilities: AgentCapability[];
  onChange: (capabilities: AgentCapability[]) => void;
  proprMcpSupport: ProprMcpSupport;
  /** Runtime of the selected agent, for the hints; null when not known. */
  agentType: string | null;
  disabled: boolean;
}

const CAPABILITY_TEXT: Record<AgentCapability, { label: string; description: string }> = {
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
};

const NATIVE_WEB_RUNTIMES = new Set(['claude', 'codex']);

/** Three independent capability toggles, each with what it allows. */
export const AgentCapabilitiesSection: React.FC<AgentCapabilitiesSectionProps> = ({
  capabilities, onChange, proprMcpSupport, agentType, disabled,
}) => {
  const toggle = (capability: AgentCapability, enabled: boolean) => {
    const next = new Set(capabilities);
    if (enabled) next.add(capability);
    else next.delete(capability);
    onChange(AGENT_CAPABILITIES.filter(candidate => next.has(candidate)));
  };

  const hintFor = (capability: AgentCapability): string | null => {
    if (capability === 'propr_mcp' && proprMcpSupport === 'unsupported') {
      return `Not available for ${agentType ?? 'this agent'}: only Claude and Codex agents can use ProPR tools.`;
    }
    if (capability === 'web' && agentType && !NATIVE_WEB_RUNTIMES.has(agentType)) {
      return `Best effort on ${agentType}: web access depends on what the runtime provides.`;
    }
    return null;
  };

  return (
    <AgentFormRow label="Capabilities" hint="What the agent may use while it writes its report.">
      <ul className="space-y-3">
        {AGENT_CAPABILITIES.map(capability => {
          const text = CAPABILITY_TEXT[capability];
          const locked = capability === 'propr_mcp' && proprMcpSupport === 'unsupported';
          const hint = hintFor(capability);
          const id = `agent-capability-${capability}`;
          return (
            <li key={capability} className="flex items-start gap-3">
              <input
                id={id}
                type="checkbox"
                role="switch"
                checked={capabilities.includes(capability) && !locked}
                disabled={disabled || locked}
                onChange={event => toggle(capability, event.target.checked)}
                aria-describedby={`${id}-description`}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-50"
              />
              <div className="min-w-0">
                <label htmlFor={id} className={`text-sm font-medium ${locked ? 'text-slate-400' : 'text-slate-900'}`}>
                  {text.label} <code className="ml-1 rounded-sm bg-slate-100 px-1 font-mono text-[11px] text-slate-600">{capability}</code>
                </label>
                <p id={`${id}-description`} className="text-xs text-slate-500">{text.description}</p>
                {hint && <p className="mt-0.5 text-xs text-amber-700" data-testid={`${id}-hint`}>{hint}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </AgentFormRow>
  );
};
