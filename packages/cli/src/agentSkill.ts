import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_SKILL_TARGETS = ["codex", "claude", "antigravity", "opencode", "vibe"] as const;
export type AgentSkillTarget = (typeof AGENT_SKILL_TARGETS)[number];

const AGENT_SKILL_EXECUTABLES: Record<AgentSkillTarget, string> = {
  codex: "codex",
  claude: "claude",
  antigravity: "agy",
  opencode: "opencode",
  vibe: "vibe",
};

const MANAGED_FILE = ".propr-managed.json";
const MANAGER = "propr-cli";
const MANAGED_SCHEMA = 1;

export interface AgentSkillLocation {
  target: AgentSkillTarget;
  toolHome: string;
  path: string;
}

export type AgentSkillState =
  | "absent"
  | "current-managed"
  | "current-unmanaged"
  | "outdated-managed"
  | "modified-managed"
  | "foreign"
  | "unsafe";

export interface AgentSkillStatus extends AgentSkillLocation {
  state: AgentSkillState;
  bundledIdentity: string;
  installedIdentity?: string;
  detail?: string;
}

export interface AgentSkillOperationResult extends AgentSkillStatus {
  action: "installed" | "adopted" | "unchanged" | "updated" | "backed-up" | "removed" | "refused" | "failed";
  backupPath?: string;
}

interface ManagedMarker {
  manager: typeof MANAGER;
  schema: typeof MANAGED_SCHEMA;
  contentSha256: string;
}

interface Bundle {
  sourceDir: string;
  identity: string;
  entries: TreeEntry[];
}

interface TreeEntry {
  kind: "directory" | "file";
  path: string;
  content?: Buffer;
}

export interface AgentSkillEnvironment {
  HOME?: string;
  CODEX_HOME?: string;
  XDG_CONFIG_HOME?: string;
  SUDO_USER?: string;
  SUDO_UID?: string;
  [key: string]: string | undefined;
}

export interface AgentSkillOptions {
  env?: AgentSkillEnvironment;
  bundleDir?: string;
  force?: boolean;
  now?: Date;
}

function environmentValue(
  env: AgentSkillEnvironment,
  key: "HOME" | "CODEX_HOME" | "XDG_CONFIG_HOME",
  fallback?: string
): string {
  if (Object.prototype.hasOwnProperty.call(env, key)) {
    const value = env[key];
    if (!value?.trim()) throw new Error(`${key} is empty`);
    return value;
  }
  if (fallback) return fallback;
  throw new Error(`${key} is not set`);
}

function assertSafeBase(
  raw: string,
  label: string,
  options: { directRoot: boolean; allowRootBase?: boolean }
): string {
  if (raw.includes("\0") || raw.split(/[\\/]+/).includes("..")) {
    throw new Error(`${label} contains traversal or invalid characters`);
  }
  if (!isAbsolute(raw)) throw new Error(`${label} must be an absolute path`);
  const base = normalize(raw);
  if (base === sep) throw new Error(`${label} resolves to a broad root path`);
  const rootOwned = base === "/root" || base.startsWith(`/root${sep}`);
  const allowedDirectRoot = options.directRoot && (base !== "/root" || options.allowRootBase === true);
  if (rootOwned && !allowedDirectRoot) {
    throw new Error(`${label} resolves to a root-owned or root-like path`);
  }
  return base;
}

function assertNotSudo(env: AgentSkillEnvironment): void {
  if (env.SUDO_USER?.trim() || env.SUDO_UID?.trim()) {
    throw new Error("agent skills must be managed as the current user, not through sudo");
  }
}

export function parseAgentSkillTargets(values: readonly string[]): AgentSkillTarget[] {
  const requested = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (requested.length === 0) throw new Error(`choose at least one target: ${AGENT_SKILL_TARGETS.join(", ")}`);
  const valid = new Set<string>(AGENT_SKILL_TARGETS);
  const unknown = requested.filter((value) => value !== "all" && !valid.has(value));
  if (unknown.length > 0) {
    throw new Error(`unknown agent skill target(s): ${unknown.join(", ")} (choose ${AGENT_SKILL_TARGETS.join(", ")})`);
  }
  if (requested.includes("all")) return [...AGENT_SKILL_TARGETS];
  return [...new Set(requested)] as AgentSkillTarget[];
}

