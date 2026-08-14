import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  directoryDescriptorAccess,
  withDirectoryDescriptorPath,
  type DirectoryDescriptorAccess,
} from "./utils/directoryDescriptor.js";

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
  fallback?: () => string
): string {
  if (Object.prototype.hasOwnProperty.call(env, key)) {
    const value = env[key];
    if (value?.trim()) return value;
    if (fallback !== undefined) return fallback();
    throw new Error(`${key} is empty`);
  }
  if (fallback !== undefined) return fallback();
  throw new Error(`${key} is not set`);
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
  const home = (): string => assertSafeBase(environmentValue(env, "HOME"), "HOME", { directRoot, allowRootBase: true });
  let toolHome: string;
  switch (target) {
    case "codex":
      toolHome = assertSafeBase(environmentValue(env, "CODEX_HOME", () => join(home(), ".codex")), "CODEX_HOME", { directRoot });
      break;
    case "claude":
      toolHome = join(home(), ".claude");
      break;
    case "antigravity":
      toolHome = join(home(), ".gemini", "antigravity-cli");
      break;
    case "opencode": {
      const xdg = assertSafeBase(environmentValue(env, "XDG_CONFIG_HOME", () => join(home(), ".config")), "XDG_CONFIG_HOME", { directRoot });
      toolHome = join(xdg, "opencode");
      break;
    }
    case "vibe":
      toolHome = join(home(), ".vibe");
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
  const updateField = (value: string | Buffer): void => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };

  updateField("propr-skill-tree-v2");
  for (const entry of entries) {
    updateField(entry.kind);
    updateField(entry.path);
    updateField(entry.content ?? Buffer.alloc(0));
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
    const stat = lstatIfExists(walked);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`symbolic link parent is not allowed: ${walked}`);
    if (!stat.isDirectory()) throw new Error(`parent is not a directory: ${walked}`);
  }
  let ancestor = toolHome;
  let ancestorStat = lstatIfExists(ancestor);
  while (!ancestorStat) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`no directory parent exists for ${toolHome}`);
    ancestor = parent;
    ancestorStat = lstatIfExists(ancestor);
  }
  if (ancestorStat.isSymbolicLink()) throw new Error(`symbolic link parent is not allowed: ${ancestor}`);
  if (!ancestorStat.isDirectory()) throw new Error(`parent is not a directory: ${ancestor}`);

  let current = toolHome;
  const suffix = relative(toolHome, path).split(sep).filter(Boolean);
  for (const part of ["", ...suffix]) {
    if (part) current = join(current, part);
    const stat = lstatIfExists(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`symbolic link target is not allowed: ${current}`);
    if (current !== path && !stat.isDirectory()) throw new Error(`parent is not a directory: ${current}`);
  }
}

