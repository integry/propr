import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalFleetJson, FLEET_RESET_CATEGORIES, type FleetResetBinding, type FleetResetEvidence } from '@propr/shared';
import { FleetFiles } from './files.js';
import { ResetGenerationFence, openResetDatabase, resetUnavailable } from './resetFence.js';
import { checkedObservation, type ResetAdapter } from './resetAdapters.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalFleetJson(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalFleetJson(a) === canonicalFleetJson(b);
async function syncDirectory(root: string) {
  const fd = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function absent(file: string) {
  try { await fs.lstat(file); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}
interface Entry { name: string; dev: number; ino: number; size: number; mtime: number; directory: boolean }
/** Reject links, devices, mount crossings and unknown top-level categories.
 * Files within each explicitly owned category are tenant-private, including logs. */
async function inventory(root: string): Promise<Entry[]> {
  const entries: Entry[] = []; const top = await fs.lstat(root);
  if (!top.isDirectory() || top.isSymbolicLink()) resetUnavailable();
  async function walk(dir: string) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name); const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || stat.dev !== top.dev || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) resetUnavailable();
      entries.push({ name: path.relative(root, file), dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, directory: stat.isDirectory() });
      if (entries.length > 100000) resetUnavailable();
      if (stat.isDirectory()) await walk(file);
    }
  }
  await walk(root); return entries;
}
export interface NativeResetOptions {
  /** Provisioned, exclusive tenant root; never derived from a request path. */
  tenantRoot: string;
  controlRoot: string;
  binding: FleetResetBinding;
  adapters: readonly ResetAdapter[];
  /** Close Core's database, log writers and non-queue background services. */
  resources: { close(): Promise<void>; observeClosed(): Promise<boolean> };
  /** Fault injection only; called after durable transitions. */
  checkpoint?: (phase: string) => Promise<void>;
}

/** Native application reset. Immutable effect intents survive outside tenant
 * state. Existing intents are observed only: uncertain deletion/revocation is
 * never redispatched. No PID kills, cgroups, Docker or secure-wipe claims. */
