import type { ExtensionLibraryServer, ExtensionLibrarySkill } from '@propr/shared';
import { NEW_ITEM_LIMITS, nextServerName, type ItemLimitFields } from './extensionUi';

/** A new HTTPS server with the next free default name. */
export const newHttpsServer = (servers: { name: string }[], limits: ItemLimitFields = NEW_ITEM_LIMITS): ExtensionLibraryServer => ({
  kind: 'https', name: nextServerName(servers), url: '', enabled: true, tools: [], capability: 'read', authentication: 'none', ...limits,
});
/** Replace the server saved as `original` (or append a new one), keeping its saved enabled state. */
export function withServer(servers: ExtensionLibraryServer[], server: ExtensionLibraryServer, original?: string): ExtensionLibraryServer[] {
  if (original === undefined) return [...servers, server];
  return servers.map(saved => (saved.name === original ? { ...server, enabled: saved.enabled } as ExtensionLibraryServer : saved));
}

/** Replace the skill saved for the same bundle (keeping its enabled state) or append it. */
export function withSkill(skills: ExtensionLibrarySkill[], skill: ExtensionLibrarySkill): ExtensionLibrarySkill[] {
  return skills.some(saved => saved.bundleId === skill.bundleId)
    ? skills.map(saved => (saved.bundleId === skill.bundleId ? { ...skill, enabled: saved.enabled } : saved))
    : [...skills, skill];
}
