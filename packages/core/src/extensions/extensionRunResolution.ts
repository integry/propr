import { extensionLabelOptOut, type ExtensionSkippedItem, type ResolvedExtensionSet } from '@propr/shared';
import type { AgentExtensionRequest } from '../agents/types.js';

/** Why a run launched without its auto-applied library items. */
export type ExtensionAutoApplySkip = 'codex_operator_config' | 'codex_workspace_config';
export const EXTENSION_AUTO_APPLY_SKIP_MESSAGES: Record<ExtensionAutoApplySkip, string> = {
  codex_operator_config: 'The Codex operator configuration (CODEX_HOME/config.toml) defines a custom model provider or profile, which a Codex run with extensions ignores',
  codex_workspace_config: 'The workspace contains .codex/config.toml, which a Codex run with extensions refuses',
};

export interface ExtensionLabelOptOutRecord {
  labels: string[];
  /** Library items the labels removed from this run. */
  removed: { servers: string[]; skills: string[] };
}
export interface ExtensionRunNotes {
  labelOptOut?: ExtensionLabelOptOutRecord;
  autoApplySkipped?: { reason: ExtensionAutoApplySkip; message: string };
}

/** Issue tasks and pull request follow-ups honour the opt-out labels; automation runs do not. */
export const honoursOptOutLabels = (request: AgentExtensionRequest) => request.kind === 'issue' || request.kind === 'pull_request';

/**
 * The resolved set without the classes the run's labels opt out of. Skipped
 * and omitted entries of a removed class are dropped too: that class does not
 * apply to the run at all. Labels only remove; they never add.
 */
export function applyLabelOptOut(set: ResolvedExtensionSet, request: AgentExtensionRequest): { set: ResolvedExtensionSet; record?: ExtensionLabelOptOutRecord } {
  if (!honoursOptOutLabels(request)) return { set };
  const optOut = extensionLabelOptOut(request.labels);
  if (!optOut.servers && !optOut.skills) return { set };
  const keep = (item: ExtensionSkippedItem) => !(item.kind === 'server' ? optOut.servers : optOut.skills);
  return {
    set: {
      servers: optOut.servers ? [] : set.servers,
      skills: optOut.skills ? [] : set.skills,
      skipped: set.skipped.filter(keep),
      omitted: set.omitted.filter(keep),
    },
    record: {
      labels: optOut.labels,
      removed: { servers: optOut.servers ? set.servers.map(s => s.name) : [], skills: optOut.skills ? set.skills.map(s => s.bundle.name) : [] },
    },
  };
}

/** Applied items split by how they reached the run: added explicitly, or applied automatically. */
export function appliedBySource(set: ResolvedExtensionSet, request: AgentExtensionRequest) {
  const addedServers = new Set(request.servers); const addedSkills = new Set(request.skills);
  return {
    added: { servers: set.servers.filter(s => addedServers.has(s.name)).map(s => s.name), skills: set.skills.filter(s => addedSkills.has(s.bundleId)).map(s => s.bundle.name) },
    autoApplied: { servers: set.servers.filter(s => !addedServers.has(s.name)).map(s => s.name), skills: set.skills.filter(s => !addedSkills.has(s.bundleId)).map(s => s.bundle.name) },
  };
}

export const hasAutoAppliedItems = (set: ResolvedExtensionSet, request: AgentExtensionRequest) => {
  const { autoApplied } = appliedBySource(set, request);
  return autoApplied.servers.length + autoApplied.skills.length > 0;
};

/**
 * The `extensions.resolved` task event: names, revision, provenance and
 * reasons only. Never URLs, credentials, tool output or file contents.
 */
export function extensionResolutionEvent(snapshot: { revision: number; auditActor: string }, set: ResolvedExtensionSet, request: AgentExtensionRequest, notes: ExtensionRunNotes = {}) {
  const { added, autoApplied } = appliedBySource(set, request);
  const anyAdded = added.servers.length + added.skills.length > 0;
  const anyAuto = autoApplied.servers.length + autoApplied.skills.length > 0;
  // Package servers by name with their pinned version; never variables or secrets.
  const packages = set.servers.flatMap(s => (s.kind === 'package' ? [{ name: s.name, ecosystem: s.ecosystem, package: s.package, version: s.version }] : []));
  return {
    event: 'extensions.resolved' as const,
    libraryRevision: snapshot.revision,
    runKind: request.kind ?? 'automation',
    // The authority is the library revision; its audit actor is provenance only.
    provenance: { source: anyAdded ? (anyAuto ? 'mixed' as const : 'additional' as const) : 'auto' as const, auditActor: snapshot.auditActor || null },
    servers: set.servers.map(s => s.name),
    skills: set.skills.map(s => ({ id: s.bundleId, name: s.bundle.name })),
    autoApplied,
    added,
    skipped: set.skipped,
    omitted: set.omitted,
    ...(packages.length ? { packages } : {}),
    ...(notes.labelOptOut ? { labelOptOut: notes.labelOptOut } : {}),
    ...(notes.autoApplySkipped ? { autoApplySkipped: notes.autoApplySkipped } : {}),
  };
}
export type ExtensionResolutionEvent = ReturnType<typeof extensionResolutionEvent>;

/** One-line reason for the task timeline. */
export function extensionResolutionReason(event: ExtensionResolutionEvent): string {
  if (event.autoApplySkipped) return 'Extensions resolved; auto-applied items were skipped for this Codex run';
  if (event.labelOptOut) return `Extensions resolved; ${event.labelOptOut.labels.join(', ')} removed items`;
  return event.skipped.length || event.omitted.length ? 'Extensions resolved; some items were skipped' : 'Extensions resolved';
}

/** Issue task and follow-up extension requests are built in shared code, so worker modules need no extra Core import. */
export { taskRunExtensionRequest } from '@propr/shared';
