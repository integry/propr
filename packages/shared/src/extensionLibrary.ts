import { z } from 'zod';
import {
  EXTENSION_LIMITS, EXTENSION_PROFILE_VERSION, catalogMcpSchema, extensionAgentAliasSchema, extensionRepositorySchema,
  extensionServerNameSchema, remoteMcpSchema, type ExtensionSecretStatus, type ExtensionSkillBundle,
} from './extensionProfiles.js';

/**
 * The instance extension library: one list of MCP servers and skill bundle
 * references. Each item carries its own limits (repositories, agents), an
 * `enabled` switch and `autoApply`. Automations add items explicitly on top.
 */
export const EXTENSION_LIBRARY_VERSION = EXTENSION_PROFILE_VERSION;
export const EXTENSION_LIBRARY_LIMITS = { servers: 32, bundles: 32, repositories: 64, agents: 64 } as const;
export const EXTENSION_RUNTIMES = ['claude', 'codex'] as const;

const itemLimits = {
  /** Empty means every repository. */
  repositories: z.array(extensionRepositorySchema).max(EXTENSION_LIBRARY_LIMITS.repositories).default([]),
  /** Empty means every agent. */
  agents: z.array(extensionAgentAliasSchema).max(EXTENSION_LIBRARY_LIMITS.agents).default([]),
  /** When false the item applies only where it is added explicitly. */
  autoApply: z.boolean().default(true),
};
export const libraryRemoteServerSchema = remoteMcpSchema.extend(itemLimits);
export const libraryCatalogServerSchema = catalogMcpSchema.extend(itemLimits);
export const extensionLibraryServerSchema = z.discriminatedUnion('kind', [libraryRemoteServerSchema, libraryCatalogServerSchema]);
export const extensionLibrarySkillSchema = z.strictObject({ bundleId: z.uuid(), enabled: z.boolean(), ...itemLimits });
export type ExtensionLibraryServer = z.infer<typeof extensionLibraryServerSchema>;
export type ExtensionLibrarySkill = z.infer<typeof extensionLibrarySkillSchema>;
export type ExtensionLibraryServerInput = z.input<typeof extensionLibraryServerSchema>;
export type ExtensionLibrarySkillInput = z.input<typeof extensionLibrarySkillSchema>;

export const extensionLibraryInputSchema = z.strictObject({
  version: z.literal(EXTENSION_LIBRARY_VERSION),
  servers: z.array(extensionLibraryServerSchema).max(EXTENSION_LIBRARY_LIMITS.servers),
  skills: z.array(extensionLibrarySkillSchema).max(EXTENSION_LIBRARY_LIMITS.bundles),
}).superRefine((v, ctx) => {
  if (new Set(v.servers.map(s => s.name)).size !== v.servers.length) ctx.addIssue({ code: 'custom', message: 'Duplicate server names' });
  if (new Set(v.skills.map(s => s.bundleId)).size !== v.skills.length) ctx.addIssue({ code: 'custom', message: 'Duplicate bundles' });
});
export type ExtensionLibraryInput = z.input<typeof extensionLibraryInputSchema>;
export type ExtensionLibraryItems = z.infer<typeof extensionLibraryInputSchema>;

/** One immutable library revision. Revision 0 is the empty library before the first save. */
export interface ExtensionLibraryRevision extends ExtensionLibraryItems {
  instanceId: string; revision: number;
  createdAt: number; updatedAt: number; auditActor: string;
  secrets: Record<string, ExtensionSecretStatus>;
  skillBundles: ExtensionSkillBundle[];
}

/** Library items an automation adds on top of what applies automatically. */
export const automationExtensionsSchema = z.strictObject({
  servers: z.array(extensionServerNameSchema).max(EXTENSION_LIBRARY_LIMITS.servers),
  skills: z.array(z.uuid()).max(EXTENSION_LIBRARY_LIMITS.bundles),
}).superRefine((v, ctx) => {
  if (new Set(v.servers).size !== v.servers.length || new Set(v.skills).size !== v.skills.length) ctx.addIssue({ code: 'custom', message: 'Duplicate extensions' });
});
export type AutomationExtensions = z.infer<typeof automationExtensionsSchema>;
export const EMPTY_AUTOMATION_EXTENSIONS: AutomationExtensions = Object.freeze({ servers: [], skills: [] }) as AutomationExtensions;
export function hasAutomationExtensions(value: AutomationExtensions | null | undefined): boolean {
  return Boolean(value && (value.servers.length || value.skills.length));
}

