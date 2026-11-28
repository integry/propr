import type { PluginView } from '../../api/pluginsApi';

export type Acknowledgement = { server: string; package: string; version: string; secretEnv: string[] };

/**
 * A ticked acknowledgement is bound to everything it confirms: server, package, exact version and variable names.
 * When a refreshed read changes any of them the old tick no longer matches, so the box shows unticked again.
 */
export const acknowledgementKey = (item: Acknowledgement) => JSON.stringify([item.server, item.package, item.version, item.secretEnv]);

/** The selection for the acknowledgements shown now: whether all are ticked, and the server names to submit. */
export function acknowledged(items: Acknowledgement[], checked: string[]) {
  const current = items.filter(item => checked.includes(acknowledgementKey(item)));
  return { ready: current.length === items.length, servers: current.map(item => item.server) };
}

type Recorded = NonNullable<PluginView['installation']>['acknowledgements'][string];

/** What changed in one package server since its secret variables were last acknowledged, in plain words. */
export function packageChanges(item: Acknowledgement, recorded: Recorded | undefined): string[] {
  if (!recorded) return [`New package server ${item.server} runs ${item.package}@${item.version} with the secret variables ${item.secretEnv.join(', ')}`];
  const changes: string[] = [];
  if (recorded.package !== item.package) changes.push(`Package changes from ${recorded.package} to ${item.package}`);
  if (recorded.version !== item.version) changes.push(`Version changes from ${recorded.version} to ${item.version}`);
  const added = item.secretEnv.filter(name => !recorded.secretEnv.includes(name));
  const removed = recorded.secretEnv.filter(name => !item.secretEnv.includes(name));
  if (added.length) changes.push(`Secret variables added: ${added.join(', ')}`);
  if (removed.length) changes.push(`Secret variables removed: ${removed.join(', ')}`);
  return changes.length ? changes : ['Its secret variables need a new acknowledgement'];
}