export function resolveAgentSkillLocation(
  target: AgentSkillTarget,
  env: AgentSkillEnvironment = process.env
): AgentSkillLocation {
  assertNotSudo(env);
  const directRoot = process.geteuid?.() === 0;
  const home = assertSafeBase(environmentValue(env, "HOME"), "HOME", { directRoot, allowRootBase: true });
  let toolHome: string;
  switch (target) {
    case "codex":
      toolHome = assertSafeBase(environmentValue(env, "CODEX_HOME", join(home, ".codex")), "CODEX_HOME", { directRoot });
      break;
    case "claude":
      toolHome = join(home, ".claude");
      break;
    case "antigravity":
      toolHome = join(home, ".gemini", "antigravity-cli");
      break;
    case "opencode": {
      const xdg = assertSafeBase(environmentValue(env, "XDG_CONFIG_HOME", join(home, ".config")), "XDG_CONFIG_HOME", { directRoot });
      toolHome = join(xdg, "opencode");
      break;
    }
    case "vibe":
      toolHome = join(home, ".vibe");
      break;
  }
  const path = resolve(toolHome, "skills", "propr");
  const rel = relative(toolHome, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`unsafe ${target} skill target`);
  return { target, toolHome, path };
}

export function resolveAgentSkillLocations(
  targets: readonly AgentSkillTarget[] = AGENT_SKILL_TARGETS,
  env: AgentSkillEnvironment = process.env
): AgentSkillLocation[] {
  return targets.map((target) => resolveAgentSkillLocation(target, env));
}

function executableOnPath(name: string, env: AgentSkillEnvironment): boolean {
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Continue through PATH.
    }
  }
  return false;
}

/** Detect installed/configured tools without inspecting provider credentials. */
export function detectConfiguredAgentSkillTargets(
  env: AgentSkillEnvironment = process.env
): AgentSkillLocation[] {
  return AGENT_SKILL_TARGETS.flatMap((target) => {
    let location: AgentSkillLocation;
    try {
      location = resolveAgentSkillLocation(target, env);
    } catch {
      // Provider-specific configuration errors must not suppress valid tools.
      return [];
    }
    try {
      if (statSync(location.toolHome).isDirectory()) return [location];
    } catch {
      // An installed executable still counts even when it has no config yet.
    }
    return executableOnPath(AGENT_SKILL_EXECUTABLES[target], env) ? [location] : [];
  });
}

function bundledSkillDirectory(override?: string): string {
  if (override) return override;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(moduleDir, "skill", "propr"), join(moduleDir, "..", "skill", "propr")];
  const found = candidates.find((candidate) => existsSync(join(candidate, "SKILL.md")));
  if (!found) throw new Error("bundled ProPR skill is missing; reinstall propr-cli");
  return found;
}

