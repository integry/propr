import type { Knex } from 'knex';
import {
  EXTENSION_LIBRARY_LIMITS, EXTENSION_LIBRARY_VERSION, extensionLibraryServerSchema, extensionLibrarySkillSchema,
  type ExtensionLibraryRevision, type ExtensionLibraryServer, type ExtensionLibrarySkill, type ExtensionMcpDescriptor,
  type ExtensionSecretStatus, type ExtensionSkillBundle, type LegacyExtensionProfileRevision,
} from '@propr/shared';
import defaultLogger from '../utils/logger.js';
import { sealExtensionSecrets, unsealExtensionSecrets } from './privateSecrets.js';
import { libraryIdentity } from './extensionProfileStore.js';

/**
 * Startup migration of extension profiles into the extension library.
 * Application-level (secrets are re-sealed with the private trust root),
 * idempotent behind a completion marker, and never aborts startup.
 *
 * - every server and skill of every remaining profile becomes a library item
 *   with the profile's scopes as its limits and `autoApply: false`, so no
 *   run's behaviour changes;
 * - identical servers (kind, url or catalog id and digest, tools, capability,
 *   authentication and credential) merge, with the union of their limits (an
 *   empty source limit keeps the merged limit empty); different servers that
 *   share a name get a deterministic `-2`, `-3`... suffix;
 * - automations that selected a profile add its (possibly renamed) items;
 * - each profile id maps to its item names for queued New Task submissions;
 * - Bearer tokens are re-bound to the library revision; an undecryptable
 *   credential leaves the item without one and logs a warning.
 * Profile tables are left untouched.
 */
export const EXTENSION_LIBRARY_MIGRATION_ACTOR = 'system:extension-profile-migration';
type Log = Pick<typeof defaultLogger, 'info' | 'warn'>;
export interface ExtensionLibraryMigrationReport {
  migrated: boolean; profiles: number; servers: number; skills: number; automations: number;
  renamed: { profileId: string; from: string; to: string }[]; warnings: string[];
}
interface Candidate { server: ExtensionMcpDescriptor; token?: string; status?: ExtensionSecretStatus; enabled: boolean; repositories: string[] | null; agents: string[] | null }

const union = (a: string[] | null, b: string[]) => (a === null || !b.length ? null : [...new Set([...a, ...b])]);
const limit = (value: string[] | null, max: number) => (value ?? []).slice(0, max);
const identity = (server: ExtensionMcpDescriptor, token: string | undefined) => JSON.stringify(server.kind === 'https'
  ? ['https', server.url, [...server.tools].sort(), server.capability, server.authentication, token ?? null]
  : ['catalog', server.catalogId, server.digest, [...server.tools].sort(), server.capability]);