function assertProviderSkillTarget(location: AgentSkillLocation): void {
  const parent = dirname(location.path);
  const expectedParent = join(location.toolHome, "skills");
  if (parent !== expectedParent || location.path !== join(expectedParent, "propr")) {
    throw new Error(`unsafe ${location.target} skill target`);
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
    const targetStat = lstatIfExists(location.path);
    if (!targetStat) return { ...location, state: "absent", bundledIdentity: bundle.identity };
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

interface PinnedDirectory {
  fd: number;
  path: string;
  access: DirectoryDescriptorAccess;
}

function descriptorRoot(access: DirectoryDescriptorAccess): string {
  const candidates = access === "child-paths" ? ["/proc/self/fd", "/dev/fd"] : ["/dev/fd"];
  for (const root of candidates) {
    if (existsSync(root)) return root;
  }
  throw new Error("safe directory-handle publication is not supported on this platform");
}

function descriptorPath(root: string, fd: number): string {
  return join(root, String(fd));
}

function withPinnedPath<T>(directory: PinnedDirectory, operation: (base: string) => T): T {
  return withDirectoryDescriptorPath(directory.path, directory.access, operation);
}

function openDirectoryNoFollow(path: string): PinnedDirectory {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const access = directoryDescriptorAccess();
  const root = descriptorRoot(access);
  let fd = openSync(sep, flags);
  let visiblePath: string = sep;
  try {
    for (const component of resolve(path).split(sep).filter(Boolean)) {
      const current = { fd, path: descriptorPath(root, fd), access };
      const next = withPinnedPath(current, (base) => openSync(join(base, component), flags));
      closeSync(fd);
      fd = next;
      visiblePath = join(visiblePath, component);
      assertVisibleDirectoryIdentity(visiblePath, { fd, path: descriptorPath(root, fd), access });
    }
    return { fd, path: descriptorPath(root, fd), access };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openPinnedChild(parent: PinnedDirectory, name: string): PinnedDirectory {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const fd = withPinnedPath(parent, (base) => openSync(join(base, name), flags));
  return { fd, path: descriptorPath(dirname(parent.path), fd), access: parent.access };
}

function closePinnedDirectory(directory: PinnedDirectory): void {
  closeSync(directory.fd);
}

function sameFilesystemObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertVisibleDirectoryIdentity(visiblePath: string, pinned: PinnedDirectory): void {
  const visible = lstatIfExists(visiblePath);
  if (!visible) throw new Error(`directory changed while it was being used: ${visiblePath}`);
  if (visible.isSymbolicLink()) throw new Error(`symbolic link parent is not allowed: ${visiblePath}`);
  if (!visible.isDirectory()) throw new Error(`parent is not a directory: ${visiblePath}`);
  if (!sameFilesystemObject(visible, fstatSync(pinned.fd))) {
    throw new Error(`directory changed while it was being used: ${visiblePath}`);
  }
}

function assertVisibleEntryIdentity(parent: PinnedDirectory, visibleParent: string, name: string): void {
  assertVisibleDirectoryIdentity(visibleParent, parent);
  const visiblePath = join(visibleParent, name);
  const visible = lstatIfExists(visiblePath);
  const pinned = withPinnedPath(parent, (base) => lstatIfExists(join(base, name)));
  if (!visible || !pinned || visible.isSymbolicLink() || pinned.isSymbolicLink() || !sameFilesystemObject(visible, pinned)) {
    throw new Error(`target changed while it was being used: ${visiblePath}`);
  }
}

/** Create and hold the exact provider skills directory through a no-follow chain. */
function ensureProviderSkillsParent(location: AgentSkillLocation): PinnedDirectory {
  assertProviderSkillTarget(location);
  assertSafeFilesystemTarget(location);

  const parent = dirname(location.path);
  let current = openDirectoryNoFollow(sep);
  let visibleCurrent: string = sep;
  try {
    for (const component of resolve(parent).split(sep).filter(Boolean)) {
      assertVisibleDirectoryIdentity(visibleCurrent, current);
      let child: PinnedDirectory | undefined;
      let created = false;
      try {
        child = openPinnedChild(current, component);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Keep the mutation relative to the held ancestor. Even if its visible
        // pathname races after the check, a replacement symlink is never used.
        assertVisibleDirectoryIdentity(visibleCurrent, current);
        try {
          withPinnedPath(current, (base) => mkdirSync(join(base, component), { recursive: false, mode: 0o700 }));
          created = true;
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
          const racedPath = join(visibleCurrent, component);
          if (lstatIfExists(racedPath)?.isSymbolicLink()) {
            throw new Error(`symbolic link parent is not allowed: ${racedPath}`);
          }
        }
        child = openPinnedChild(current, component);
      }

      const visibleChild = join(visibleCurrent, component);
      try {
        assertVisibleDirectoryIdentity(visibleChild, child);
      } catch (error) {
        try {
          if (created) removePinnedTreeIfSameDirectory(current, component, child);
        } finally {
          closePinnedDirectory(child);
        }
        throw error;
      }
      closePinnedDirectory(current);
      current = child;
      visibleCurrent = visibleChild;
    }
    return current;
  } catch (error) {
    closePinnedDirectory(current);
    throw error;
  }
}

function openProviderSkillsParent(location: AgentSkillLocation): PinnedDirectory {
  assertProviderSkillTarget(location);
  return openDirectoryNoFollow(dirname(location.path));
}

function uniqueSibling(
  parent: PinnedDirectory,
  visibleParent: string,
  label: string,
  now = new Date()
): { name: string; path: string } {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assertVisibleDirectoryIdentity(visibleParent, parent);
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const name = `.propr.${label}-${stamp}${suffix}`;
    if (!withPinnedPath(parent, (base) => lstatIfExists(join(base, name)))) {
      return { name, path: join(visibleParent, name) };
    }
  }
  throw new Error(`could not allocate ${label} path beside ${join(visibleParent, "propr")}`);
}

function createPinnedSiblingDirectory(
  parent: PinnedDirectory,
  visibleParent: string,
  label: string,
  now?: Date
): { directory: PinnedDirectory; name: string; path: string } {
  for (;;) {
    const candidate = uniqueSibling(parent, visibleParent, label, now);
    assertVisibleDirectoryIdentity(visibleParent, parent);
    let directory: PinnedDirectory | undefined;
    let created = false;
    try {
      withPinnedPath(parent, (base) => mkdirSync(join(base, candidate.name), { recursive: false, mode: 0o700 }));
      created = true;
      directory = openPinnedChild(parent, candidate.name);
      assertVisibleDirectoryIdentity(candidate.path, directory);
      return { ...candidate, directory };
    } catch (error) {
      if (directory) {
        try {
          if (created) removePinnedTreeIfSameDirectory(parent, candidate.name, directory);
        } finally {
          closePinnedDirectory(directory);
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function renamePinnedEntry(
  parent: PinnedDirectory,
  visibleParent: string,
  oldName: string,
  newName: string
): void {
  assertVisibleEntryIdentity(parent, visibleParent, oldName);
  withPinnedPath(parent, (base) => renameSync(join(base, oldName), join(base, newName)));
  assertVisibleDirectoryIdentity(visibleParent, parent);
}

function removePinnedTree(parent: PinnedDirectory, name: string): void {
  withPinnedPath(parent, (base) => rmSync(join(base, name), { recursive: true, force: true }));
}

/** Remove only the entry represented by the held directory, never a raced replacement at its name. */
function removePinnedTreeIfSameDirectory(
  parent: PinnedDirectory,
  name: string,
  expected: PinnedDirectory
): boolean {
  const current = withPinnedPath(parent, (base) => lstatIfExists(join(base, name)));
  if (
    !current ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameFilesystemObject(current, fstatSync(expected.fd))
  ) {
    return false;
  }
  removePinnedTree(parent, name);
  return true;
}

function writeBundleContents(directory: PinnedDirectory, bundle: Bundle): void {
  const directories = new Map<string, PinnedDirectory>([["", directory]]);
  const opened: PinnedDirectory[] = [];
  try {
    for (const entry of bundle.entries) {
      const separator = entry.path.lastIndexOf("/");
      const parentPath = separator === -1 ? "" : entry.path.slice(0, separator);
      const name = separator === -1 ? entry.path : entry.path.slice(separator + 1);
      const entryParent = directories.get(parentPath);
      if (!entryParent) throw new Error(`bundle parent was not written before its child: ${entry.path}`);
      if (entry.kind === "directory") {
        withPinnedPath(entryParent, (base) => mkdirSync(join(base, name), { recursive: false, mode: 0o700 }));
        const child = openPinnedChild(entryParent, name);
        directories.set(entry.path, child);
        opened.push(child);
      } else {
        withPinnedPath(entryParent, (base) => writeFileSync(join(base, name), entry.content!, { mode: 0o600, flag: "wx" }));
      }
    }
    withPinnedPath(directory, (base) =>
      writeFileSync(join(base, MANAGED_FILE), managedMarkerContent(bundle.identity), { mode: 0o600, flag: "wx" })
    );
  } finally {
    for (const openedDirectory of opened.reverse()) closePinnedDirectory(openedDirectory);
  }
}

/** Claim the target through a pinned provider directory, without following raced symlinks. */
function claimTargetDirectory(location: AgentSkillLocation, pinnedParent: PinnedDirectory): PinnedDirectory {
  const parent = dirname(location.path);
  assertProviderSkillTarget(location);

  let pinnedTarget: PinnedDirectory | undefined;
  try {
    assertVisibleDirectoryIdentity(parent, pinnedParent);
    withPinnedPath(pinnedParent, (base) => mkdirSync(join(base, "propr"), { recursive: false, mode: 0o700 }));
    pinnedTarget = openPinnedChild(pinnedParent, "propr");

    const visible = lstatIfExists(location.path);
    const pinned = fstatSync(pinnedTarget.fd);
    if (
      !visible ||
      visible.isSymbolicLink() ||
      !visible.isDirectory() ||
      !sameFilesystemObject(visible, pinned)
    ) {
      throw new Error("target changed while it was being claimed; no bundle content was published");
    }
    return pinnedTarget;
  } catch (error) {
    if (pinnedTarget) closePinnedDirectory(pinnedTarget);
    throw error;
  }
}

function writePinnedFileExclusively(
  directory: PinnedDirectory,
  name: string,
  content: string | Buffer,
  temporaryLabel = "publish",
  beforePublish?: () => void
): void {
  const temporary = `.propr.${temporaryLabel}-${process.pid}-${randomBytes(6).toString("hex")}`;
  withPinnedPath(directory, (base) => {
    try {
      writeFileSync(join(base, temporary), content, { mode: 0o600, flag: "wx" });
      beforePublish?.();
      linkSync(join(base, temporary), join(base, name));
    } finally {
      try {
        unlinkSync(join(base, temporary));
      } catch {
        // The temporary path may not have been created.
      }
    }
  });
}

/** Publish through pinned, no-follow handles without replacing any entry. */
function publishBundleExclusively(directory: PinnedDirectory, bundle: Bundle): void {
  const directories = new Map<string, PinnedDirectory>([["", directory]]);
  const opened: PinnedDirectory[] = [];
  try {
    for (const entry of bundle.entries) {
      const separator = entry.path.lastIndexOf("/");
      const parentPath = separator === -1 ? "" : entry.path.slice(0, separator);
      const name = separator === -1 ? entry.path : entry.path.slice(separator + 1);
      const parent = directories.get(parentPath);
      if (!parent) throw new Error(`bundle parent was not published before its child: ${entry.path}`);
      if (entry.kind === "directory") {
        withPinnedPath(parent, (base) => mkdirSync(join(base, name), { mode: 0o700 }));
        const child = openPinnedChild(parent, name);
        directories.set(entry.path, child);
        opened.push(child);
      } else {
        writePinnedFileExclusively(parent, name, entry.content!);
      }
    }
    writePinnedFileExclusively(directory, MANAGED_FILE, managedMarkerContent(bundle.identity));
  } finally {
    for (const openedDirectory of opened.reverse()) closePinnedDirectory(openedDirectory);
  }
}

function managedMarkerContent(identity: string): string {
  const marker: ManagedMarker = { manager: MANAGER, schema: MANAGED_SCHEMA, contentSha256: identity };
  return `${JSON.stringify(marker, null, 2)}\n`;
}

/** Add a fully-written marker through a held target without following a raced replacement. */
function writeManagedMarkerAtomically(directory: PinnedDirectory, visiblePath: string, identity: string): void {
  assertVisibleDirectoryIdentity(visiblePath, directory);
  writePinnedFileExclusively(directory, MANAGED_FILE, managedMarkerContent(identity), "marker", () => {
    assertVisibleDirectoryIdentity(visiblePath, directory);
  });
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
  let pinnedParent: PinnedDirectory | undefined;
  let staged: { directory: PinnedDirectory; name: string; path: string } | undefined;
  let displaced: string | undefined;
  try {
    pinnedParent = ensureProviderSkillsParent(location);
    const refreshed = inspectLocation(location, bundle);
    if (!sameInspectedTree(status, refreshed)) {
      return operationFailure(refreshed, "failed", "target changed during installation; inspect it and retry");
    }

    staged = createPinnedSiblingDirectory(pinnedParent, parent, "installing", options.now);
    writeBundleContents(staged.directory, bundle);

    if (refreshed.state === "outdated-managed") {
      const replacement = uniqueSibling(pinnedParent, parent, "replaced", options.now);
      displaced = replacement.path;
      renamePinnedEntry(pinnedParent, parent, "propr", replacement.name);
      const moved = inspectMovedTree(location, displaced, bundle);
      if (!sameInspectedTree(refreshed, moved)) {
        return preservedFailure(status, "target changed before replacement and was not overwritten", displaced);
      }
    }

    let claimed: PinnedDirectory;
    try {
      claimed = claimTargetDirectory(location, pinnedParent);
    } catch (error) {
      const current = inspectLocation(location, bundle);
      const reason = current.state === "absent" ? (error as Error).message : "target was created during installation and was not overwritten";
      return preservedFailure(current, reason, displaced);
    }

    try {
      assertVisibleDirectoryIdentity(parent, pinnedParent);
      assertVisibleDirectoryIdentity(location.path, claimed);
      publishBundleExclusively(claimed, bundle);
    } catch (error) {
      return preservedFailure(
        inspectLocation(location, bundle),
        `installation stopped rather than overwrite content created concurrently: ${(error as Error).message}`,
        displaced
      );
    } finally {
      closePinnedDirectory(claimed);
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
    }
    return {
      ...next,
      action: status.state === "absent" ? "installed" : "updated",
      backupPath: displaced,
      detail: displaced ? "previous managed content preserved as a backup" : undefined,
    };
  } catch (error) {
    return preservedFailure(status, (error as Error).message, displaced);
  } finally {
    try {
      if (staged && pinnedParent) {
        removePinnedTreeIfSameDirectory(pinnedParent, staged.name, staged.directory);
      }
    } finally {
      if (staged) closePinnedDirectory(staged.directory);
      if (pinnedParent) closePinnedDirectory(pinnedParent);
    }
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
    let pinnedParent: PinnedDirectory | undefined;
    let pinnedTarget: PinnedDirectory | undefined;
    try {
      pinnedParent = openProviderSkillsParent(location);
      pinnedTarget = openPinnedChild(pinnedParent, "propr");
      assertVisibleDirectoryIdentity(location.path, pinnedTarget);
      const refreshed = inspectLocation(location, bundle);
      if (refreshed.state !== status.state || refreshed.installedIdentity !== status.installedIdentity) {
        return operationFailure(refreshed, "failed", "target changed during adoption; inspect it and retry");
      }
      writeManagedMarkerAtomically(pinnedTarget, location.path, bundle.identity);
      const next = inspectLocation(location, bundle);
      if (next.state !== "current-managed") {
        return operationFailure(next, "failed", "target changed during adoption; inspect it and retry");
      }
      return { ...next, action: "adopted", detail: "exact existing content is now ProPR-managed" };
    } catch (error) {
      return operationFailure(status, "failed", (error as Error).message);
    } finally {
      if (pinnedTarget) closePinnedDirectory(pinnedTarget);
      if (pinnedParent) closePinnedDirectory(pinnedParent);
    }
  }
  if (status.state === "unsafe") return operationFailure(status, "refused", status.detail ?? "unsafe target");
  const replaceable = status.state === "absent" || status.state === "outdated-managed";
  if (!replaceable && !options.force) {
    return operationFailure(status, "refused", "refusing to overwrite foreign or modified content; use --force to create a backup");
  }
  if (!options.force) return installAgentSkillWithoutOverwrite(status, location, bundle, options);

  const parent = dirname(location.path);
  let pinnedParent: PinnedDirectory | undefined;
  let temporary: { directory: PinnedDirectory; name: string; path: string } | undefined;
  let displaced: string | undefined;
  let backupPath: string | undefined;
  try {
    pinnedParent = ensureProviderSkillsParent(location);
    const refreshed = inspectLocation(location, bundle);
    if (refreshed.state !== status.state || refreshed.installedIdentity !== status.installedIdentity) {
      return operationFailure(refreshed, "failed", "target changed during installation; inspect it and retry");
    }
    temporary = createPinnedSiblingDirectory(
      pinnedParent,
      parent,
      `tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
      options.now
    );
    writeBundleContents(temporary.directory, bundle);
    if (refreshed.state !== "absent") {
      const backup = uniqueSibling(pinnedParent, parent, "backup", options.now);
      displaced = backup.path;
      renamePinnedEntry(pinnedParent, parent, "propr", backup.name);
      backupPath = backup.path;
    }
    let claimed: PinnedDirectory;
    try {
      claimed = claimTargetDirectory(location, pinnedParent);
    } catch (error) {
      const current = inspectLocation(location, bundle);
      const detail = current.state === "absent"
        ? (error as Error).message
        : "target was created during installation and was not overwritten";
      return preservedFailure(current, detail, backupPath);
    }
    try {
      assertVisibleDirectoryIdentity(parent, pinnedParent);
      assertVisibleDirectoryIdentity(location.path, claimed);
      publishBundleExclusively(claimed, bundle);
    } catch (error) {
      return preservedFailure(
        inspectLocation(location, bundle),
        `installation stopped rather than overwrite content created concurrently: ${(error as Error).message}`,
        backupPath
      );
    } finally {
      closePinnedDirectory(claimed);
    }
    const next = inspectLocation(location, bundle);
    if (next.state !== "current-managed") {
      return preservedFailure(next, "target changed after the new bundle was published and was preserved", backupPath);
    }
    return {
      ...next,
      action: status.state === "absent" ? "installed" : "backed-up",
      backupPath,
    };
  } catch (error) {
    if (displaced) {
      return {
        ...status,
        action: "failed",
        backupPath: displaced,
        detail: `${(error as Error).message}; original target remains preserved at ${displaced}`,
      };
    }
    return operationFailure(status, "failed", (error as Error).message);
  } finally {
    if (temporary) {
      closePinnedDirectory(temporary.directory);
      if (pinnedParent) removePinnedTree(pinnedParent, temporary.name);
    }
    if (pinnedParent) closePinnedDirectory(pinnedParent);
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
  const parent = dirname(location.path);
  let pinnedParent: PinnedDirectory | undefined;
  try {
    pinnedParent = openProviderSkillsParent(location);
    const refreshed = inspectLocation(location, bundle);
    if (refreshed.state !== status.state || refreshed.installedIdentity !== status.installedIdentity) {
      return operationFailure(refreshed, "failed", "target changed during removal; inspect it and retry");
    }
    if (options.force) {
      const backup = uniqueSibling(pinnedParent, parent, "backup", options.now);
      renamePinnedEntry(pinnedParent, parent, "propr", backup.name);
      return {
        ...status,
        state: "absent",
        action: "backed-up",
        backupPath: backup.path,
        detail: "target removed; content preserved as a backup",
      };
    }
    const tombstone = uniqueSibling(pinnedParent, parent, "removing", options.now);
    renamePinnedEntry(pinnedParent, parent, "propr", tombstone.name);
    const moved = inspectMovedTree(location, tombstone.path, bundle);
    if (!sameInspectedTree(refreshed, moved)) {
      return preservedFailure(status, "target changed before removal and was not deleted", tombstone.path);
    }
    return {
      ...status,
      state: "absent",
      action: "removed",
      backupPath: tombstone.path,
      detail: "target removed; content preserved as a backup",
    };
  } catch (error) {
    return operationFailure(status, "failed", (error as Error).message);
  } finally {
    if (pinnedParent) closePinnedDirectory(pinnedParent);
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
