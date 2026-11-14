import { z } from 'zod';
import { EXTENSION_OAUTH_REGISTRATIONS, type ExtensionOAuthConnectionState } from './extensionOAuth.js';
import {
  EXTENSION_LIMITS, EXTENSION_PROFILE_VERSION, catalogMcpSchema, extensionAgentAliasSchema, extensionRepositorySchema,
  extensionServerNameSchema, remoteMcpSchema, type ExtensionSecretStatus, type ExtensionSkillBundle,
} from './extensionProfiles.js';
import { EXTENSION_PACKAGE_ECOSYSTEMS, extensionPackageEnvConflict, packageServerFields, type ExtensionSecretAcknowledgement } from './extensionPackages.js';

/**
 * The instance extension library: one list of MCP servers and skill bundle
 * references. Each item carries its own limits (repositories, agents), an
 * `enabled` switch and `autoApply`. Automations add items explicitly on top.
 */
export const EXTENSION_LIBRARY_VERSION = EXTENSION_PROFILE_VERSION;
export const EXTENSION_LIBRARY_LIMITS = { servers: 32, bundles: 32, repositories: 64, agents: 64 } as const;
export const EXTENSION_RUNTIMES = ['claude', 'codex'] as const;

/** Plugin ids, as `pluginIdSchema` in plugins.ts (kept here to avoid an import cycle). */
const managingPluginSchema = z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
/**
 * Marks a library item contributed by an installed plugin. Its definition
 * comes from the plugin manifest and is read-only; only `enabled`, the limits
 * and `autoApply` can be changed. `item` is the name the manifest gives the
 * server or skill (the library name may carry the plugin id as a prefix after
 * a name collision). `active` is false while the plugin is disabled or a
 * required acknowledgement is pending: the item then never applies.
 * `registrations` (OAuth servers only) are the client registration methods
 * the plugin's connection permits, in the order sign-in tries them; sign-in
 * uses no other method.
 */
export const extensionManagedBySchema = z.strictObject({
  plugin: managingPluginSchema, item: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/), active: z.boolean(),
  registrations: z.array(z.enum(EXTENSION_OAUTH_REGISTRATIONS)).min(1).max(EXTENSION_OAUTH_REGISTRATIONS.length).optional(),
});
export type ExtensionManagedBy = z.infer<typeof extensionManagedBySchema>;
/** Fields of a managed item an administrator may change through the library. */
export const EXTENSION_MANAGED_EDITABLE_FIELDS = ['enabled', 'repositories', 'agents', 'autoApply'] as const;

const itemLimits = {
  /** Empty means every repository. */
  repositories: z.array(extensionRepositorySchema).max(EXTENSION_LIBRARY_LIMITS.repositories).default([]),
  /** Empty means every agent. */
  agents: z.array(extensionAgentAliasSchema).max(EXTENSION_LIBRARY_LIMITS.agents).default([]),
  /** When false the item applies only where it is added explicitly. */
  autoApply: z.boolean().default(true),
  /** Set only by ProPR for items a plugin contributes. */
  managedBy: extensionManagedBySchema.optional(),
};
export const libraryRemoteServerSchema = remoteMcpSchema.extend(itemLimits);
export const libraryCatalogServerSchema = catalogMcpSchema.extend(itemLimits);
/** A local server from a pinned npm package, run through the stdio bridge in the task container. */
export const libraryPackageServerSchema = z.strictObject({
  name: extensionServerNameSchema, enabled: z.boolean(), tools: remoteMcpSchema.shape.tools, capability: z.enum(['read', 'write']),
  ...packageServerFields, ...itemLimits,
});
export const extensionLibraryServerSchema = z.discriminatedUnion('kind', [libraryRemoteServerSchema, libraryCatalogServerSchema, libraryPackageServerSchema]);
export type ExtensionLibraryPackageServer = z.infer<typeof libraryPackageServerSchema>;
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
  if (v.servers.some(s => s.kind === 'https' && s.authentication !== 'oauth' && (s.scopes !== undefined || s.clientId !== undefined))) ctx.addIssue({ code: 'custom', message: 'Scopes and client id apply to OAuth servers only' });
  for (const s of v.servers) {
    const conflict = s.kind === 'package' ? extensionPackageEnvConflict(s) : null;
    if (conflict) ctx.addIssue({ code: 'custom', message: `Variable ${conflict} is listed more than once` });
  }
});
export type ExtensionLibraryInput = z.input<typeof extensionLibraryInputSchema>;
export type ExtensionLibraryItems = z.infer<typeof extensionLibraryInputSchema>;