function readTree(root: string, excludeManaged = false): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (excludeManaged && rel === MANAGED_FILE) continue;
      const full = join(directory, item.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed in a managed skill: ${rel}`);
      if (stat.isDirectory()) {
        entries.push({ kind: "directory", path: rel });
        visit(full, rel);
      } else if (stat.isFile()) {
        entries.push({ kind: "file", path: rel, content: readFileSync(full) });
      } else {
        throw new Error(`unsupported filesystem entry in skill: ${rel}`);
      }
    }
  };
  visit(root, "");
  return entries;
}

function contentIdentity(entries: readonly TreeEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.kind === "directory" ? "D\0" : "F\0");
    hash.update(entry.path);
    hash.update("\0");
    if (entry.content) hash.update(entry.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function loadBundle(override?: string): Bundle {
  const sourceDir = bundledSkillDirectory(override);
  const entries = readTree(sourceDir);
  const paths = new Set(entries.map((entry) => entry.path));
  if (!paths.has("SKILL.md") || !paths.has("agents") || !paths.has("agents/openai.yaml")) {
    throw new Error("bundled ProPR skill is incomplete");
  }
  return { sourceDir, entries, identity: contentIdentity(entries) };
}

function assertSafeFilesystemTarget(location: AgentSkillLocation): void {
  const { toolHome, path } = location;
  let walked: string = sep;
  for (const component of resolve(toolHome).split(sep).filter(Boolean)) {
    walked = join(walked, component);
    if (!existsSync(walked)) continue;
    const stat = lstatSync(walked);
    if (stat.isSymbolicLink()) throw new Error(`symbolic link parent is not allowed: ${walked}`);
    if (!stat.isDirectory()) throw new Error(`parent is not a directory: ${walked}`);
  }
  let ancestor = toolHome;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`no directory parent exists for ${toolHome}`);
    ancestor = parent;
  }
  if (!statSync(ancestor).isDirectory()) throw new Error(`parent is not a directory: ${ancestor}`);

  let current = toolHome;
  const suffix = relative(toolHome, path).split(sep).filter(Boolean);
  for (const part of ["", ...suffix]) {
    if (part) current = join(current, part);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`symbolic link target is not allowed: ${current}`);
    if (current !== path && !stat.isDirectory()) throw new Error(`parent is not a directory: ${current}`);
  }
}

function readMarker(path: string): ManagedMarker | undefined {
  try {
    const markerPath = join(path, MANAGED_FILE);
    const markerStat = lstatSync(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) return undefined;
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<ManagedMarker>;
    if (
      parsed.manager === MANAGER &&
      parsed.schema === MANAGED_SCHEMA &&
      typeof parsed.contentSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(parsed.contentSha256)
    ) {
      return parsed as ManagedMarker;
    }
  } catch {
    // A missing or malformed marker is foreign content, not a fatal read error.
  }
  return undefined;
}

function inspectLocation(location: AgentSkillLocation, bundle: Bundle): AgentSkillStatus {
  try {
    assertSafeFilesystemTarget(location);
    if (!existsSync(location.path)) return { ...location, state: "absent", bundledIdentity: bundle.identity };
    const targetStat = lstatSync(location.path);
    if (targetStat.isSymbolicLink()) throw new Error(`symbolic link target is not allowed: ${location.path}`);
    if (!targetStat.isDirectory()) {
      return { ...location, state: "foreign", bundledIdentity: bundle.identity, detail: "target is not a directory" };
    }
    const marker = readMarker(location.path);
    // Exclude the management file only when it is a valid ProPR marker. A
    // malformed lookalike is foreign content and must affect the identity.
    const installedIdentity = contentIdentity(readTree(location.path, Boolean(marker)));
    if (marker) {
      if (marker.contentSha256 !== installedIdentity) {
        return { ...location, state: "modified-managed", bundledIdentity: bundle.identity, installedIdentity };
      }
      return {
        ...location,
        state: installedIdentity === bundle.identity ? "current-managed" : "outdated-managed",
        bundledIdentity: bundle.identity,
        installedIdentity,
      };
    }
    return {
      ...location,
      state: installedIdentity === bundle.identity ? "current-unmanaged" : "foreign",
      bundledIdentity: bundle.identity,
      installedIdentity,
    };
  } catch (error) {
    return { ...location, state: "unsafe", bundledIdentity: bundle.identity, detail: (error as Error).message };
  }
}

function unresolvedTargetStatus(target: AgentSkillTarget, bundle: Bundle, error: unknown): AgentSkillStatus {
  return {
    target,
    toolHome: "<unresolved>",
    path: "<unresolved>",
    state: "unsafe",
    bundledIdentity: bundle.identity,
    detail: (error as Error).message,
  };
}

export function inspectAgentSkills(
  targets: readonly AgentSkillTarget[] = AGENT_SKILL_TARGETS,
  options: AgentSkillOptions = {}
): AgentSkillStatus[] {
  const bundle = loadBundle(options.bundleDir);
  const env = options.env ?? process.env;
  return targets.map((target) => {
    try {
      return inspectLocation(resolveAgentSkillLocation(target, env), bundle);
    } catch (error) {
      return unresolvedTargetStatus(target, bundle, error);
    }
  });
}

function writeBundleContents(directory: string, bundle: Bundle): void {
  for (const entry of bundle.entries) {
    const output = join(directory, ...entry.path.split("/"));
    if (entry.kind === "directory") {
      mkdirSync(output, { mode: 0o700 });
    } else {
      writeFileSync(output, entry.content!, { mode: 0o600, flag: "wx" });
    }
  }
  writeFileSync(join(directory, MANAGED_FILE), managedMarkerContent(bundle.identity), { mode: 0o600, flag: "wx" });
}

function writeBundle(directory: string, bundle: Bundle): void {
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  writeBundleContents(directory, bundle);
}

/** Publish a staged bundle into a directory claimed by this process without replacing any entry. */
function publishBundleExclusively(directory: string, staged: string, bundle: Bundle): void {
  for (const entry of bundle.entries) {
    const output = join(directory, ...entry.path.split("/"));
    if (entry.kind === "directory") {
      mkdirSync(output, { mode: 0o700 });
    } else {
      linkSync(join(staged, ...entry.path.split("/")), output);
      chmodSync(output, 0o600);
    }
  }
  linkSync(join(staged, MANAGED_FILE), join(directory, MANAGED_FILE));
  chmodSync(join(directory, MANAGED_FILE), 0o600);
}

function managedMarkerContent(identity: string): string {
  const marker: ManagedMarker = { manager: MANAGER, schema: MANAGED_SCHEMA, contentSha256: identity };
  return `${JSON.stringify(marker, null, 2)}\n`;
}

/** Add a fully-written marker without ever replacing a concurrently-created file. */
function writeManagedMarkerAtomically(directory: string, identity: string): void {
  const markerPath = join(directory, MANAGED_FILE);
  const temporary = join(directory, `.propr.marker-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temporary, managedMarkerContent(identity), { mode: 0o600, flag: "wx" });
    linkSync(temporary, markerPath);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary path may not have been created.
    }
  }
}