/** Stored automation `extensions`; a corrupt or missing value adds nothing. */
export function parseAutomationExtensions(value: string | null | undefined): AutomationExtensions {
  if (!value) return { servers: [], skills: [] };
  try {
    const parsed = JSON.parse(value) as Partial<AutomationExtensions> | null;
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []);
    return { servers: strings(parsed?.servers), skills: strings(parsed?.skills) };
  } catch {
    return { servers: [], skills: [] };
  }
}
/**
 * Column value for automation `extensions`. Any written selection, including
 * an explicit clear (`null` or empty lists), is stored as JSON: a null column
 * marks a row whose pre-library profile selection the startup migration has
 * not translated yet, so storing a clear as null would let a later migration
 * restore the removed items. Only an absent value (`undefined`) stays null.
 */
export function serializeAutomationExtensions(value: AutomationExtensions | null | undefined): string | null {
  if (value === undefined) return null;
  return JSON.stringify({ servers: value?.servers ?? [], skills: value?.skills ?? [] });
}

export type ExtensionSkipReason = 'not_found' | 'disabled' | 'runtime' | 'repository' | 'agent' | 'write_not_authorized' | 'secret_not_configured' | 'run_limit';
export interface ExtensionSkippedItem {
  kind: 'server' | 'skill';
  /** Server name or skill bundle id. */
  name: string;
  /** Skill bundle display name, when known. */
  label?: string;
  reason: ExtensionSkipReason;
  source: 'additional' | 'auto';
}
export interface ExtensionResolutionContext {
  /** The run's repository or repositories (`owner/repo`). */
  repository?: string | readonly string[];
  agentAlias: string;
  runtime: string;
  additional?: { servers?: readonly string[]; skills?: readonly string[] } | null;
  /** Include `autoApply` items; default true. */
  autoApply?: boolean;
  /** When false, write-capability servers are left out. Omitted means not filtered by capability. */
  allowWrite?: boolean;
  /** Per-run limits; default `EXTENSION_LIMITS`. */
  limits?: { servers?: number; bundles?: number };
}
export interface ResolvedExtensionSkill extends ExtensionLibrarySkill { bundle: ExtensionSkillBundle }
export interface ResolvedExtensionSet {
  servers: ExtensionLibraryServer[];
  skills: ResolvedExtensionSkill[];
  /** Explicit entries that were not applied, and auto items whose credential is missing. */
  skipped: ExtensionSkippedItem[];
  /** Applicable items left out by the per-run limits. */
  omitted: ExtensionSkippedItem[];
}
type LibraryView = Pick<ExtensionLibraryRevision, 'servers' | 'skills'> & Partial<Pick<ExtensionLibraryRevision, 'secrets' | 'skillBundles'>>;

