import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';

/**
 * An in-memory stand-in for the part of `@fly/sprites` the Sprites runtime
 * uses. A fake Sprite has a filesystem (with entry types, so symlinks and
 * special files can be planted), checkpoints that snapshot and restore that
 * filesystem, and a launcher that behaves like `scripts/sprites-launcher.sh`
 * at the level the worker sees: it unpacks the uploaded payload, installs the
 * manifest, "runs" a scripted behaviour, exports the refreshable credentials
 * and records the exit status.
 */

export type FakeNode =
    | { type: 'file'; content: Buffer; mode: number; mtimeMs: number }
    | { type: 'dir' }
    | { type: 'symlink'; target: string }
    | { type: 'fifo' };

export interface FakeRunContext {
    sprite: FakeSprite;
    argv: string[];
    env: Record<string, string>;
    stdin?: string;
    /** Manifest records as the launcher reads them. */
    records: string[][];
    /** Refreshable credentials, by export index. */
    outputs: Array<{ index: number; livePath: string }>;
    /** Every path that existed on the Sprite when the launcher started, before it installed anything. */
    pathsAtLaunch: string[];
    write(file: string, content: string | Buffer, mtimeMs?: number): void;
}

export interface FakeRunBehavior {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    /** The run keeps going until it is signalled. */
    hang?: boolean;
    /** What the launcher reports for its credential export. */
    exportState?: 'ok' | 'unsafe';
    /** What the clone wrapper recorded, e.g. `pushed <sha>` or `bundle <sha>`. */
    resultStatus?: string;
    resultBundle?: Buffer;
    /** What the agent does on the Sprite. */
    act?(context: FakeRunContext): void;
    /** Runs after the launcher exported, to plant entries in its export or result directories. */
    tamper?(context: FakeRunContext): void;
}

export const FAKE_LAUNCHER = '/opt/propr/launcher.sh';
export const FAKE_RUN_DIR = '/opt/propr/run';
const SETUP_DIR = '/tmp/propr-sprites-setup';

function notFound(file: string): Error {
    return Object.assign(new Error(`ENOENT: no such file or directory, '${file}'`), { code: 'ENOENT' });
}

/** Regular files and directories of a tar archive (ustar with GNU long names). */
export function parseTar(archive: Buffer): Array<{ path: string; type: 'file' | 'dir'; content: Buffer; mode: number; mtimeMs: number }> {
    const entries: ReturnType<typeof parseTar> = [];
    let longName: string | undefined;
    for (let offset = 0; offset + 512 <= archive.length;) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;
        const text = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(text(124, 12).trim() || '0', 8);
        const type = text(156, 1) || '0';
        const content = Buffer.from(archive.subarray(offset + 512, offset + 512 + size));
        offset += 512 + Math.ceil(size / 512) * 512;
        if (type === 'L') { longName = content.toString('utf8').replace(/\0.*$/s, ''); continue; }
        const name = (longName ?? text(0, 100)).replace(/\/$/, '');
        longName = undefined;
        if (type !== '0' && type !== '5') throw new Error(`unexpected tar entry type ${type} for ${name}`);
        entries.push({ path: name, type: type === '5' ? 'dir' : 'file', content, mode: parseInt(text(100, 8).trim(), 8), mtimeMs: parseInt(text(136, 12).trim(), 8) * 1000 });
    }
    return entries;
}

function nulList(buffer: Buffer | undefined): string[] {
    return buffer ? buffer.toString('utf8').split('\0').slice(0, -1) : [];
}

class FakeCommand extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    private exit!: (code: number) => void;
    private readonly exited = new Promise<number>(resolve => { this.exit = resolve; });
    closed = false;

    constructor(run: (command: FakeCommand) => Promise<number>) {
        super();
        setImmediate(() => {
            this.emit('spawn');
            void run(this).then(code => this.finish(code), () => this.finish(-1));
        });
    }

    private finish(code: number): void {
        this.stdout.end();
        this.stderr.end();
        this.exit(code);
    }

    wait(): Promise<number> { return this.exited; }
    kill(): void { this.close(); }
    close(): void { this.closed = true; this.finish(-1); }
}