function uniqueSibling(path: string, label: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const candidate = join(dirname(path), `.propr.${label}-${stamp}${suffix}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not allocate ${label} path beside ${path}`);
}

function operationFailure(status: AgentSkillStatus, action: "refused" | "failed", detail: string): AgentSkillOperationResult {
  return { ...status, action, detail };
}

function sameInspectedTree(expected: AgentSkillStatus, actual: AgentSkillStatus): boolean {
  return expected.state === actual.state && expected.installedIdentity === actual.installedIdentity;
}

function inspectMovedTree(location: AgentSkillLocation, path: string, bundle: Bundle): AgentSkillStatus {
  return inspectLocation({ ...location, path }, bundle);
}

function preservedFailure(
  status: AgentSkillStatus,
  detail: string,
  preservedPath?: string
): AgentSkillOperationResult {
  return {
    ...status,
    action: "failed",
    backupPath: preservedPath,
    detail: preservedPath ? `${detail}; content preserved at ${preservedPath}` : detail,
  };
}

function installAgentSkillWithoutOverwrite(
  status: AgentSkillStatus,
  location: AgentSkillLocation,
  bundle: Bundle,
  options: AgentSkillOptions
): AgentSkillOperationResult {
  const parent = dirname(location.path);
  let staged: string | undefined;
  let stagedOwned = false;
  let displaced: string | undefined;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertSafeFilesystemTarget(location);
    const refreshed = inspectLocation(location, bundle);
    if (!sameInspectedTree(status, refreshed)) {
      return operationFailure(refreshed, "failed", "target changed during installation; inspect it and retry");
    }

    staged = uniqueSibling(location.path, "installing", options.now);
    mkdirSync(staged, { recursive: false, mode: 0o700 });
    stagedOwned = true;
    writeBundleContents(staged, bundle);

    if (refreshed.state === "outdated-managed") {
      displaced = uniqueSibling(location.path, "replaced", options.now);
      renameSync(location.path, displaced);
      const moved = inspectMovedTree(location, displaced, bundle);
      if (!sameInspectedTree(refreshed, moved)) {
        return preservedFailure(status, "target changed before replacement and was not overwritten", displaced);
      }
    }

    try {
      // Claim an absent target with mkdir rather than rename: rename would replace
      // content another process created after our last inspection.
      mkdirSync(location.path, { recursive: false, mode: 0o700 });
    } catch (error) {
      const current = inspectLocation(location, bundle);
      const reason = current.state === "absent" ? (error as Error).message : "target was created during installation and was not overwritten";
      return preservedFailure(current, reason, displaced);
    }

    try {
      publishBundleExclusively(location.path, staged, bundle);
    } catch (error) {
      return preservedFailure(
        inspectLocation(location, bundle),
        `installation stopped rather than overwrite content created concurrently: ${(error as Error).message}`,
        displaced
      );
    }

    const next = inspectLocation(location, bundle);
    if (next.state !== "current-managed") {
      return preservedFailure(next, "target changed while the new bundle was being installed and was preserved", displaced);
    }

    if (displaced) {
      const moved = inspectMovedTree(location, displaced, bundle);
      if (!sameInspectedTree(refreshed, moved)) {
        return preservedFailure(next, "detached content changed during installation and was not deleted", displaced);
      }
      rmSync(displaced, { recursive: true, force: true });
      displaced = undefined;
    }
    return { ...next, action: status.state === "absent" ? "installed" : "updated" };
  } catch (error) {
    return preservedFailure(status, (error as Error).message, displaced);
  } finally {
    if (stagedOwned && staged) rmSync(staged, { recursive: true, force: true });
  }
}