const runRepositories = (repository: ExtensionResolutionContext['repository']) => (repository === undefined ? [] : typeof repository === 'string' ? [repository] : [...repository]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Why an item does not apply to a run, or null when it does (ignoring `autoApply` and per-run limits). */
export function extensionItemSkipReason(library: LibraryView, item: ExtensionLibraryServer | ExtensionLibrarySkill, context: Omit<ExtensionResolutionContext, 'additional' | 'limits' | 'autoApply'>): ExtensionSkipReason | null {
  if (!item.enabled) return 'disabled';
  if (!(EXTENSION_RUNTIMES as readonly string[]).includes(context.runtime)) return 'runtime';
  if (item.repositories.length) {
    const repositories = runRepositories(context.repository);
    // Every repository of the run must be within the item's limit.
    if (!repositories.length || repositories.some(r => !item.repositories.some(limit => limit.toLowerCase() === r.toLowerCase()))) return 'repository';
  }
  if (item.agents.length && !item.agents.includes(context.agentAlias)) return 'agent';
  if ('kind' in item) {
    if (context.allowWrite === false && item.capability === 'write') return 'write_not_authorized';
    if (item.kind === 'https' && item.authentication === 'bearer' && library.secrets && !library.secrets[item.name]?.configured) return 'secret_not_configured';
    // Catalog credentials come from the operator environment: callers report their current
    // availability. Without a status the item is not skipped, so identity problems still refuse.
    if (item.kind === 'catalog' && library.secrets?.[item.name]?.configured === false) return 'secret_not_configured';
  } else if (library.skillBundles && !library.skillBundles.some(b => b.id === item.bundleId)) return 'not_found';
  return null;
}

/**
 * The servers and skill bundles that apply to one run, ordered by name:
 * enabled `autoApply` items whose limits match, plus enabled matching items the
 * caller adds explicitly (these ignore `autoApply`). Explicit entries that do
 * not apply are reported in `skipped`; they are never an error. When the set
 * exceeds the per-run limits, explicit items are kept first, then auto items by
 * name, and the rest are returned in `omitted`.
 */
// eslint-disable-next-line complexity -- one deterministic pass shared by servers and skills keeps the precedence rules together
export function resolveExtensionSet(library: LibraryView, context: ExtensionResolutionContext): ResolvedExtensionSet {
  const skipped: ExtensionSkippedItem[] = []; const omitted: ExtensionSkippedItem[] = [];
  const bundles = new Map((library.skillBundles ?? []).map(b => [b.id, b]));
  const label = (id: string) => bundles.get(id)?.name;
  const skillName = (skill: ExtensionLibrarySkill) => bundles.get(skill.bundleId)?.name ?? skill.bundleId;
  const autoApply = context.autoApply !== false;
  const pick = <T extends ExtensionLibraryServer | ExtensionLibrarySkill>(kind: 'server' | 'skill', items: readonly T[], key: (item: T) => string, sortKey: (item: T) => string, wanted: readonly string[], limit: number): T[] => {
    const explicit: T[] = []; const automatic: T[] = [];
    for (const name of [...new Set(wanted)].sort(compare)) {
      const item = items.find(i => key(i) === name);
      const reason = item ? extensionItemSkipReason(library, item, context) : 'not_found';
      if (reason || !item) skipped.push({ kind, name, ...(kind === 'skill' && label(name) ? { label: label(name) } : {}), reason: reason ?? 'not_found', source: 'additional' });
      else explicit.push(item);
    }
    if (autoApply) {
      for (const item of [...items].sort((a, b) => compare(sortKey(a), sortKey(b)) || compare(key(a), key(b)))) {
        if (!item.autoApply || explicit.includes(item)) continue;
        const reason = extensionItemSkipReason(library, item, context);
        if (reason === 'secret_not_configured') skipped.push({ kind, name: key(item), reason, source: 'auto' });
        else if (!reason) automatic.push(item);
      }
    }
    explicit.sort((a, b) => compare(sortKey(a), sortKey(b)) || compare(key(a), key(b)));
    const ordered = [...explicit, ...automatic];
    for (const [index, item] of ordered.entries()) {
      if (index < limit) continue;
      omitted.push({ kind, name: key(item), ...(kind === 'skill' && label(key(item)) ? { label: label(key(item)) } : {}), reason: 'run_limit', source: explicit.includes(item) ? 'additional' : 'auto' });
    }
    return ordered.slice(0, Math.max(0, limit)).sort((a, b) => compare(sortKey(a), sortKey(b)) || compare(key(a), key(b)));
  };
  const servers = pick('server', library.servers, s => s.name, s => s.name, context.additional?.servers ?? [], context.limits?.servers ?? EXTENSION_LIMITS.servers);
  const skills = pick('skill', library.skills, s => s.bundleId, skillName, context.additional?.skills ?? [], context.limits?.bundles ?? EXTENSION_LIMITS.bundles)
    .map(skill => ({ ...skill, bundle: bundles.get(skill.bundleId)! }));
  return { servers, skills, skipped, omitted };
}

/** Machine-readable library contract. */
export const EXTENSION_LIBRARY_CONTRACT = {
  version: EXTENSION_LIBRARY_VERSION, limits: EXTENSION_LIMITS, libraryLimits: EXTENSION_LIBRARY_LIMITS, runtimes: EXTENSION_RUNTIMES,
  transports: ['https', 'catalog'], localStdio: 'operator-installed-catalog-only',
  skills: ['tar', 'tar.gz', 'github-exact-commit'], permission: 'instance.manage_settings',
  itemFields: ['enabled', 'repositories', 'agents', 'autoApply'],
} as const;
