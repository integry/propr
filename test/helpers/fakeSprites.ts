import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';

/**
 * An in-memory stand-in for `@fly/sprites`: a filesystem, the detachable
 * session running the ProPR launcher (emulated: its manifest, credential
 * install/return, result copy and exit status), and `tail --pid` followers.
 */

export class FakeCommand extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    private done = false;
    private resolveExit!: (code: number) => void;
    private readonly exit = new Promise<number>(resolve => { this.resolveExit = resolve; });
    constructor() {
        super();
        setImmediate(() => this.emit('spawn'));
    }
    wait(): Promise<number> { return this.exit; }
    kill(): void { /* signals go through the launcher PID */ }
    close(): void { this.finish(-1); }
    finish(code: number): void {
        if (this.done) return;
        this.done = true;
        this.stdout.end();
        this.stderr.end();
        this.resolveExit(code);
        this.emit('exit', code);
    }
}

export interface FakeAgentContext {
    argv: string[];
    env: Map<string, string>;
    stdin: string;
    write(stream: 'stdout' | 'stderr', text: string): void;
    files: Map<string, Buffer>;
    /** Resolves when the launcher received SIGTERM. */
    terminated: Promise<void>;
}

export type FakeAgent = (context: FakeAgentContext) => Promise<number>;

function nulList(buffer: Buffer | undefined): string[] {
    if (!buffer) return [];
    const text = buffer.toString('utf8');
    return text.split('\0').slice(0, -1);
}

function enoent(file: string): Error {
    return Object.assign(new Error(`no such file: ${file}`), { code: 'ENOENT' });
}

export class FakeSprite {
    readonly files = new Map<string, Buffer>();
    readonly modes = new Map<string, number>();
    readonly calls: Array<{ file: string; args: string[] }> = [];
    readonly checkpoints: Array<{ id: string; comment?: string }> = [];
    readonly restored: string[] = [];
    readonly signals: string[] = [];
    status = 'warm';
    agent: FakeAgent = async () => 0;
    /** Drop each follower connection once, after it delivered its first chunk. */
    dropFollowersOnce = false;
    keepAwakeFails = false;
    private readonly launchers = new Map<string, { running: boolean; terminate: () => void }>();
    private dropped = new Set<string>();

    constructor(readonly name: string) {}

    filesystem() {
        const files = this.files;
        return {
            readFile: async (file: string) => {
                const content = files.get(file);
                if (!content) throw enoent(file);
                return Buffer.from(content);
            },
            writeFile: async (file: string, data: string | Buffer, options?: { mode?: number }) => {
                files.set(file, Buffer.from(data));
                if (options?.mode !== undefined) this.modes.set(file, options.mode);
            },
            mkdir: async () => undefined,
            rm: async (file: string) => {
                for (const key of [...files.keys()]) if (key === file || key.startsWith(`${file}/`)) files.delete(key);
            },
            stat: async (file: string) => {
                const content = files.get(file);
                if (!content) throw enoent(file);
                return { size: content.length, mtime: new Date(), isFile: () => true };
            },
        };
    }

