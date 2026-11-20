import { EXTENSION_MANAGED_EDITABLE_FIELDS, type ExtensionLibraryItems, type ExtensionLibraryServer, type ExtensionLibrarySkill } from '@propr/shared';
import { ExtensionError } from './extensionProfileStore.js';
import { credentialOwner } from './extensionCredentials.js';

type Item = ExtensionLibraryServer | ExtensionLibrarySkill;
const key = (item: Item) => ('kind' in item ? `server:${item.name}` : `skill:${item.bundleId}`);
const label = (item: Item) => ('kind' in item ? item.name : item.bundleId);
/** The read-only part of an item: everything except the fields an administrator may change. */
function definition(item: Item, fallback?: Item): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...item };
  for (const field of EXTENSION_MANAGED_EDITABLE_FIELDS) delete rest[field];
  // A save request may leave out the integrity value; ProPR fills it from the saved revision.
  if ('kind' in item && item.kind === 'package' && rest.integrity === undefined && fallback && 'kind' in fallback && fallback.kind === 'package') rest.integrity = fallback.integrity;
  return Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Refuse a library save that edits, removes or invents a plugin-managed item.
 * Managed items keep their definition, marker and stored credentials; only
 * `enabled`, `repositories`, `agents` and `autoApply` may change. They are
 * removed by uninstalling the plugin, never through the library.
 */
export function assertManagedItemsUnchanged(previous: Pick<ExtensionLibraryItems, 'servers' | 'skills'>, next: Pick<ExtensionLibraryItems, 'servers' | 'skills'>, replacements: Record<string, unknown> = {}): void {
  const before = new Map<string, Item>([...previous.servers, ...previous.skills].map(item => [key(item), item]));
  const after = new Map<string, Item>([...next.servers, ...next.skills].map(item => [key(item), item]));
  for (const [itemKey, item] of before) {
    if (!item.managedBy) continue;
    const current = after.get(itemKey);
    if (!current) throw new ExtensionError(409, `${label(item)} is managed by plugin ${item.managedBy.plugin}; uninstall the plugin to remove it`);
    if (JSON.stringify(definition(current, item)) !== JSON.stringify(definition(item))) throw new ExtensionError(409, `${label(item)} is managed by plugin ${item.managedBy.plugin}; only enabled, repository and agent limits and automatic apply can be changed`);
  }
  for (const [itemKey, item] of after) {
    if (item.managedBy && !before.get(itemKey)?.managedBy) throw new ExtensionError(400, 'Only ProPR adds plugin-managed items');
  }
  for (const name of Object.keys(replacements)) {
    if (isManagedCredential(previous.servers, name)) throw new ExtensionError(409, `The credential of ${credentialOwner(name)} comes from its plugin's connections`);
  }
}

/**
 * The items of a save request with the marker of each saved managed item
 * filled in where the request left it out (a client that rebuilds items from
 * their editable fields). Every other field is compared as sent.
 */
export function withManagedMarkers<T extends Pick<ExtensionLibraryItems, 'servers' | 'skills'>>(previous: Pick<ExtensionLibraryItems, 'servers' | 'skills'>, next: T): T {
  const marker = (item: Item) => (item.managedBy ? item : [...previous.servers, ...previous.skills].find(saved => saved.managedBy && key(saved) === key(item))?.managedBy);
  const fill = <I extends Item>(item: I): I => { const found = marker(item); return found && found !== item ? { ...item, managedBy: found } : item; };
  return { ...next, servers: next.servers.map(fill), skills: next.skills.map(fill) };
}

/** Whether a sealed-credential key (`server` or `server/VARIABLE`) belongs to a managed server. */
export const isManagedCredential = (servers: readonly ExtensionLibraryServer[], name: string) => servers.some(s => s.managedBy && s.name === credentialOwner(name));
