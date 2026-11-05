import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FleetRefusal } from './contract.js';

/** Private management namespace, outside customer database and cleanup registries. */
export class FleetFiles {
  private ancestry: Array<{ name: string; stat: Stats }> = [];
  constructor(readonly root: string) {}
  async initialize() {
    let current = path.resolve(this.root);
    for (;;) {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (current === path.resolve(this.root) && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new FleetRefusal();
      this.ancestry.push({ name: current, stat });
      const parent = path.dirname(current); if (current === parent) break; current = parent;
    }
  }
  async check() {
    if (!this.ancestry.length) throw new FleetRefusal();
    for (const { name, stat } of this.ancestry) {
      const now = await fs.lstat(name);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== stat.dev || now.ino !== stat.ino || (name === path.resolve(this.root) && ((now.mode & 0o077) !== 0 || now.uid !== process.getuid?.()))) throw new FleetRefusal();
    }
  }
  async open(name: string, flags: number) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new FleetRefusal();
    await this.check();
    const handle = await fs.open(path.join(this.root, name), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new FleetRefusal();
      await this.check();
      const named = await fs.lstat(path.join(this.root, name));
      if (named.dev !== stat.dev || named.ino !== stat.ino) throw new FleetRefusal();
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async read(name: string): Promise<string> {
    const handle = await this.open(name, constants.O_RDONLY);
    try {
      // Bounded read even if the file grows after fstat.
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) throw new FleetRefusal();
      await this.check();
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  }
  async create(name: string, value: unknown) {
    const handle = await this.open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await this.check(); }
    finally { await handle.close(); }
    // Persist directory entry before any dispatch, including on power loss.
    const directory = await fs.open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async replaceRuntime(value: unknown) {
    await this.check();
    try { await this.read('runtime.json'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temp = `runtime-${randomUUID()}.tmp`;
    await this.create(temp, value);
    await this.check();
    await fs.rename(path.join(this.root, temp), path.join(this.root, 'runtime.json'));
    const directory = await fs.open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async append(name: string, value: unknown) {
    const data = JSON.stringify(value) + '\n';
    const handle = await this.open(name, constants.O_WRONLY | constants.O_APPEND);
    try {
      if ((await handle.stat()).size + Buffer.byteLength(data) > 65536) throw new FleetRefusal();
      await handle.writeFile(data); await handle.sync(); await this.check();
    } finally { await handle.close(); }
  }
}
