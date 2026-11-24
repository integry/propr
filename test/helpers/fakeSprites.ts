import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Sprite } from '@fly/sprites';
import type { SpriteClient } from '../../packages/core/src/agents/runtime/sprites/spritesProvisioning.js';

async function* completed() { yield { type: 'complete' }; }

export class FakeSprite {
    files = new Map<string, Buffer>();
    baseline = new Map<string, Buffer>();
    launches: string[] = [];
    events: string[] = [];
    failRestore = false;
    failWipe = false;
    failExport = false;
    exitCode = 0;
    hold = false;
    pendingSpawn = false;
    exitBeforeOutputEnds = false;
    launched = Promise.withResolvers<void>();
    output = 'agent output';
    attachedOutput?: string;
    attachedStderr?: string;
    credential = '';
    stderr = '';
    constructor(readonly name: string) {}
    filesystem() {
        return {
            mkdir: async () => {},
            writeFile: async (p: string, b: string | Buffer) => { this.files.set(p, Buffer.from(b)); },
            rm: async (p: string) => { for (const key of this.files.keys()) if (key.startsWith(p + '/')) this.files.delete(key); },
            readFile: async (p: string) => this.files.get(p) ?? null,
        };
    }
    async restart() { this.events.push('restart'); }
    async execFile(cmd: string, args: string[], _options?: { signal?: AbortSignal }) {
        if (cmd === 'sudo' && args.join(' ') === '-n find /tmp -xdev -mindepth 1 -delete') {
            this.events.push('wipe');
            if (this.failWipe) throw new Error('wipe failed');
            for (const file of this.files.keys()) if (file.startsWith('/tmp/')) this.files.delete(file);
        }
        const action = args.includes('read-export') ? 'read-export' : args.at(-1);
        if (action === 'export' || action === 'read-export') this.events.push(action);
        if (action === 'export' && this.failExport) throw new Error('invalid export');
        const records = this.credential ? [{ index: 0, mtimeMs: Date.now(), content: Buffer.from(this.credential).toString('base64') }] : [];
        return { exitCode: 0, stdout: action === 'read-export' ? JSON.stringify(records) : '', stderr: '' };
    }
    async createCheckpoint() {
        this.events.push('checkpoint');
        this.baseline = new Map([...this.files].filter(([file]) => !file.startsWith('/tmp/')));
        return completed();
    }
    async listCheckpoints() { return [{ id: 'v1', comment: 'propr clean setup' }]; }
    async restoreCheckpoint(id: string) {
        if (id !== 'v1' || this.failRestore) throw new Error('restore failed');
        this.events.push('restore');
        this.files = new Map([...this.baseline, ...[...this.files].filter(([file]) => file.startsWith('/tmp/'))]);
        return completed();
    }
    async listSessions() { return [{ id: 'test-session', workdir: '/opt/propr/inbox', tty: false }]; }
    spawn(_cmd: string, args: string[], options?: { sessionId?: string }) {
        const cmd = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
            kill: () => setImmediate(() => cmd.emit('exit', 143)), close: () => {},
        });
        if (options?.sessionId === 'test-session') this.events.push('attach');
        else {
            this.launches.push(this.files.get(args.at(-1)!)!.toString());
            this.events.push('launch');
        }
        this.launched.resolve();
        setImmediate(() => {
            if (this.pendingSpawn) {
                cmd.stdout.end();
                cmd.stderr.end();
                return;
            }
            cmd.emit('spawn');
            const output = options?.sessionId ? this.attachedOutput ?? this.output : this.output;
            const stderr = options?.sessionId ? this.attachedStderr ?? this.stderr : this.stderr;
            cmd.stdout.write(output.slice(0, 4));
            if (this.exitBeforeOutputEnds) {
                cmd.emit('exit', this.exitCode);
                setImmediate(() => {
                    cmd.stdout.end(output.slice(4));
                    setImmediate(() => cmd.stderr.end(stderr));
                });
                return;
            }
            cmd.stdout.end(output.slice(4));
            cmd.stderr.end(stderr);
            if (!this.hold) cmd.emit('exit', options?.sessionId ? 0 : this.exitCode);
        });
        return cmd;
    }
}

export class FakeSprites implements SpriteClient {
    created: FakeSprite[] = [];
    deleted: string[] = [];
    setup = (_sprite: FakeSprite) => {};
    async createSprite(name: string): Promise<Sprite> {
        const sprite = new FakeSprite(name);
        this.setup(sprite);
        this.created.push(sprite);
        return sprite as unknown as Sprite;
    }
    async deleteSprite(name: string) { this.deleted.push(name); }
}
