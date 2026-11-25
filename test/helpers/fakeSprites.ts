import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { CreateSpriteOptions, Sprite, SpriteConfig } from '@fly/sprites';
import type { SpriteClient } from '../../packages/core/src/agents/runtime/sprites/spritesProvisioning.js';
import { CLEAN_CHECKPOINT_COMMENT } from '../../packages/core/src/agents/runtime/sprites/spritesProvisioning.js';

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
    failHealth = false;
    resultDirectoryCompleted = false;
    healthChecks = 0;
    labels: string[] = [];
    createdAt = new Date();
    checkpoints: Array<{ id: string; comment: string; files: Map<string, Buffer> }> = [];
    stderr = '';
    networkPolicy: { rules: unknown[] } = { rules: [] };
    policies: Array<{ rules: unknown[] }> = [];
    failPolicy = false;
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
    async updateNetworkPolicy(policy: { rules: unknown[] }) {
        if (this.failPolicy) throw new Error('policy update failed');
        this.events.push(policy.rules.length ? 'restrict' : 'open');
        this.policies.push(policy);
        this.networkPolicy = structuredClone(policy);
    }
    async getNetworkPolicy() { return structuredClone(this.networkPolicy); }
    async execFile(cmd: string, args: string[], _options?: { signal?: AbortSignal }) {
        if (cmd === 'sudo' && args[1] === '/usr/bin/python3' && args[3] === '-c') {
            const present = this.resultDirectoryCompleted || [...this.files.keys()].some(file => file.startsWith('/opt/propr/result/'));
            return { exitCode: 0, stdout: present ? 'keep' : 'absent', stderr: '' };
        }
        if (cmd === '/bin/true') {
            this.healthChecks += 1;
            if (this.failHealth) throw new Error('Sprite unreachable');
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (cmd === 'sudo' && args[1] === '/bin/bash' && ['carry', 'install'].includes(args[4])) {
            const [, , , , action, ref, carry] = args;
            this.events.push(action);
            if (action === 'carry') {
                if (!this.files.has(ref + '/objects')) return { exitCode: 0, stdout: '', stderr: '' };
                this.files.set(carry + '/repo.git/objects', this.files.get(ref + '/objects')!);
                this.files.delete(ref + '/objects');
                return { exitCode: 0, stdout: 'carried\n', stderr: '' };
            }
            for (const file of [...this.files.keys()]) if (file.startsWith('/var/lib/propr/warm/')) this.files.delete(file);
            this.files.set(ref + '/objects', this.files.get(carry + '/repo.git/objects')!);
            this.files.delete(carry + '/repo.git/objects');
            return { exitCode: 0, stdout: '', stderr: '' };
        }
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
    async createCheckpoint(comment = '') {
        const files = new Map([...this.files].filter(([file]) => !file.startsWith('/tmp/')));
        this.events.push(comment === CLEAN_CHECKPOINT_COMMENT ? 'checkpoint' : 'warm-checkpoint');
        this.checkpoints.push({ id: `v${this.checkpoints.length + 1}`, comment, files });
        if (comment === CLEAN_CHECKPOINT_COMMENT) this.baseline = files;
        return completed();
    }
    async listCheckpoints() { return this.checkpoints.map(({ id, comment }) => ({ id, comment })); }
    async restoreCheckpoint(id: string) {
        const checkpoint = this.checkpoints.find(cp => cp.id === id);
        if (!checkpoint || this.failRestore) throw new Error('restore failed');
        this.events.push(id === 'v1' ? 'restore' : 'restore-warm');
        this.files = new Map([...checkpoint.files, ...[...this.files].filter(([file]) => file.startsWith('/tmp/'))]);
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
    /** Sprites in the organization that this client did not create (other workers, earlier incarnations). */
    foreign: FakeSprite[] = [];
    setup = (_sprite: FakeSprite) => {};
    async createSprite(name: string, options?: SpriteConfig | CreateSpriteOptions): Promise<Sprite> {
        const sprite = new FakeSprite(name);
        sprite.labels = (options as CreateSpriteOptions | undefined)?.labels ?? [];
        this.setup(sprite);
        this.created.push(sprite);
        return sprite as unknown as Sprite;
    }
    async deleteSprite(name: string) { this.deleted.push(name); }
    async getSprite(name: string): Promise<Sprite> {
        const sprite = (await this.listAllSprites(name)).find(candidate => candidate.name === name);
        if (!sprite) throw Object.assign(new Error('Sprite not found'), { statusCode: 404 });
        return sprite;
    }
    sprite(name: string): Sprite {
        const sprite = [...this.created, ...this.foreign].find(candidate => candidate.name === name);
        if (!sprite) throw new Error(`unknown Sprite ${name}`);
        return sprite as unknown as Sprite;
    }
    async listAllSprites(prefix?: string): Promise<Sprite[]> {
        return [...this.created, ...this.foreign]
            .filter(sprite => !this.deleted.includes(sprite.name) && sprite.name.startsWith(prefix ?? '')) as unknown as Sprite[];
    }
}