export class FakeSprite {
    readonly files = new Map<string, FakeNode>([['/', { type: 'dir' }], ['/tmp', { type: 'dir' }]]);
    readonly checkpoints: Array<{ id: string; comment?: string; createTime: Date; files: Map<string, FakeNode> }> = [];
    /** One entry per launcher start, in order. */
    readonly runs: FakeRunContext[] = [];
    /** Arguments of every exec, spawn and session, for assertions about what reaches the Sprite. */
    readonly commands: string[][] = [];
    setupEnvironment: Record<string, string> = {};
    behaviors: FakeRunBehavior[] = [];
    /** How many of the next restores fail. */
    failRestores = 0;
    /** `signal KILL` reports survivors. */
    killFails = false;
    /** How many of the next output followers drop their connection after `dropAfterBytes`. */
    dropFollowers = 0;
    dropAfterBytes = 0;
    private exitStatus?: number;
    private exportStatus?: string;
    private running?: { finish(code: number): void; done: Promise<void> };
    private logs: Record<string, Buffer> = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };

    constructor(readonly name: string, readonly id: string, private readonly client: FakeSpritesClient) {}

    private note(operation: string): void { this.client.operations.push(`${operation}:${this.name}`); }

    put(file: string, node: FakeNode): void {
        const parent = path.posix.dirname(file);
        if (parent !== file && !this.files.has(parent)) this.put(parent, { type: 'dir' });
        this.files.set(file, node);
    }

    putFile(file: string, content: string | Buffer, mtimeMs = Date.now()): void {
        this.put(file, { type: 'file', content: Buffer.from(content), mode: 0o600, mtimeMs });
    }

    remove(file: string): void {
        for (const key of [...this.files.keys()]) if (key === file || key.startsWith(`${file}/`)) this.files.delete(key);
    }

    paths(): string[] { return [...this.files.keys()].sort(); }

    /** Follows symlinks, as a server-side read would. */
    private resolve(file: string, depth = 0): FakeNode | undefined {
        const node = this.files.get(file);
        if (node?.type === 'symlink' && depth < 8) return this.resolve(node.target, depth + 1);
        return node;
    }

    filesystem() {
        return {
            readFile: async (file: string): Promise<Buffer> => {
                const node = this.resolve(file);
                if (!node) throw notFound(file);
                if (node.type !== 'file') throw new Error(`EISDIR or not a regular file: ${file}`);
                return Buffer.from(node.content);
            },
            writeFile: async (file: string, data: string | Buffer, options?: { mode?: number }): Promise<void> => {
                this.put(file, { type: 'file', content: Buffer.from(data), mode: options?.mode ?? 0o644, mtimeMs: Date.now() });
            },
            mkdir: async (directory: string): Promise<void> => { this.put(directory, { type: 'dir' }); },
            // lstat semantics: the entry itself, never what a symlink points to.
            stat: async (file: string) => {
                const node = this.files.get(file);
                if (!node) throw notFound(file);
                return {
                    size: node.type === 'file' ? node.content.length : 0,
                    isFile: () => node.type === 'file',
                    isDirectory: () => node.type === 'dir',
                    isSymbolicLink: () => node.type === 'symlink',
                };
            },
        };
    }

    private progress(messages: Array<{ type: string; error?: string }>) {
        return { async *[Symbol.asyncIterator]() { yield* messages; } };
    }

    async createCheckpoint(comment?: string) {
        const id = `v${this.checkpoints.length + 1}`;
        this.checkpoints.push({ id, comment, createTime: new Date(Date.now() + this.checkpoints.length), files: new Map(this.files) });
        this.note(`checkpoint:${id}`);
        return this.progress([{ type: 'info' }, { type: 'complete' }]);
    }

    async listCheckpoints() {
        return this.checkpoints.map(({ id, comment, createTime }) => ({ id, comment, createTime }));
    }

    async restoreCheckpoint(id: string) {
        const checkpoint = this.checkpoints.find(candidate => candidate.id === id);
        if (!checkpoint) throw new Error(`no checkpoint ${id}`);
        if (this.failRestores > 0) {
            this.failRestores--;
            this.note(`restore-failed:${id}`);
            return this.progress([{ type: 'error', error: 'restore failed' }]);
        }
        this.files.clear();
        for (const [file, node] of checkpoint.files) this.files.set(file, node);
        this.exitStatus = undefined;
        this.exportStatus = undefined;
        this.running = undefined;
        this.logs = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        this.note(`restore:${id}`);
        return this.progress([{ type: 'complete' }]);
    }

    private launcherArgs(command: string, args: string[]): string[] | undefined {
        this.commands.push([command, ...args]);
        const index = args.indexOf(FAKE_LAUNCHER);
        return command === 'sudo' && index >= 0 ? args.slice(index + 1) : undefined;
    }

    async execFile(command: string, args: string[] = []): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        const launcher = this.launcherArgs(command, args);
        const done = (exitCode: number, stdout = '', stderr = '') => ({ stdout, stderr, exitCode });
        if (launcher?.[0] === 'status') {
            return done(0, `running=${this.running ? 1 : 0}\nexit=${this.exitStatus ?? ''}\nexport=${this.exportStatus ?? ''}\n`);
        }
        if (launcher?.[0] === 'signal') {
            this.note(`signal-${launcher[1]}`);
            if (launcher[1] === 'KILL' && this.killFails) return done(1, '', 'processes of the node user survived SIGKILL');
            const running = this.running;
            running?.finish(launcher[1] === 'KILL' ? 137 : 143);
            await running?.done;
            return done(0);
        }
        if (command === 'sudo' && args.some(argument => argument.endsWith('/sprites-agent-setup.sh'))) return this.setup(args);
        return done(127, '', `fake Sprite: unknown command ${command} ${args.join(' ')}`);
    }

    private setup(args: string[]) {
        if (this.client.failSetups > 0) {
            this.client.failSetups--;
            return { stdout: '', stderr: 'ProPR Sprite setup: npm install failed', exitCode: 1 };
        }
        for (const file of ['sprites-agent-setup.sh', 'sprites-launcher.sh', 'claude-entrypoint.sh', 'codex-entrypoint.sh', 'antigravity-entrypoint.sh', 'gh-wrapper.sh']) {
            if (!this.files.has(`${SETUP_DIR}/${file}`)) return { stdout: '', stderr: `missing ${file}`, exitCode: 1 };
        }
        this.setupEnvironment = Object.fromEntries(args.filter(argument => /^[A-Z_0-9]+=/.test(argument)).map(argument => {
            const separator = argument.indexOf('=');
            return [argument.slice(0, separator), argument.slice(separator + 1)];
        }));
        this.remove(SETUP_DIR);
        for (const directory of ['/opt/propr/bin', '/opt/propr/entrypoints', FAKE_RUN_DIR, '/home/node/workspace']) this.put(directory, { type: 'dir' });
        this.putFile(FAKE_LAUNCHER, 'launcher', 0);
        this.putFile('/opt/propr/sprites-setup.hash', this.setupEnvironment.PROPR_SPRITES_SETUP_HASH ?? '', 0);
        this.note('setup');
        return { stdout: '', stderr: '', exitCode: 0 };
    }

    createSession(command: string, args: string[] = []): FakeCommand {
        const launcher = this.launcherArgs(command, args);
        return new FakeCommand(async () => {
            if (launcher?.[0] !== 'run') return 127;
            void this.runLauncher();
            return 0;
        });
    }

    spawn(command: string, args: string[] = []): FakeCommand {
        const launcher = this.launcherArgs(command, args);
        return new FakeCommand(async fake => {
            if (launcher?.[0] !== 'follow') return 127;
            const stream = launcher[1];
            const offset = Number(launcher[2]) - 1;
            for (let waited = 0; !this.running && this.exitStatus === undefined && waited < 200; waited++) await new Promise(resolve => setImmediate(resolve));
            if (!this.running && this.exitStatus === undefined) return 3;
            if (this.dropFollowers > 0) {
                this.dropFollowers--;
                fake.stdout.write(this.logs[stream].subarray(offset, offset + this.dropAfterBytes));
                await new Promise(resolve => setImmediate(resolve));
                return -1;
            }
            await this.running?.done;
            if (fake.closed) return -1;
            fake.stdout.write(this.logs[stream].subarray(offset));
            await new Promise(resolve => setImmediate(resolve));
            return 0;
        });
    }

    private async runLauncher(): Promise<void> {
        const behavior = this.behaviors.shift() ?? {};
        const pathsAtLaunch = this.paths();
        let finish!: (code: number) => void;
        const exit = new Promise<number>(resolve => { finish = resolve; });
        let settled!: () => void;
        this.running = { finish, done: new Promise<void>(resolve => { settled = resolve; }) };
        const end = (code: number, exported: string): void => {
            this.exportStatus = exported;
            this.exitStatus = code;
            this.running = undefined;
            settled();
        };
        const payload = this.files.get(`${FAKE_RUN_DIR}/payload.tar`);
        // The real launcher's invariants: a run directory that already holds a run is not the clean checkpoint.
        if (this.files.has(`${FAKE_RUN_DIR}/in`) || payload?.type !== 'file') {
            this.logs.stderr = Buffer.from('ProPR Sprites launcher: the Sprite is not at its clean checkpoint\n');
            return end(125, 'none');
        }
        const entries = parseTar(payload.content);
        const entry = (name: string) => entries.find(candidate => candidate.path === name && candidate.type === 'file')?.content;
        this.files.delete(`${FAKE_RUN_DIR}/payload.tar`);
        for (const directory of ['in', 'out', 'result']) this.put(`${FAKE_RUN_DIR}/${directory}`, { type: 'dir' });
        const manifest = nulList(entry('manifest'));
        const records: string[][] = [];
        const outputs: FakeRunContext['outputs'] = [];
        for (let index = 0; index < manifest.length;) {
            const kind = manifest[index];
            const length = kind === 'dir' ? 2 : 3;
            const record = manifest.slice(index, index + length);
            records.push(record);
            index += length;
            if (kind === 'store' || kind === 'source') {
                this.put(record[2], { type: 'dir' });
                for (const item of entries.filter(candidate => candidate.path.startsWith(`${record[1]}/`))) {
                    const target = `${record[2]}/${item.path.slice(record[1].length + 1)}`;
                    this.put(target, item.type === 'dir' ? { type: 'dir' } : { type: 'file', content: item.content, mode: item.mode, mtimeMs: item.mtimeMs });
                }
            } else if (kind === 'file') {
                this.put(record[2], { type: 'file', content: entry(record[1])!, mode: 0o440, mtimeMs: 0 });
            } else if (kind === 'dir') {
                this.put(record[1], { type: 'dir' });
            } else if (kind === 'output') {
                outputs.push({ index: Number(record[1]), livePath: record[2] });
            } else throw new Error(`fake launcher: unknown manifest record ${kind}`);
        }
        const stdin = entry('stdin')?.toString('utf8');
        const context: FakeRunContext = {
            sprite: this, argv: nulList(entry('argv')), records, outputs, pathsAtLaunch, ...(stdin === undefined ? {} : { stdin }),
            env: Object.fromEntries(nulList(entry('env')).map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])),
            write: (file, content, mtimeMs) => this.putFile(file, content, mtimeMs),
        };
        this.runs.push(context);
        this.note(`run:${context.env.PROPR_TEST_RUN ?? this.runs.length}`);
        this.logs = { stdout: Buffer.from(behavior.stdout ?? ''), stderr: Buffer.from(behavior.stderr ?? '') };
        behavior.act?.(context);
        if (behavior.resultStatus) this.putFile(`${FAKE_RUN_DIR}/result/status`, `${behavior.resultStatus}\n`);
        if (behavior.resultBundle) this.putFile(`${FAKE_RUN_DIR}/result/result.bundle`, behavior.resultBundle);
        const code = behavior.hang ? await exit : behavior.exitCode ?? 0;
        const exportState = behavior.exportState ?? 'ok';
        if (exportState === 'ok') {
            for (const output of outputs) {
                // Only a plain regular file at the live path is exported, as the launcher's unprivileged read does.
                const live = this.files.get(output.livePath);
                if (live?.type !== 'file') continue;
                this.putFile(`${FAKE_RUN_DIR}/out/${output.index}`, live.content);
                this.putFile(`${FAKE_RUN_DIR}/out/${output.index}.mtime`, `${Math.floor(live.mtimeMs / 1000)}\n`);
            }
        }
        behavior.tamper?.(context);
        end(code, exportState);
    }
}