function suffixed(name: string, taken: Set<string>): string {
  for (let n = 2; ; n++) {
    const suffix = `-${n}`; const candidate = name.slice(0, 48 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

async function tablesReady(database: Knex): Promise<boolean> {
  for (const table of ['extension_instance_identity', 'extension_library', 'extension_library_revisions', 'extension_legacy_profile_items', 'extension_library_migration']) {
    if (!await database.schema.hasTable(table)) return false;
  }
  return true;
}

export async function migrateExtensionProfilesToLibrary(database: Knex, environment: NodeJS.ProcessEnv = process.env, log: Log = defaultLogger): Promise<ExtensionLibraryMigrationReport> {
  const report: ExtensionLibraryMigrationReport = { migrated: false, profiles: 0, servers: 0, skills: 0, automations: 0, renamed: [], warnings: [] };
  if (!await tablesReady(database) || await database('extension_library_migration').where({ id: 1 }).first()) return report;
  const instance = await database('extension_instance_identity').where({ id: 1 }).first('instance_id');
  if (!instance) return report;
  const instanceId = instance.instance_id as string;
  try {
    // eslint-disable-next-line complexity -- merging, renaming, custody re-binding and automation mapping share one transaction
    await database.transaction(async trx => {
      // Claim the marker first: a concurrent process's insert conflicts and backs off.
      await trx('extension_library_migration').insert({ id: 1, completed_at: Date.now(), report: '{}' });
      const profiles: LegacyExtensionProfileRevision[] = []; const secretsByProfile = new Map<string, Record<string, string> | null>();
      if (await trx.schema.hasTable('extension_profiles')) {
        const rows = await trx('extension_profiles as p').join('extension_profile_revisions as r', function () { this.on('p.id', 'r.profile_id').andOn('p.revision', 'r.revision'); })
          .where({ 'p.instance_id': instanceId, 'p.deleted': false }).orderBy('p.id').select('r.snapshot', 'r.secrets_encrypted', 'p.enabled');
        for (const row of rows) {
          const snapshot = JSON.parse(row.snapshot) as LegacyExtensionProfileRevision;
          if (snapshot.instanceId !== instanceId) continue;
          snapshot.enabled = snapshot.enabled && Boolean(row.enabled);
          profiles.push(snapshot);
          try { secretsByProfile.set(snapshot.profileId, row.secrets_encrypted === '' ? {} : unsealExtensionSecrets(row.secrets_encrypted, `${snapshot.instanceId}/${snapshot.profileId}/${snapshot.revision}`, environment)); }
          catch {
            secretsByProfile.set(snapshot.profileId, null);
            report.warnings.push(`Credentials of extension profile ${snapshot.profileId} could not be decrypted; its Bearer servers were migrated without a configured secret`);
          }
        }
      }
      report.profiles = profiles.length;
      // Start from the current library, if any, so names never collide with existing items.
      const pointer = await trx('extension_library').where({ instance_id: instanceId }).first('revision');
      const headRow = pointer ? await trx('extension_library_revisions').where({ instance_id: instanceId, revision: pointer.revision }).first() : undefined;
      const head = headRow ? JSON.parse(headRow.snapshot) as ExtensionLibraryRevision : undefined;
      const headSecrets = headRow && headRow.secrets_encrypted !== '' ? unsealExtensionSecrets(headRow.secrets_encrypted, libraryIdentity(instanceId, head!.revision), environment) : {};
      const taken = new Set((head?.servers ?? []).map(s => s.name));
      const candidates = new Map<string, Candidate>(); const byIdentity = new Map<string, string>();
      const skills = new Map<string, { enabled: boolean; repositories: string[] | null; agents: string[] | null }>();
      const mapping = new Map<string, { servers: string[]; skills: string[] }>();
      for (const profile of profiles) {
        const secrets = secretsByProfile.get(profile.profileId);
        const items = { servers: [] as string[], skills: [] as string[] };
        for (const server of [...profile.mcpServers].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
          const token = server.kind === 'https' && server.authentication === 'bearer' ? secrets?.[server.name] : undefined;
          const key = identity(server, token);
          let name = byIdentity.get(key);
          const enabled = profile.enabled && server.enabled;
          if (name) {
            const merged = candidates.get(name)!;
            merged.enabled ||= enabled; merged.repositories = union(merged.repositories, profile.repositoryScope); merged.agents = union(merged.agents, profile.agentScope);
          } else {
            name = taken.has(server.name) ? suffixed(server.name, taken) : server.name;
            if (name !== server.name) {
              report.renamed.push({ profileId: profile.profileId, from: server.name, to: name });
              log.info({ profileId: profile.profileId, from: server.name, to: name }, 'Extension server renamed during library migration');
            }
            taken.add(name); byIdentity.set(key, name);
            candidates.set(name, { server: { ...server, name }, token, status: profile.secrets?.[server.name], enabled, repositories: profile.repositoryScope.length ? [...profile.repositoryScope] : null, agents: profile.agentScope.length ? [...profile.agentScope] : null });
          }
          items.servers.push(name);
        }
        for (const bundleId of profile.skillBundleIds) {
          const current = skills.get(bundleId); const enabled = profile.enabled;
          if (current) { current.enabled ||= enabled; current.repositories = union(current.repositories, profile.repositoryScope); current.agents = union(current.agents, profile.agentScope); }
          else skills.set(bundleId, { enabled, repositories: profile.repositoryScope.length ? [...profile.repositoryScope] : null, agents: profile.agentScope.length ? [...profile.agentScope] : null });
          items.skills.push(bundleId);
        }
        mapping.set(profile.profileId, items);
      }
      const servers: ExtensionLibraryServer[] = [...(head?.servers ?? [])];
      const secrets: Record<string, string> = { ...headSecrets };
      const statuses: Record<string, ExtensionSecretStatus> = { ...(head?.secrets ?? {}) };
      for (const [name, candidate] of candidates) {
        if (servers.length >= EXTENSION_LIBRARY_LIMITS.servers) { report.warnings.push(`Extension server ${name} was not migrated: the library holds at most ${EXTENSION_LIBRARY_LIMITS.servers} servers`); continue; }
        const parsed = extensionLibraryServerSchema.safeParse({ ...candidate.server, enabled: candidate.enabled, repositories: limit(candidate.repositories, EXTENSION_LIBRARY_LIMITS.repositories), agents: limit(candidate.agents, EXTENSION_LIBRARY_LIMITS.agents), autoApply: false });
        if (!parsed.success) { report.warnings.push(`Extension server ${name} was not migrated: invalid stored descriptor`); continue; }
        servers.push(parsed.data);
        if (parsed.data.kind === 'https' && parsed.data.authentication === 'bearer') {
          if (candidate.token) secrets[name] = candidate.token;
          statuses[name] = { fields: ['bearerToken'], configured: Boolean(candidate.token) };
        } else if (parsed.data.kind === 'catalog') {
          const status = candidate.status as { count?: number; fields?: string[]; configured: boolean } | undefined;
          statuses[name] = { count: status?.count ?? status?.fields?.length ?? 0, configured: status?.configured ?? false };
        }
      }
      const bundleRows = skills.size ? await trx('extension_skill_bundles').where({ instance_id: instanceId }).whereIn('id', [...skills.keys()]) : [];
      const descriptors = new Map(bundleRows.map(row => [row.id as string, JSON.parse(row.descriptor) as ExtensionSkillBundle]));
      const librarySkills: ExtensionLibrarySkill[] = [...(head?.skills ?? [])];
      const skillBundles: ExtensionSkillBundle[] = [...(head?.skillBundles ?? [])];
      for (const [bundleId, skill] of skills) {
        if (librarySkills.some(s => s.bundleId === bundleId)) continue;
        if (!descriptors.has(bundleId)) { report.warnings.push(`Skill bundle ${bundleId} was not migrated: bundle unavailable`); continue; }
        if (librarySkills.length >= EXTENSION_LIBRARY_LIMITS.bundles) { report.warnings.push(`Skill bundle ${bundleId} was not migrated: the library holds at most ${EXTENSION_LIBRARY_LIMITS.bundles} skill bundles`); continue; }
        librarySkills.push(extensionLibrarySkillSchema.parse({ bundleId, enabled: skill.enabled, repositories: limit(skill.repositories, EXTENSION_LIBRARY_LIMITS.repositories), agents: limit(skill.agents, EXTENSION_LIBRARY_LIMITS.agents), autoApply: false }));
        skillBundles.push(descriptors.get(bundleId)!);
      }
      const keptServers = new Set(servers.map(s => s.name)); const keptSkills = new Set(librarySkills.map(s => s.bundleId));
      report.servers = servers.length - (head?.servers.length ?? 0); report.skills = librarySkills.length - (head?.skills.length ?? 0);
      if (report.servers || report.skills) {
        const revision = (head?.revision ?? 0) + 1; const now = Date.now();
        const snapshot: ExtensionLibraryRevision = {
          version: EXTENSION_LIBRARY_VERSION, instanceId, revision, createdAt: head?.createdAt ?? now, updatedAt: now, auditActor: EXTENSION_LIBRARY_MIGRATION_ACTOR,
          servers, skills: librarySkills, secrets: statuses, skillBundles,
        };
        const sealed = Object.fromEntries(Object.entries(secrets).filter(([name, token]) => token && keptServers.has(name)));
        if (head) {
          if (!await trx('extension_library').where({ instance_id: instanceId, revision: head.revision }).update({ revision })) throw new Error('Extension library changed during migration');
        } else await trx('extension_library').insert({ instance_id: instanceId, revision });
        await trx('extension_library_revisions').insert({ instance_id: instanceId, revision, snapshot: JSON.stringify(snapshot), secrets_encrypted: sealExtensionSecrets(sealed, libraryIdentity(instanceId, revision), environment) });
      }
      for (const [profileId, items] of mapping) {
        const kept = { servers: items.servers.filter(n => keptServers.has(n)), skills: items.skills.filter(id => keptSkills.has(id)) };
        mapping.set(profileId, kept);
        await trx('extension_legacy_profile_items').insert({ profile_id: profileId, servers: JSON.stringify(kept.servers), skills: JSON.stringify(kept.skills) }).onConflict('profile_id').ignore();
      }
      if (await trx.schema.hasTable('agent_definitions') && await trx.schema.hasColumn('agent_definitions', 'extension_profile') && await trx.schema.hasColumn('agent_definitions', 'extensions')) {
        const automations = await trx('agent_definitions').whereNotNull('extension_profile').whereNull('extensions').select('id', 'extension_profile');
        for (const automation of automations) {
          let profileId: string | undefined; try { profileId = JSON.parse(automation.extension_profile)?.profileId; } catch { /* unreadable selection */ }
          const items = profileId ? mapping.get(profileId) : undefined;
          if (!items) report.warnings.push(`Automation ${automation.id} selected an unavailable extension profile; it now adds no extensions`);
          await trx('agent_definitions').where({ id: automation.id }).update({ extensions: JSON.stringify(items ?? { servers: [], skills: [] }) });
          report.automations += 1;
        }
      }
      report.migrated = true;
      await trx('extension_library_migration').where({ id: 1 }).update({ completed_at: Date.now(), report: JSON.stringify(report) });
    });
  } catch (error) {
    // Another process completed it, or the migration failed: either way startup continues and old tables stay readable.
    if (await database('extension_library_migration').where({ id: 1 }).first().catch(() => undefined)) return { ...report, migrated: false, warnings: [] };
    log.warn({ err: error instanceof Error ? error.message : 'unknown' }, 'Extension library migration did not complete; profile tables are unchanged and it will retry at the next start');
    return { ...report, migrated: false };
  }
  for (const warning of report.warnings) log.warn(warning);
  if (report.profiles || report.automations) log.info({ profiles: report.profiles, servers: report.servers, skills: report.skills, automations: report.automations, renamed: report.renamed.length }, 'Extension profiles migrated to the extension library');
  return report;
}
