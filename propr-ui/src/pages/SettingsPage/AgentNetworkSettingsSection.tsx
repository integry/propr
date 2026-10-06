import { useEffect, useState } from 'react';
import { SettingsField, SettingsSection } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';
import type { AgentNetworkDefaults, AgentNetworkSettingName, AgentNetworkValues } from './types';
import { parseAllowlistDraft } from './parseLoadedData';

interface AgentNetworkSettingsSectionProps {
  values: AgentNetworkValues;
  defaults?: AgentNetworkDefaults;
  onCommit: (name: AgentNetworkSettingName, value: AgentNetworkValues[AgentNetworkSettingName]) => void;
}

const DEFAULT_OPTION = '';

/**
 * Instance network policy for agent containers. Restricted runs reach only
 * the built-in provider, GitHub and registry hosts plus the hosts listed here
 * and in each repository's `.propr/workflow.yml`.
 */
export function AgentNetworkSettingsSection({ values, defaults, onCommit }: AgentNetworkSettingsSectionProps) {
  const savedAllow = values.agent_network_allow;
  const [allowDraft, setAllowDraft] = useState(() => (savedAllow ?? []).join('\n'));
  const [allowEdited, setAllowEdited] = useState(false);
  const savedAllowKey = (savedAllow ?? []).join('\n');
  // Resync only when the saved list changes, never while the user is typing.
  useEffect(() => {
    setAllowDraft(savedAllowKey);
    setAllowEdited(false);
  }, [savedAllowKey]);

  const defaultMode = defaults?.agent_network_mode ?? 'open';
  const defaultEnforced = defaults?.agent_network_mode_enforced ?? false;

  return (
    <SettingsSection
      title="Agent network"
      description="Restricted mode starts agent containers without a network interface; their only route out is a per-run proxy on the worker that allows the agent's provider API, GitHub and package registries, plus the hosts below and each repository's network.allow. Denied hosts are listed on the task timeline."
    >
      <SettingsField
        label="Network mode"
        htmlFor="agent_network_mode"
        helperText="Repositories can choose their own mode in .propr/workflow.yml unless restricted mode is enforced below."
      >
        <select
          id="agent_network_mode"
          name="agent_network_mode"
          value={values.agent_network_mode ?? DEFAULT_OPTION}
          onChange={event => onCommit('agent_network_mode', event.target.value === DEFAULT_OPTION ? null : event.target.value as 'open' | 'restricted')}
          className={SETTINGS_CONTROL}
        >
          <option value={DEFAULT_OPTION}>{`Default (${defaultMode})`}</option>
          <option value="open">Open</option>
          <option value="restricted">Restricted</option>
        </select>
      </SettingsField>
      <SettingsField
        label="Enforce restricted mode"
        htmlFor="agent_network_mode_enforced"
        helperText="With restricted mode, a repository's network.mode: open is ignored. Agents that cannot use the proxy are refused instead of falling back to open."
      >
        <select
          id="agent_network_mode_enforced"
          name="agent_network_mode_enforced"
          value={values.agent_network_mode_enforced === null ? DEFAULT_OPTION : String(values.agent_network_mode_enforced)}
          onChange={event => onCommit('agent_network_mode_enforced', event.target.value === DEFAULT_OPTION ? null : event.target.value === 'true')}
          className={SETTINGS_CONTROL}
        >
          <option value={DEFAULT_OPTION}>{`Default (${defaultEnforced ? 'enforced' : 'not enforced'})`}</option>
          <option value="true">Enforced</option>
          <option value="false">Not enforced</option>
        </select>
      </SettingsField>
      <SettingsField
        label="Additional allowed hosts"
        htmlFor="agent_network_allow"
        helperText='One per line: an exact host, "*.example.com" for its subdomains, or host:port for a port other than 80/443. Leave empty to use the environment default.'
      >
        <textarea
          id="agent_network_allow"
          name="agent_network_allow"
          rows={4}
          value={allowDraft}
          placeholder={defaults?.agent_network_allow?.length ? defaults.agent_network_allow.join('\n') : 'registry.example.com'}
          onChange={event => { setAllowDraft(event.target.value); setAllowEdited(true); }}
          onBlur={() => {
            if (!allowEdited) return;
            setAllowEdited(false);
            const parsed = parseAllowlistDraft(allowDraft);
            if ((parsed ?? []).join('\n') !== savedAllowKey) onCommit('agent_network_allow', parsed);
          }}
          className={`${SETTINGS_CONTROL} font-mono`}
        />
      </SettingsField>
    </SettingsSection>
  );
}

export default AgentNetworkSettingsSection;