    async execFile(file: string, args: string[] = []) {
        this.calls.push({ file, args });
        if (file === 'true') {
            if (this.keepAwakeFails) throw new Error('sprite unreachable');
            return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (file === 'cat') {
            const content = this.files.get(args[0]);
            return { stdout: content?.toString() ?? '', stderr: content ? '' : 'missing', exitCode: content ? 0 : 1 };
        }
        if (file === 'sudo' && args.includes('env')) {
            const hash = args.find(arg => arg.startsWith('PROPR_SPRITES_SETUP_HASH='))!.split('=')[1];
            this.files.set('/opt/propr/sprites-setup.hash', Buffer.from(`${hash}\n`));
            return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (file === 'sudo' && args.includes('propr-signal')) {
            const signal = args[args.indexOf('propr-signal') + 1];
            this.signals.push(signal);
            this.launchers.get(path.posix.dirname(args[args.indexOf('propr-signal') + 2]))?.terminate();
            return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (file === 'sudo' && args.includes('propr-busy')) {
            return { stdout: '', stderr: '', exitCode: [...this.launchers.values()].some(launcher => launcher.running) ? 0 : 1 };
        }
        if (file === 'sudo' && args.includes('propr-probe')) {
            const root = path.posix.dirname(args[5]);
            return { stdout: '', stderr: '', exitCode: this.launchers.get(root)?.running ? 0 : 1 };
        }
        throw new Error(`unexpected exec ${file} ${args.join(' ')}`);
    }

    async listSessions() { return []; }
    async listCheckpoints() { return [...this.checkpoints]; }
    async createCheckpoint(comment?: string) {
        this.checkpoints.push({ id: `v${this.checkpoints.length + 1}`, comment });
        return (async function* () { yield { type: 'complete' }; })();
    }
    async restoreCheckpoint(id: string) {
        this.restored.push(id);
        return (async function* () { yield { type: 'complete' }; })();
    }

    createSession(command: string, args: string[] = []): FakeCommand {
        const session = new FakeCommand();
        if (command !== 'sudo' || args[1] !== '/bin/bash') throw new Error(`unexpected session ${command} ${args.join(' ')}`);
        const root = args[3];
        void this.runLauncher(root);
        return session;
    }

    private async runLauncher(root: string): Promise<void> {
        const at = (name: string) => `${root}/${name}`;
        let terminate!: () => void;
        const terminated = new Promise<void>(resolve => { terminate = resolve; });
        const launcher = { running: true, terminate };
        this.launchers.set(root, launcher);
        this.files.set(at('stdout.log'), Buffer.alloc(0));
        this.files.set(at('stderr.log'), Buffer.alloc(0));
        this.files.set(at('pid'), Buffer.from('4242\n'));
        const argv = nulList(this.files.get(at('argv')));
        const env = new Map(nulList(this.files.get(at('env'))).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
        this.files.delete(at('env'));
        const manifest = nulList(this.files.get(at('manifest')));
        const outputs: Array<[string, string]> = [];
        const installed: string[] = [];
        for (let index = 0; index < manifest.length;) {
            const kind = manifest[index];
            if (kind === 'purge') { this.filesystem().rm(manifest[index + 1]); index += 2; }
            else if (kind === 'store') {
                const source = at(manifest[index + 1]);
                const target = manifest[index + 2];
                for (const [file, content] of [...this.files]) if (file.startsWith(`${source}/`)) this.files.set(target + file.slice(source.length), content);
                installed.push(target);
                index += 3;
            } else if (kind === 'dir') index += 2;
            else if (kind === 'file') { this.files.set(manifest[index + 2], this.files.get(at(manifest[index + 1]))!); installed.push(manifest[index + 2]); index += 4; }
            else if (kind === 'output') { outputs.push([manifest[index + 1], at(manifest[index + 2])]); index += 3; }
            else throw new Error(`unknown manifest record ${kind}`);
        }
        const append = (stream: 'stdout' | 'stderr', text: string) => {
            const file = at(`${stream}.log`);
            this.files.set(file, Buffer.concat([this.files.get(file) ?? Buffer.alloc(0), Buffer.from(text)]));
        };
        let status: number;
        try {
            status = await this.agent({ argv, env, stdin: this.files.get(at('stdin'))?.toString() ?? '', write: append, files: this.files, terminated });
        } catch {
            status = 1;
        }
        for (const [source, returned] of outputs) if (this.files.has(source)) this.files.set(returned, this.files.get(source)!);
        for (const [file, content] of [...this.files]) {
            if (file.startsWith('/tmp/propr-workspace-result/')) this.files.set(`${at('result')}/${file.slice('/tmp/propr-workspace-result/'.length)}`, content);
        }
        for (const target of installed) this.filesystem().rm(target);
        this.files.set(at('exit-status'), Buffer.from(`${status}\n`));
        launcher.running = false;
    }

    spawn(command: string, args: string[] = []): FakeCommand {
        const follower = new FakeCommand();
        if (command !== 'bash' || args[2] !== 'propr-follow') throw new Error(`unexpected spawn ${command} ${args.join(' ')}`);
        let offset = Number(args[3]) - 1;
        const root = path.posix.dirname(args[4]);
        const log = args[5];
        const poll = setInterval(() => {
            const content = this.files.get(log) ?? Buffer.alloc(0);
            if (content.length > offset) {
                const chunk = content.subarray(offset);
                offset = content.length;
                follower.stdout.write(chunk);
                if (this.dropFollowersOnce && !this.dropped.has(log)) {
                    this.dropped.add(log);
                    clearInterval(poll);
                    setTimeout(() => follower.close(), 5);
                    return;
                }
            }
            if (!this.launchers.get(root)?.running && content.length <= offset) {
                clearInterval(poll);
                follower.finish(this.status === 'cold' ? -1 : 0);
            }
            if (this.status === 'cold') { clearInterval(poll); follower.close(); }
        }, 2);
        return follower;
    }
}

export class FakeSpritesClient {
    readonly sprites = new Map<string, FakeSprite>();
    readonly created: string[] = [];
    configureSprite: (sprite: FakeSprite) => void = () => undefined;

    sprite(name: string): FakeSprite {
        let sprite = this.sprites.get(name);
        if (!sprite) { sprite = new FakeSprite(name); this.configureSprite(sprite); this.sprites.set(name, sprite); }
        return sprite;
    }

    async getSprite(name: string): Promise<FakeSprite> {
        const sprite = this.sprites.get(name);
        if (!sprite) throw Object.assign(new Error(`Failed to get sprite (status 404): not found`), { statusCode: 404 });
        return sprite;
    }

    async createSprite(name: string): Promise<FakeSprite> {
        this.created.push(name);
        return this.sprite(name);
    }
}