function installAgentSkillAtLocation(
  location: AgentSkillLocation,
  bundle: Bundle,
  options: AgentSkillOptions
): AgentSkillOperationResult {
  const status = inspectLocation(location, bundle);
  if (status.state === "current-managed") return { ...status, action: "unchanged" };
  if (status.state === "current-unmanaged") {
    try {
      assertSafeFilesystemTarget(location);
      const refreshed = inspectLocation(location, bundle);
      if (refreshed.state !== status.state || refreshed.installedIdentity !== status.installedIdentity) {
        return operationFailure(refreshed, "failed", "target changed during adoption; inspect it and retry");
      }
      writeManagedMarkerAtomically(location.path, bundle.identity);
      const next = inspectLocation(location, bundle);
      if (next.state !== "current-managed") {
        return operationFailure(next, "failed", "target changed during adoption; inspect it and retry");
      }
      return { ...next, action: "adopted", detail: "exact existing content is now ProPR-managed" };
    } catch (error) {
      return operationFailure(status, "failed", (error as Error).message);
    }
  }
  if (status.state === "unsafe") return operationFailure(status, "refused", status.detail ?? "unsafe target");
  const replaceable = status.state === "absent" || status.state === "outdated-managed";
  if (!replaceable && !options.force) {
    return operationFailure(status, "refused", "refusing to overwrite foreign or modified content; use --force to create a backup");
  }
  if (!options.force) return installAgentSkillWithoutOverwrite(status, location, bundle, options);

  const parent = dirname(location.path);
  let temporary: string | undefined;
  let displaced: string | undefined;
  let backupPath: string | undefined;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertSafeFilesystemTarget(location);
    const refreshed = inspectLocation(location, bundle);
    if (refreshed.state !== status.state || refreshed.installedIdentity !== status.installedIdentity) {
      return operationFailure(refreshed, "failed", "target changed during installation; inspect it and retry");
    }
    temporary = join(parent, `.propr.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    writeBundle(temporary, bundle);
    if (existsSync(location.path)) {
      displaced = uniqueSibling(location.path, "backup", options.now);
      renameSync(location.path, displaced);
      backupPath = displaced;
    }
    try {
      renameSync(temporary, location.path);
      temporary = undefined;
    } catch (error) {
      if (displaced && !existsSync(location.path)) renameSync(displaced, location.path);
      displaced = undefined;
      throw error;
    }
    chmodSync(location.path, 0o700);
    const next = inspectLocation(location, bundle);
    return {
      ...next,
      action: status.state === "absent" ? "installed" : "backed-up",
      backupPath,
    };
  } catch (error) {
    return operationFailure(status, "failed", (error as Error).message);
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

export function installAgentSkills(
  targets: readonly AgentSkillTarget[],
  options: AgentSkillOptions = {}
): AgentSkillOperationResult[] {
  const bundle = loadBundle(options.bundleDir);
  const env = options.env ?? process.env;
  return targets.map((target) => {
    let location: AgentSkillLocation;
    try {
      location = resolveAgentSkillLocation(target, env);
    } catch (error) {
      return operationFailure(unresolvedTargetStatus(target, bundle, error), "refused", (error as Error).message);
    }
    return installAgentSkillAtLocation(location, bundle, options);
  });
}

export function installAgentSkill(target: AgentSkillTarget, options: AgentSkillOptions = {}): AgentSkillOperationResult {
  return installAgentSkills([target], options)[0];
}

function removeAgentSkillAtLocation(
  location: AgentSkillLocation,
  bundle: Bundle,
  options: AgentSkillOptions
): AgentSkillOperationResult {
  const status = inspectLocation(location, bundle);
  if (status.state === "absent") return { ...status, action: "unchanged" };
  if (status.state === "unsafe") return operationFailure(status, "refused", status.detail ?? "unsafe target");
  const managedAndUnmodified = status.state === "current-managed" || status.state === "outdated-managed";
  if (!managedAndUnmodified && !options.force) {
    return operationFailure(status, "refused", "refusing to remove foreign or modified content");
  }
  try {
    assertSafeFilesystemTarget(location);
    const refreshed = inspectLocation(location, bundle);
    if (refreshed.state !== status.state || refreshed.installedIdentity !== status.installedIdentity) {
      return operationFailure(refreshed, "failed", "target changed during removal; inspect it and retry");
    }
    if (options.force) {
      const backupPath = uniqueSibling(location.path, "backup", options.now);
      renameSync(location.path, backupPath);
      return { ...status, state: "absent", action: "backed-up", backupPath, detail: "target removed; content preserved as a backup" };
    }
    const tombstone = uniqueSibling(location.path, "removing", options.now);
    renameSync(location.path, tombstone);
    const moved = inspectMovedTree(location, tombstone, bundle);
    if (!sameInspectedTree(refreshed, moved)) {
      return preservedFailure(status, "target changed before removal and was not deleted", tombstone);
    }
    rmSync(tombstone, { recursive: true, force: true });
    return { ...status, state: "absent", action: "removed" };
  } catch (error) {
    return operationFailure(status, "failed", (error as Error).message);
  }
}

export function removeAgentSkills(
  targets: readonly AgentSkillTarget[],
  options: AgentSkillOptions = {}
): AgentSkillOperationResult[] {
  const bundle = loadBundle(options.bundleDir);
  const env = options.env ?? process.env;
  return targets.map((target) => {
    let location: AgentSkillLocation;
    try {
      location = resolveAgentSkillLocation(target, env);
    } catch (error) {
      return operationFailure(unresolvedTargetStatus(target, bundle, error), "refused", (error as Error).message);
    }
    return removeAgentSkillAtLocation(location, bundle, options);
  });
}

export function removeAgentSkill(target: AgentSkillTarget, options: AgentSkillOptions = {}): AgentSkillOperationResult {
  return removeAgentSkills([target], options)[0];
}
