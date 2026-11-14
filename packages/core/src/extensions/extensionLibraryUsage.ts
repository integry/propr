import type { Knex } from 'knex';
import type { ExtensionLibraryRevision, ExtensionLibraryUsage } from '@propr/shared';
import type { ExtensionLibraryStore } from './extensionProfileStore.js';

const parseList = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
};

/** Profile names of the legacy profile mappings, keyed by the migrated item names they list. */
async function importedFrom(database: Knex, library: ExtensionLibraryRevision): Promise<ExtensionLibraryUsage['importedFrom']> {
  // Item names are data: null-prototype maps never resolve a name such as `constructor` to an inherited property.
  const result: ExtensionLibraryUsage['importedFrom'] = { servers: Object.create(null) as Record<string, string[]>, skills: Object.create(null) as Record<string, string[]> };
  if (!await database.schema.hasTable('extension_legacy_profile_items') || !await database.schema.hasTable('extension_profile_revisions')) return { servers: {}, skills: {} };
  const rows = await database('extension_legacy_profile_items').select('profile_id', 'revision', 'servers', 'skills');
  for (const row of rows) {
    const revision = row.revision ?? (await database('extension_profiles').where({ id: row.profile_id }).first('revision'))?.revision;
    const snapshot = revision === undefined ? undefined : await database('extension_profile_revisions').where({ profile_id: row.profile_id, revision }).first('snapshot');
    let name = String(row.profile_id);
    try { name = (JSON.parse(snapshot?.snapshot ?? 'null') as { name?: string } | null)?.name || name; } catch { /* The id names the profile. */ }
    const add = (target: Record<string, string[]>, key: string) => { target[key] = [...new Set([...(Object.hasOwn(target, key) ? target[key] : []), name])]; };
    for (const server of parseList(row.servers)) if (library.servers.some(s => s.name === server)) add(result.servers, server);
    for (const skill of parseList(row.skills)) if (library.skills.some(s => s.bundleId === skill)) add(result.skills, skill);
  }
  // Ordinary objects for callers; `fromEntries` defines every name as an own property.
  return { servers: Object.fromEntries(Object.entries(result.servers)), skills: Object.fromEntries(Object.entries(result.skills)) };
}

/** Automations adding each item of `library`, and profiles its migrated items came from. */
export async function extensionLibraryUsage(store: ExtensionLibraryStore, library: ExtensionLibraryRevision): Promise<ExtensionLibraryUsage> {
  const automations = await store.automationsAdding({ servers: library.servers.map(s => s.name), skills: library.skills.map(s => s.bundleId) });
  return { automations: automations.sort((a, b) => a.name.localeCompare(b.name, 'en')), importedFrom: await importedFrom(store.database, library) };
}