/** One immutable library revision. Revision 0 is the empty library before the first save. */
export interface ExtensionLibraryRevision extends ExtensionLibraryItems {
  instanceId: string; revision: number;
  createdAt: number; updatedAt: number; auditActor: string;
  secrets: Record<string, ExtensionSecretStatus>;
  skillBundles: ExtensionSkillBundle[];
  /**
   * Package servers with secret variables, keyed by server name: who
   * acknowledged that those values are readable inside the task container.
   */
  acknowledgements?: Record<string, ExtensionSecretAcknowledgement>;
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

export type ExtensionSkipReason = 'not_found' | 'disabled' | 'runtime' | 'repository' | 'agent' | 'write_not_authorized' | 'secret_not_configured' | 'oauth_not_connected' | 'oauth_needs_sign_in' | 'run_limit' | 'package_unavailable' | 'package_integrity_mismatch';
/** Skip reasons of an item whose credential is missing: reported for auto-applied items too. */
const CREDENTIAL_SKIP_REASONS: readonly ExtensionSkipReason[] = ['secret_not_configured', 'oauth_not_connected', 'oauth_needs_sign_in'];
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
type LibraryView = Pick<ExtensionLibraryRevision, 'servers' | 'skills'> & Partial<Pick<ExtensionLibraryRevision, 'secrets' | 'skillBundles'>> & {
  /**
   * Connection state of OAuth servers, credential state that is not part of a
   * revision. When present, an OAuth server without a usable connection is skipped.
   */
  oauth?: Record<string, ExtensionOAuthConnectionState>;
};

const runRepositories = (repository: ExtensionResolutionContext['repository']) => (repository === undefined ? [] : typeof repository === 'string' ? [repository] : [...repository]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Why an item does not apply to a run, or null when it does (ignoring `autoApply` and per-run limits). */
export function extensionItemSkipReason(library: LibraryView, item: ExtensionLibraryServer | ExtensionLibrarySkill, context: Omit<ExtensionResolutionContext, 'additional' | 'limits' | 'autoApply'>): ExtensionSkipReason | null {
  // A managed item of a disabled plugin, or one awaiting an acknowledgement, never applies.
  if (!item.enabled || item.managedBy?.active === false) return 'disabled';
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
    if (item.kind === 'https' && item.authentication === 'oauth' && library.oauth) {
      const state = Object.hasOwn(library.oauth, item.name) ? library.oauth[item.name] : 'not_connected';
      if (state !== 'connected') return state === 'needs_sign_in' ? 'oauth_needs_sign_in' : 'oauth_not_connected';
    }
    // Catalog credentials come from the operator environment: callers report their current
    // availability. Without a status the item is not skipped, so identity problems still refuse.
    if (item.kind === 'catalog' && library.secrets?.[item.name]?.configured === false) return 'secret_not_configured';
    if (item.kind === 'package' && item.secretEnv.length && library.secrets && !library.secrets[item.name]?.configured) return 'secret_not_configured';
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
        if (reason && CREDENTIAL_SKIP_REASONS.includes(reason)) skipped.push({ kind, name: key(item), reason, source: 'auto' });
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

/**
 * Labels on an issue (issue tasks) or pull request (follow-ups) that remove
 * auto-applied library items from that run. They only remove, never add, and
 * do not affect automation runs.
 */
export const EXTENSION_OPT_OUT_LABELS = { mcps: 'disable-mcps', skills: 'disable-skills', all: 'disable-extensions' } as const;
export interface ExtensionLabelOptOut {
  /** No MCP servers from the library. */
  servers: boolean;
  /** No skill bundles from the library. */
  skills: boolean;
  /** The opt-out labels present, in a stable order. */
  labels: string[];
}
/** The opt-out of a run from its issue or pull request labels (names or GitHub label objects). */
export function extensionLabelOptOut(labels: readonly (string | { name?: string | null } | null | undefined)[] | null | undefined): ExtensionLabelOptOut {
  const names = new Set((labels ?? []).map(label => (typeof label === 'string' ? label : label?.name ?? '').trim().toLowerCase()).filter(Boolean));
  const present = Object.values(EXTENSION_OPT_OUT_LABELS).filter(label => names.has(label));
  const all = names.has(EXTENSION_OPT_OUT_LABELS.all);
  return { servers: all || names.has(EXTENSION_OPT_OUT_LABELS.mcps), skills: all || names.has(EXTENSION_OPT_OUT_LABELS.skills), labels: present };
}

/** The extension request of an issue task or pull request follow-up (structurally Core's `AgentExtensionRequest`). */
export interface TaskRunExtensionRequest {
  autoApply: boolean; servers: string[]; skills: string[]; repositories?: string[]; allowWrite?: boolean;
  kind?: 'automation' | 'issue' | 'pull_request'; labels?: string[];
}
type LabelInput = string | { name?: string | null } | null | undefined;
/**
 * The extension request of an issue task or pull request follow-up: the
 * library items that apply automatically, resolved at launch, with the run's
 * labels for opt-outs. Write servers need the explicit `allowWrite` of a New
 * Task submission's initial task; every other run gets read servers only.
 * A legacy submission request (`base`) keeps its explicit items.
 */
export function taskRunExtensionRequest(input: { kind: 'issue' | 'pull_request'; repository: string; labels?: readonly LabelInput[] | null; allowWrite?: boolean; base?: TaskRunExtensionRequest }): TaskRunExtensionRequest {
  const labels = (input.labels ?? []).map(label => (typeof label === 'string' ? label : label?.name ?? '')).filter(Boolean);
  const base = input.base ?? { autoApply: true, servers: [], skills: [] };
  return { ...base, repositories: base.repositories ?? [input.repository], allowWrite: base.allowWrite === true || input.allowWrite === true, kind: input.kind, labels };
}

/** Machine-readable library contract. */
export const EXTENSION_LIBRARY_CONTRACT = {
  version: EXTENSION_LIBRARY_VERSION, limits: EXTENSION_LIMITS, libraryLimits: EXTENSION_LIBRARY_LIMITS, runtimes: EXTENSION_RUNTIMES,
  transports: ['https', 'catalog', 'package'], authentication: ['none', 'bearer', 'oauth'], localStdio: 'operator-catalog-or-pinned-package',
  packageEcosystems: EXTENSION_PACKAGE_ECOSYSTEMS,
  skills: ['tar', 'tar.gz', 'github-exact-commit'], permission: 'instance.manage_settings',
  itemFields: ['enabled', 'repositories', 'agents', 'autoApply'],
  managedItemFields: EXTENSION_MANAGED_EDITABLE_FIELDS,
  optOutLabels: EXTENSION_OPT_OUT_LABELS,
} as const;

/**
 * Where library items are used, for the settings screen: the automations that
 * add items explicitly, and the profiles that migrated items came from.
 */
export interface ExtensionLibraryUsage {
  automations: { id: string; name: string; servers: string[]; skills: string[] }[];
  /** Profile names keyed by server name and by skill bundle id. */
  importedFrom: { servers: Record<string, string[]>; skills: Record<string, string[]> };
}
