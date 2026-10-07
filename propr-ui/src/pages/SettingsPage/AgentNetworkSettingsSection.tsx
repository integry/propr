import { useEffect, useState } from 'react';
import { SettingsField, SettingsSection } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';
import type { AgentNetworkDefaults, AgentNetworkSettingName, AgentNetworkValues } from './types';
import { parseAllowlistDraft } from './parseLoadedData';
import { egressAllowEntryError } from './egressAllowEntry';

interface AgentNetworkSettingsSectionProps {
  values: AgentNetworkValues;
  defaults?: AgentNetworkDefaults;
  onCommit: (name: AgentNetworkSettingName, value: AgentNetworkValues[AgentNetworkSettingName]) => void;
}

const DEFAULT_OPTION = '';
const CUSTOM_ALLOW_OPTION = 'custom';

interface AllowedHostsFieldsProps {
  savedAllow: string[] | null;
  defaultAllow: readonly string[];
  onCommit: (value: string[] | null) => void;
}

/** The instance allowlist: the environment default (null) or a custom list, which may be empty. */
function AllowedHostsFields({ savedAllow, defaultAllow, onCommit }: AllowedHostsFieldsProps) {
  const [allowDraft, setAllowDraft] = useState(() => (savedAllow ?? []).join('\n'));
  const [allowEdited, setAllowEdited] = useState(false);
  const [allowError, setAllowError] = useState<string>();
  const savedAllowKey = (savedAllow ?? []).join('\n');
  // Resync only when the saved list changes, never while the user is typing.
  useEffect(() => {
    setAllowDraft(savedAllowKey);
    setAllowEdited(false);
    setAllowError(undefined);
  }, [savedAllowKey]);
  // null follows the environment's list; an explicit list (even an empty one) replaces it.
  const usesDefaultAllow = savedAllow === null;

  /** Commits the draft as a custom list, unless an entry is one the API would reject: that stays in the draft, unsaved. */
  const commitAllowDraft = (keepDefaultWhenEmpty: boolean): void => {
    const hosts = parseAllowlistDraft(allowDraft);
    for (const host of hosts) {
      const error = egressAllowEntryError(host);
      if (error) { setAllowError(`"${host}" ${error}`); return; }
    }
    setAllowError(undefined);
    const next = !hosts.length && keepDefaultWhenEmpty ? null : hosts;
    if (next === null ? savedAllow !== null : savedAllow === null || next.join('\n') !== savedAllowKey) onCommit(next);
  };

  return (
    <>
      <SettingsField
        label="Allowed hosts list"
        htmlFor="agent_network_allow_source"
        helperText="The environment default is AGENT_NETWORK_ALLOW. A custom list replaces it; an empty custom list adds no hosts."
      >
        <select
          id="agent_network_allow_source"
          name="agent_network_allow_source"
          value={usesDefaultAllow ? DEFAULT_OPTION : CUSTOM_ALLOW_OPTION}
          onChange={event => {
            if (event.target.value === CUSTOM_ALLOW_OPTION) { commitAllowDraft(false); return; }
            setAllowError(undefined);
            onCommit(null);
          }}
          className={SETTINGS_CONTROL}
        >
          <option value={DEFAULT_OPTION}>{`Environment default (${defaultAllow.length ? `${defaultAllow.length} host${defaultAllow.length === 1 ? '' : 's'}` : 'none'})`}</option>
          <option value={CUSTOM_ALLOW_OPTION}>Custom list</option>
        </select>
      </SettingsField>
      <SettingsField
        label="Additional allowed hosts"
        htmlFor="agent_network_allow"
        helperText='One per line: an exact host, "*.example.com" for its subdomains, or host:port for a port other than 80/443. Entering hosts saves them as a custom list.'
      >
        <textarea
          id="agent_network_allow"
          name="agent_network_allow"
          rows={4}
          value={allowDraft}
          placeholder={usesDefaultAllow && defaultAllow.length ? defaultAllow.join('\n') : 'registry.example.com'}
          aria-invalid={allowError ? true : undefined}
          aria-describedby={allowError ? 'agent_network_allow_error' : undefined}
          onChange={event => { setAllowDraft(event.target.value); setAllowEdited(true); }}
          onBlur={() => {
            if (!allowEdited) return;
            setAllowEdited(false);
            // Emptying the default's draft keeps the default; emptying a custom list saves an empty one.
            commitAllowDraft(usesDefaultAllow);
          }}
          className={`${SETTINGS_CONTROL} font-mono`}
        />
        {allowError && <p id="agent_network_allow_error" role="alert" className="mt-1 text-xs text-red-600">{`Not saved: ${allowError}`}</p>}
      </SettingsField>
    </>
  );
}

/**
 * Instance network policy for agent containers. Restricted runs reach only
 * the built-in provider, GitHub and registry hosts plus the hosts listed here
 * and in each repository's `.propr/workflow.yml`.
 */
export function AgentNetworkSettingsSection({ values, defaults, onCommit }: AgentNetworkSettingsSectionProps) {
  const defaultMode = defaults?.agent_network_mode ?? 'open';
  const defaultEnforced = defaults?.agent_network_mode_enforced ?? false;
  const defaultIgnoreRepositoryAllow = defaults?.agent_network_ignore_repository_allow ?? false;

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
        label="Repository allowed hosts"
        htmlFor="agent_network_ignore_repository_allow"
        helperText="With enforced restricted mode, choose whether a repository's network.allow can add hosts. Ignoring them limits every run to the hosts below and the built-in list."
      >
        <select
          id="agent_network_ignore_repository_allow"
          name="agent_network_ignore_repository_allow"
          value={values.agent_network_ignore_repository_allow === null ? DEFAULT_OPTION : String(values.agent_network_ignore_repository_allow)}
          onChange={event => onCommit('agent_network_ignore_repository_allow', event.target.value === DEFAULT_OPTION ? null : event.target.value === 'true')}
          className={SETTINGS_CONTROL}
        >
          <option value={DEFAULT_OPTION}>{`Default (${defaultIgnoreRepositoryAllow ? 'ignored' : 'added'})`}</option>
          <option value="false">Added</option>
          <option value="true">Ignored when enforced</option>
        </select>
      </SettingsField>
      <AllowedHostsFields
        savedAllow={values.agent_network_allow}
        defaultAllow={defaults?.agent_network_allow ?? []}
        onCommit={value => onCommit('agent_network_allow', value)}
      />
    </SettingsSection>
  );
}

export default AgentNetworkSettingsSection;
