import { execFile } from 'node:child_process';

const COPY_TIMEOUT_MS = 60_000;
/** Largest file the runtime file API returns (a result bundle of a large change). */
export const DOCKER_CONTAINER_FILE_LIMIT_BYTES = 512 * 1024 * 1024;
const TAR_BLOCK = 512;

function tarString(header: Buffer, offset: number, length: number): string {
    const field = header.subarray(offset, offset + length);
    const end = field.indexOf(0);
    return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function tarSize(header: Buffer): number {
    // GNU base-256 encoding for sizes beyond the octal field.
    if (header[124] & 0x80) {
        let size = 0;
        for (let index = 125; index < 136; index++) size = size * 256 + header[index];
        return size;
    }
    const octal = tarString(header, 124, 12).trim();
    return octal ? parseInt(octal, 8) : 0;
}

/**
 * The first regular file in a tar stream (`docker cp <container>:<file> -`
 * writes exactly one), or null when the archive holds none.
 */
export function extractSingleFileFromTar(archive: Buffer): Buffer | null {
    let offset = 0;
    while (offset + TAR_BLOCK <= archive.length) {
        const header = archive.subarray(offset, offset + TAR_BLOCK);
        if (header.every(byte => byte === 0)) return null;
        const size = tarSize(header);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid tar entry size');
        const type = String.fromCharCode(header[156] || 0x30);
        const start = offset + TAR_BLOCK;
        if (start + size > archive.length) throw new Error('Truncated tar archive');
        if (type === '0' || type === '\0') return Buffer.from(archive.subarray(start, start + size));
        offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    }
    return null;
}

/** A file from a (stopped) container through `docker cp`, or null when it does not exist. */
export function readDockerContainerFile(
    container: string,
    filePath: string,
    dockerEnvironment?: Readonly<Record<string, string>>,
): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
        execFile('docker', ['cp', `${container}:${filePath}`, '-'], {
            encoding: 'buffer', timeout: COPY_TIMEOUT_MS, maxBuffer: DOCKER_CONTAINER_FILE_LIMIT_BYTES + 64 * 1024,
            env: dockerEnvironment ? { ...process.env, ...dockerEnvironment } : process.env,
        }, (error, stdout, stderr) => {
            if (error) {
                const message = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
                if (/Could not find the file|No such container|no such file/i.test(message)) { resolve(null); return; }
                reject(new Error(`docker cp ${container}:${filePath} failed: ${message.trim() || error.message}`));
                return;
            }
            try { resolve(extractSingleFileFromTar(stdout)); } catch (parseError) { reject(parseError as Error); }
        });
    });
}
