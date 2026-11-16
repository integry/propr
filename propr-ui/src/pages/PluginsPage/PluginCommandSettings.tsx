import { useState } from 'react';
import type { PluginCommandSettingView, PluginView } from '../../api/pluginsApi';
import { formatWhen, inputClass } from './pluginUi';

type PluginCommandView = NonNullable<PluginView['manifest']>['contributes']['commands'][number];

/** The write switch of a `needsWrite` command: off by default, explained next to it. */
function WriteSwitch({ command, setting, busy, onChange }: { command: PluginCommandView; setting: PluginCommandSettingView; busy: boolean; onChange: (allowed: boolean) => Promise<unknown> }) {
  // The requested state while the change is in flight; the saved state once the API answers.
  const [requested, setRequested] = useState<boolean | null>(null);
  const id = `plugin-command-write-${command.name}`;
  const servers = command.servers.length ? command.servers.join(', ') : 'none';
  return (
    <div className="space-y-1">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" data-testid={id} checked={requested ?? setting.writeAllowed} disabled={busy} aria-describedby={`${id}-help`}
          onChange={event => {
            const next = event.target.checked;
            setRequested(next);
            void onChange(next).finally(() => setRequested(null));
          }} />
        <span className="font-medium text-slate-900">Allow this command to use write access</span>
      </label>
      <p id={`${id}-help`} className="pl-6 text-xs text-slate-500">
        When on, a person with write permission on the repository can run /{command.name}, and that one run can use the plugin&apos;s servers it names ({servers}), write servers included.
        A retry of the run and later follow-ups get read access only. When off, /{command.name} is refused with a reply saying an administrator has not allowed it.
      </p>
      {setting.writeChangedBy && setting.writeChangedAt !== undefined && (
        <p className="pl-6 text-xs text-slate-500">{setting.writeAllowed ? 'Allowed' : 'Switched off'} by administrator {setting.writeChangedBy} · {formatWhen(setting.writeChangedAt)}</p>
      )}
    </div>
  );
}

/** The owner choice of a shared command name: which plugin the plain name runs when several enabled plugins offer it. */
function SharedOwner({ command, setting, busy, onChange }: { command: PluginCommandView; setting: NonNullable<PluginCommandSettingView['sharedOwner']>; busy: boolean; onChange: (owner: string | null) => Promise<unknown> }) {
  const id = `plugin-command-owner-${command.name}`;
  const specific = setting.candidates.flatMap(candidate => candidate.specific.map(name => `/${name}`));
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block font-medium text-slate-900">Plugin that /{command.name} runs when several plugins offer it</label>
      <select id={id} data-testid={id} className={`${inputClass} max-w-md`} value={setting.owner ?? ''} disabled={busy} aria-describedby={`${id}-help`}
        onChange={event => { void onChange(event.target.value || null); }}>
        <option value="">Not chosen: the only enabled plugin runs it</option>
        {setting.candidates.map(candidate => (
          <option key={candidate.pluginId} value={candidate.pluginId}>{candidate.pluginName}{candidate.enabled ? '' : ' (not enabled)'}</option>
        ))}
      </select>
      <p id={`${id}-help`} className="text-xs text-slate-500">
        /{command.name} is a shared name: other plugins may offer it too. Their specific commands ({specific.join(', ') || 'none'}) always work.
        With several enabled plugins and none chosen, /{command.name} replies asking for a specific command.
      </p>
      {setting.owner && setting.setBy && setting.setAt !== undefined && <p className="text-xs text-slate-500">Chosen by administrator {setting.setBy} · {formatWhen(setting.setAt)}</p>}
    </div>
  );
}

/**
 * Commands: the instance settings of the plugin's slash commands. Only
 * commands that have one are listed: the write switch of a command that needs
 * write access and the owner of a shared command name. Shown once the plugin
 * is installed; the page is for administrators only.
 */
export function PluginCommandSettings({ view, busy, onSetWrite, onSetOwner }: {
  view: PluginView; busy: boolean;
  onSetWrite: (command: string, allowed: boolean) => Promise<unknown>;
  onSetOwner: (command: string, owner: string | null) => Promise<unknown>;
}) {
  const commands = (view.manifest?.contributes.commands ?? []).filter(command => command.needsWrite || command.shared);
  if (!view.installation || !commands.length) return null;
  return (
    <section aria-labelledby="plugin-command-settings" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      <h2 id="plugin-command-settings" className="text-base font-semibold text-slate-900">Commands</h2>
      <ul className="mt-3 space-y-4 text-sm text-slate-700">
        {commands.map(command => {
          const setting = view.commands?.find(item => item.name === command.name);
          return (
            <li key={command.name} data-testid={`plugin-command-settings-${command.name}`} className="space-y-2">
              <p><code className="font-mono font-semibold text-slate-900">/{command.name}</code> · {command.description}</p>
              {command.needsWrite && setting && <WriteSwitch command={command} setting={setting} busy={busy} onChange={allowed => onSetWrite(command.name, allowed)} />}
              {command.shared && setting?.sharedOwner && <SharedOwner command={command} setting={setting.sharedOwner} busy={busy} onChange={owner => onSetOwner(command.name, owner)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
