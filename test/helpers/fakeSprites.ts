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
    failExport = false;
    exitCode = 0;
    hold = false;
    launched = Promise.withResolvers<void>();
    output = 'agent output';
    credential = '';
    constructor(readonly name: string) {}
    filesystem() {
        return {
            mkdir: async () => {},
            writeFile: async (p: string, b: string | Buffer) => { this.files.set(p, Buffer.from(b)); },
            rm: async (p: string) => { for (const key of this.files.keys()) if (key.startsWith(p + '/')) this.files.delete(key); },
            readFile: async (p: string) => this.files.get(p) ?? null,
        };
    }
    async execFile(_cmd: string, args: string[], _options?: { signal?: AbortSignal }) {
        const action = args.includes('read-export') ? 'read-export' : args.at(-1);
        if (action === 'export' || action === 'read-export') this.events.push(action);
        if (action === 'export' && this.failExport) throw new Error('invalid export');
        const records = this.credential ? [{ index: 0, mtimeMs: Date.now(), content: Buffer.from(this.credential).toString('base64') }] : [];
        return { exitCode: 0, stdout: action === 'read-export' ? JSON.stringify(records) : '', stderr: '' };
    }
    async createCheckpoint() {
        this.events.push('checkpoint');
        this.baseline = new Map(this.files);
        return completed();
    }
    async listCheckpoints() { return [{ id: 'v1', comment: 'propr clean setup' }]; }
    async restoreCheckpoint(id: string) {
        if (id !== 'v1' || this.failRestore) throw new Error('restore failed');
        this.events.push('restore');
        this.files = new Map(this.baseline);
        return completed();
    }
    spawn(_cmd: string, args: string[]) {
        const cmd = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
            kill: () => setImmediate(() => cmd.emit('exit', 143)), close: () => {},
        });
        this.launches.push(this.files.get(args.at(-1)!)!.toString());
        this.events.push('launch');
        this.launched.resolve();
        setImmediate(() => {
            cmd.emit('spawn');
            cmd.stdout.write(this.output.slice(0, 4));
            cmd.stdout.end(this.output.slice(4));
            cmd.stderr.end();
            if (!this.hold) cmd.emit('exit', this.exitCode);
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
