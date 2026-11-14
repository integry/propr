import type { ExtensionLibraryServer, ExtensionLibrarySkill } from '@propr/shared';
import { NEW_ITEM_LIMITS, nextServerName, type ItemLimitFields } from './extensionUi';

/** A new HTTPS server with the next free default name; only the limit fields are taken from `limits`. */
export const newHttpsServer = (servers: { name: string }[], limits: ItemLimitFields = NEW_ITEM_LIMITS): ExtensionLibraryServer => ({
  kind: 'https', name: nextServerName(servers), url: '', enabled: true, tools: [], capability: 'read', authentication: 'none',
  repositories: limits.repositories, agents: limits.agents, autoApply: limits.autoApply,
});

/** A new local npm package server with the next free default name; only the limit fields are taken from `limits`. */
export const newPackageServer = (servers: { name: string }[], limits: ItemLimitFields = NEW_ITEM_LIMITS): ExtensionLibraryServer => ({
  kind: 'package', name: nextServerName(servers), ecosystem: 'npm', package: '', version: '', enabled: true, tools: [], capability: 'read',
  args: [], env: [], secretEnv: [], repositories: limits.repositories, agents: limits.agents, autoApply: limits.autoApply,
});

const canonical = (value: unknown): unknown => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'enabled').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    : value);
/** The same saved settings, ignoring the enabled state (which only the list changes). */
const sameSettings = (a: object, b: object) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Replace the server the form was opened on (`opened`), keeping its saved
 * enabled state, or append a new one. Refuses when that server changed,
 * disappeared or (for a new one) its name was taken since the form opened.
 */
export function withServer(servers: ExtensionLibraryServer[], server: ExtensionLibraryServer, opened?: ExtensionLibraryServer): ExtensionLibraryServer[] {
  if (opened === undefined) {
    if (servers.some(saved => saved.name === server.name)) throw new Error(`Another server named ${server.name} was saved meanwhile. Reload and try again.`);
    return [...servers, server];
  }
  const saved = servers.find(item => item.name === opened.name);
  if (!saved || !sameSettings(saved, opened)) throw new Error(`Server ${opened.name} was changed elsewhere after you opened it. Reload to edit the current settings.`);
  return servers.map(item => (item === saved ? { ...server, enabled: saved.enabled } as ExtensionLibraryServer : item));
}

/**
 * Replace the skill the form was opened on (`opened`), keeping its saved
 * enabled state, or append a new one. Refuses when that skill changed or
 * disappeared, or (for a new one) the bundle was added since the form opened.
 */
export function withSkill(skills: ExtensionLibrarySkill[], skill: ExtensionLibrarySkill, opened?: ExtensionLibrarySkill): ExtensionLibrarySkill[] {
  const saved = skills.find(item => item.bundleId === (opened ?? skill).bundleId);
  if (opened === undefined) {
    if (saved) throw new Error('This skill was added to the library meanwhile. Reload and try again.');
    return [...skills, skill];
  }
  if (!saved || !sameSettings(saved, opened)) throw new Error('This skill was changed elsewhere after you opened it. Reload to edit the current settings.');
  return skills.map(item => (item === saved ? { ...skill, enabled: saved.enabled } : item));
}