export class NativeResetRuntime {
  readonly fence: ResetGenerationFence;
  private readonly files: FleetFiles;
  private readonly tenant: FleetFiles;
  constructor(private readonly options: NativeResetOptions) {
    const root = path.resolve(options.tenantRoot); const control = path.resolve(options.controlRoot);
    if (root === control || control.startsWith(root + path.sep) || root.startsWith(control + path.sep) || root === path.parse(root).root) resetUnavailable();
    this.fence = new ResetGenerationFence(control);
    this.files = new FleetFiles(control); this.tenant = new FleetFiles(root);
  }
  async initialize() {
    await this.files.initialize(); await this.tenant.initialize();
    if (!same(this.options.adapters.map(a => a.name).sort(), ['queue', 'sessions', 'tunnel_bootstrap'])) resetUnavailable();
  }
  private async checkpoint(phase: string) { await this.options.checkpoint?.(phase); }
  private async effect(name: string, intent: unknown, run: () => Promise<void>, observe: () => Promise<unknown>) {
    const fresh = this.fence.intent(name, { binding: this.options.binding, intent });
    await this.checkpoint(`${name}:intent`);
    if (fresh) await run();
    await this.checkpoint(`${name}:effect`);
    const result = await observe();
    if (result === undefined || result === false) resetUnavailable();
    this.fence.complete(name, result);
    await this.checkpoint(`${name}:complete`);
    return result;
  }
  private async checkRoot(successor: boolean) {
    await this.tenant.check();
    const allowed: readonly string[] = successor ? ['successor'] : FLEET_RESET_CATEGORIES;
    if ((await fs.readdir(this.options.tenantRoot)).some(name => !allowed.includes(name))) resetUnavailable();
  }
  async execute(binding: FleetResetBinding): Promise<FleetResetEvidence> {
    if (!same(binding, this.options.binding)) resetUnavailable();
    await this.files.check(); await this.checkRoot(false);
    // Capture a fixed owner inventory before fencing. No caller supplied evidence.
    const owner = { binding, tenantRoot: path.resolve(this.options.tenantRoot) };
    if (!this.fence.intent('operation', owner)) resetUnavailable();
    await this.checkpoint('operation:intent');
    await this.effect('fence', owner, async () => this.fence.seal(binding), async () => this.fence.sealed(binding));
    for (const adapter of this.options.adapters) {
      await this.effect(`stop-${adapter.name}`, { name: adapter.name }, () => adapter.stop(binding), async () => checkedObservation(await adapter.observe(binding), binding));
    }
    await this.effect('close-resources', {}, () => this.options.resources.close(), () => this.options.resources.observeClosed());
    if (!this.fence.idle()) resetUnavailable();
    await this.checkRoot(false);
    for (const category of FLEET_RESET_CATEGORIES) {
      const root = path.join(this.options.tenantRoot, category);
      const tree = await absent(root) ? null : await inventory(root);
      const identity = tree === null ? null : await fs.lstat(root).then(s => ({ dev: s.dev, ino: s.ino }));
      await this.effect(`erase-${category}`, { identity, tree }, async () => {
        if (tree === null) return;
        await this.tenant.check();
        const current = await fs.lstat(root);
        if (current.dev !== identity!.dev || current.ino !== identity!.ino || !same(await inventory(root), tree)) resetUnavailable();
        // Walk from pinned directory descriptors. Parent symlink substitution
        // cannot redirect an unlink into a sibling or external retained backup.
        const rootHandle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const pinned = await rootHandle.stat();
          if (pinned.dev !== identity!.dev || pinned.ino !== identity!.ino) resetUnavailable();
          for (const entry of [...tree].reverse()) {
            const parts = entry.name.split(path.sep); const leaf = parts.pop()!;
            const parents: Awaited<ReturnType<typeof fs.open>>[] = [];
            let parent = rootHandle;
            try {
              let relative = '';
              for (const part of parts) {
                relative = relative ? path.join(relative, part) : part;
                const next = await fs.open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                parents.push(next); const stat = await next.stat(); const expected = tree.find(e => e.name === relative);
                if (!expected || stat.dev !== expected.dev || stat.ino !== expected.ino) resetUnavailable();
                parent = next;
              }
              const file = `/proc/self/fd/${parent.fd}/${leaf}`; const stat = await fs.lstat(file);
              if (stat.ino !== entry.ino || stat.dev !== entry.dev || stat.isSymbolicLink() ||
                (!entry.directory && (stat.size !== entry.size || stat.mtimeMs !== entry.mtime || stat.nlink !== 1))) resetUnavailable();
              if (entry.directory) await fs.rmdir(file); else await fs.unlink(file);
              await parent.sync();
            } finally { for (const parent of parents.reverse()) await parent.close(); }
          }
          const named = await fs.lstat(root);
          if (named.ino !== pinned.ino || named.dev !== pinned.dev || named.isSymbolicLink()) resetUnavailable();
          await fs.rmdir(root); await syncDirectory(this.options.tenantRoot);
        } finally { await rootHandle.close(); }
      }, () => absent(root));
    }
    await this.effect('successor', { identity: binding.successor }, () => this.createSuccessor(), () => this.observeSuccessor());
    await this.checkpoint('first-proof');
    const first = await this.observe();
    await this.checkpoint('second-proof');
    const second = await this.observe();
    if (!same(first, second)) resetUnavailable();
    this.fence.complete('operation', { observation: hash(second) });
    return this.terminal(second);
  }
  private successorRoot() { return path.join(this.options.tenantRoot, 'successor'); }
  private async createSuccessor() {
    const root = this.successorRoot(); await fs.mkdir(root, { mode: 0o700 }); await syncDirectory(this.options.tenantRoot);
    const successorControl = path.join(this.options.controlRoot, 'successor-control');
    await fs.mkdir(successorControl, { mode: 0o700 }); await syncDirectory(this.options.controlRoot);
    const successorFence = new ResetGenerationFence(successorControl);
    try { successorFence.provisionSuccessor(this.options.binding); } finally { successorFence.close(); }
    const files = new FleetFiles(root); await files.initialize();
    await files.create('identity.json', this.options.binding.successor);
    await files.create('config.json', {});
    const db = openResetDatabase(path.join(root, 'propr.sqlite'));
    try { db.exec('CREATE TABLE reset_identity (identity TEXT NOT NULL);'); db.prepare('INSERT INTO reset_identity VALUES (?)').run(canonicalFleetJson(this.options.binding.successor)); }
    finally { db.close(); }
    await fs.chmod(path.join(root, 'propr.sqlite'), 0o600); await syncDirectory(root);
  }
  private async observeSuccessor() {
    const root = this.successorRoot();
    if (!same((await fs.readdir(root)).sort(), ['config.json', 'identity.json', 'propr.sqlite'])) resetUnavailable();
    const files = new FleetFiles(root); await files.initialize();
    if (!same(JSON.parse(await files.read('identity.json')), this.options.binding.successor) || !same(JSON.parse(await files.read('config.json')), {})) resetUnavailable();
    // Boot a real, independent SQLite connection. It contains no customer rows,
    // credentials, pending work, migration replay or on-boot tasks.
    const stat = await fs.lstat(path.join(root, 'propr.sqlite'));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) resetUnavailable();
    const db = openResetDatabase(path.join(root, 'propr.sqlite'));
    try {
      if (!same(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), [{ name: 'reset_identity' }]) ||
        !same(db.prepare('SELECT identity FROM reset_identity').all(), [{ identity: canonicalFleetJson(this.options.binding.successor) }])) resetUnavailable();
    } finally { db.close(); }
    // Test the actual authority and work admissions, not receipt booleans.
    const booted = new ResetGenerationFence(path.join(this.options.controlRoot, 'successor-control'));
    let refused = false;
    try { booted.assert(this.options.binding.predecessor); } catch { refused = true; }
    finally { booted.close(); }
    if (!refused || !this.fence.revoked(this.options.binding)) resetUnavailable();
    return { identity: this.options.binding.successor, empty: true, predecessorRefused: true, dev: stat.dev, ino: stat.ino };
  }
  private async observe() {
    await this.files.check(); await this.checkRoot(true);
    const binding = this.options.binding;
    if (!this.fence.sealed(binding) || !this.fence.idle() || !await this.options.resources.observeClosed()) resetUnavailable();
    for (const category of FLEET_RESET_CATEGORIES) if (!await absent(path.join(this.options.tenantRoot, category))) resetUnavailable();
    const external = [];
    for (const adapter of this.options.adapters) external.push(checkedObservation(await adapter.observe(binding), binding));
    return { external, successor: await this.observeSuccessor(), tree: await inventory(this.options.tenantRoot) };
  }
  private terminal(observation: unknown): FleetResetEvidence {
    return { state: 'complete', categories: Object.fromEntries(FLEET_RESET_CATEGORIES.map(k => [k, 'erased'])) as any,
      predecessorFenced: true, successorIsolated: true, bootstrapAllowed: true, reason: 'stable_native_proof', observationDigest: hash(observation) };
  }
  /** Read-only reconciliation. All intents must already be complete; unknown or
   * partial effects stay fenced. Never retries external or destructive calls. */
  async reconcile(binding: FleetResetBinding): Promise<FleetResetEvidence> {
    if (!same(binding, this.options.binding)) resetUnavailable();
    const required = ['fence', 'stop-queue', 'stop-sessions', 'stop-tunnel_bootstrap', 'close-resources', ...FLEET_RESET_CATEGORIES.map(k => `erase-${k}`), 'successor'];
    for (const name of required) {
      const effect = this.fence.effect(name); if (!effect) resetUnavailable();
      if (!same(JSON.parse(effect!.intent).binding, binding)) resetUnavailable();
    }
    const first = await this.observe(); const second = await this.observe();
    if (!same(first, second)) resetUnavailable();
    const operation = this.fence.effect('operation');
    if (!operation || (operation.result && operation.result !== canonicalFleetJson({ observation: hash(second) }))) resetUnavailable();
    // Lost acknowledgements can be reconciled only from current terminal
    // observations. Partial effects are never retried, even after process death.
    for (const name of required) {
      if (this.fence.effect(name)!.result) continue;
      const adapterIndex = this.options.adapters.findIndex(a => name === `stop-${a.name}`);
      this.fence.complete(name, adapterIndex >= 0 ? second.external[adapterIndex] : name === 'successor' ? second.successor : true);
    }
    this.fence.complete('operation', { observation: hash(second) });
    return this.terminal(second);
  }
  /** Only the successor's new identity can receive a bootstrap authority, after
   * the two stable proofs. Old reset credentials are not bootstrap credentials. */
  async bootstrapSuccessor(binding: FleetResetBinding) {
    await this.reconcile(binding);
    const successor = new ResetGenerationFence(path.join(this.options.controlRoot, 'successor-control'));
    try {
      // Intent before authority activation; a lost response burns this grant.
      if (!this.fence.intent('bootstrap', { binding })) resetUnavailable();
      successor.activateSuccessor(binding);
      return successor.issue(binding.successor, 'bootstrap');
    } finally { successor.close(); }
  }
  close() { this.fence.close(); }
}
