import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACE_TRANSPORT_RESULT_DIR } from '../../../git/workspaceTransportScript.js';
import { DOCKER_CONTAINER_FILE_LIMIT_BYTES } from '../dockerContainerFiles.js';
import type { MachinesApi } from './api.js';
import { helper } from './launch.js';
import { RUN } from './wrapper.js';

export const OUTPUT_READ_LIMIT = 16 * 1024 * 1024;
const CHUNK = 256 * 1024;

/** Stat once, then scan fixed byte ranges. A short or missing read never
 * becomes an empty stream. The caller bounds retained output independently. */
export async function scanFile(api: MachinesApi, id: string, file: string, consume: (chunk: Buffer) => void | Promise<void>,
    limit: number, tail = false) {
    const stat = await api.exec(id, [...helper, 'size', file]);
    if (stat.exit_code === 44) return null;
    const size = Number(stat.stdout.trim());
    if (stat.exit_code !== 0 || !/^\d+$/.test(stat.stdout.trim()) || !Number.isSafeInteger(size) || (!tail && size > limit))
        throw new Error('Invalid Fly file size for ' + file);
    const start = tail ? Math.max(0, size - limit) : 0;
    let discardFragment = start > 0;
    for (let offset = start; offset < size; offset += CHUNK) {
        const length = Math.min(size - offset, CHUNK);
        const read = await api.exec(id, [...helper, 'chunk', file, String(offset), String(length)]);
        const chunk = Buffer.from(read.stdout.trim(), 'base64');
        if (read.exit_code !== 0 || chunk.length !== length || chunk.toString('base64') !== read.stdout.trim())
            throw new Error('Incomplete Fly file read for ' + file);
        if (discardFragment) {
            const end = chunk.indexOf(10);
            if (end < 0) continue;
            discardFragment = false;
            await consume(chunk.subarray(end + 1));
        } else await consume(chunk);
    }
    return size;
}

/** Keep the clone transport's recovery copy on the worker, freeing the VM
 * even when applying a bundle fails and the transport retains the result. */
export class WorkspaceFiles {
    location?: string;

    async collect(api: MachinesApi, id: string) {
        const chunks: Buffer[] = [];
        const size = await scanFile(api, id, RUN + '/workspace/status', chunk => { chunks.push(chunk); }, 4096);
        const status = Buffer.concat(chunks);
        this.location = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-fly-result-'));
        if (!/^(pushed|failed)\s/.test(status.toString())) {
            const target = path.join(this.location, 'result.bundle');
            const pending = target + '.part';
            const bundle = await fs.open(pending, 'wx', 0o600);
            try {
                const bytes = await scanFile(api, id, RUN + '/workspace/result.bundle', chunk => bundle.writeFile(chunk),
                    DOCKER_CONTAINER_FILE_LIMIT_BYTES);
                if (bytes !== null) await fs.rename(pending, target);
                else if (/^bundle\s/.test(status.toString())) throw new Error('Fly workspace bundle unavailable');
            } finally {
                await bundle.close();
                await fs.rm(pending, { force: true });
            }
        }
        if (size !== null) await fs.writeFile(path.join(this.location, 'status'), status, { mode: 0o600 });
    }

    async read(file: string) {
        const name = ['status', 'result.bundle'].find(n => file === WORKSPACE_TRANSPORT_RESULT_DIR + '/' + n);
        if (!this.location || !name) return null;
        try { return await fs.readFile(path.join(this.location, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }

    async release() {
        if (this.location) await fs.rm(this.location, { recursive: true, force: true });
        this.location = undefined;
    }
}
