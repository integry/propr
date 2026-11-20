import type { ExtensionLibraryRevision, ExtensionLibraryServer, ExtensionSecretAcknowledgement } from '@propr/shared';
import { packageSecretServers } from './extensionCredentials.js';
import { ExtensionError } from './extensionProfileStore.js';
import { resolveNpmPackage } from './packageRegistry.js';

/**
 * Record the registry integrity value of every package server. A server whose
 * package, version and executable are unchanged from the saved revision keeps
 * its recorded value without a registry request; any other is resolved now.
 * A value sent by the client is never trusted.
 */
export async function pinPackageServers(servers: ExtensionLibraryServer[], saved: ExtensionLibraryServer[], environment: NodeJS.ProcessEnv): Promise<ExtensionLibraryServer[]> {
  const pinned: ExtensionLibraryServer[] = [];
  for (const server of servers) {
    if (server.kind !== 'package') { pinned.push(server); continue; }
    const previous = saved.find(s => s.kind === 'package' && s.name === server.name && s.ecosystem === server.ecosystem && s.package === server.package && s.version === server.version && s.bin === server.bin);
    const integrity = previous?.kind === 'package' && previous.integrity ? previous.integrity : (await resolveNpmPackage(server, environment)).integrity;
    pinned.push({ ...server, integrity });
  }
  return pinned;
}

/** Acknowledgements of plugin-managed package servers, from their plugin; a name mapped to undefined has none. */
export type ManagedAcknowledgements = Record<string, ExtensionSecretAcknowledgement | undefined>;

const acknowledgementBinding = (value: { package: string; version: string; secretEnv: string[] }) => JSON.stringify([value.package, value.version, [...value.secretEnv].sort()]);

/** Validate the names a save acknowledges: package servers with secret variables only. */
export function parseAcknowledgements(value: unknown, servers: ExtensionLibraryServer[]): string[] {
  if (value === undefined) return [];
  const names = packageSecretServers(servers).map(s => s.name);
  if (!Array.isArray(value) || value.length > names.length || value.some(name => typeof name !== 'string' || !names.includes(name))) throw new ExtensionError(400, 'Invalid secret acknowledgement');
  return value as string[];
}

/**
 * The acknowledgements a new revision records. A package server with secret
 * variables needs one: carried from the base revision while its package,
 * version and secret variable names are unchanged, otherwise given by this
 * save (`acknowledged`) and recorded with the actor and time. With `carry`
 * (a change that alters no server) existing ones carry over unchanged.
 *
 * A plugin-managed server's acknowledgement is the one recorded when its
 * plugin was installed or approved, passed in `managed` by the plugin sync;
 * a library save never acknowledges it. Without one the server is recorded
 * without an acknowledgement and its marker keeps it inactive.
 */
// eslint-disable-next-line max-params -- the base revision, new servers, acknowledged names, actor, time and managed acknowledgements are explicit inputs
export function secretAcknowledgements(previous: ExtensionLibraryRevision, servers: ExtensionLibraryServer[], acknowledged: readonly string[] | 'carry', actor: string, now: number, managed: ManagedAcknowledgements = {}): Record<string, ExtensionSecretAcknowledgement> {
  const result: Record<string, ExtensionSecretAcknowledgement> = {};
  for (const server of packageSecretServers(servers)) {
    const carried = previous.acknowledgements && Object.hasOwn(previous.acknowledgements, server.name) ? previous.acknowledgements[server.name] : undefined;
    if (server.managedBy) {
      const recorded = Object.hasOwn(managed, server.name) ? managed[server.name] : carried;
      if (recorded && acknowledgementBinding(recorded) === acknowledgementBinding(server)) result[server.name] = recorded;
      continue;
    }
    if (carried && acknowledgementBinding(carried) === acknowledgementBinding(server)) result[server.name] = carried;
    else if (acknowledged !== 'carry' && acknowledged.includes(server.name)) result[server.name] = { actor, at: now, package: server.package, version: server.version, secretEnv: [...server.secretEnv] };
    else if (acknowledged !== 'carry') throw new ExtensionError(400, `Confirm that the secret variables of ${server.name} are readable by the agent and scripts in the task container before saving`);
  }
  return result;
}