export class FakeSpritesClient {
    readonly sprites = new Map<string, FakeSprite>();
    /** `create:<name>`, `setup:<name>`, `checkpoint:<id>:<name>`, `run:<n>:<name>`, `restore:<id>:<name>`, `delete:<name>`, in order. */
    readonly operations: string[] = [];
    /** Behaviours handed to Sprites as they are created, when a test cannot reach the Sprite first. */
    behaviors: FakeRunBehavior[] = [];
    failSetups = 0;
    private created = 0;

    async getSprite(name: string): Promise<FakeSprite> {
        const sprite = this.sprites.get(name);
        if (!sprite) throw Object.assign(new Error(`sprite ${name} not found (status 404)`), { statusCode: 404 });
        return sprite;
    }

    async createSprite(name: string, options?: unknown): Promise<FakeSprite> {
        if (this.sprites.has(name)) throw Object.assign(new Error(`sprite ${name} exists`), { statusCode: 409 });
        const sprite = new FakeSprite(name, `sprite-${++this.created}`, this);
        sprite.behaviors = this.behaviors;
        this.sprites.set(name, sprite);
        this.operations.push(`create:${name}`);
        this.createOptions.push(options);
        return sprite;
    }

    readonly createOptions: unknown[] = [];

    async deleteSprite(name: string): Promise<void> {
        if (!this.sprites.delete(name)) throw Object.assign(new Error(`sprite ${name} not found`), { statusCode: 404 });
        this.operations.push(`delete:${name}`);
    }
}
