/**
 * A minimal tar writer (ustar, with GNU long names) for the run payload: one
 * archive through the Sprites filesystem API instead of one request per file.
 * It writes only directories and regular files, which is all the launcher
 * unpacks; entries are owned by root (the launcher extracts with
 * `--no-same-owner` anyway).
 */
export interface TarEntry {
    /** POSIX path relative to the archive root. */
    path: string;
    type: 'file' | 'directory';
    content?: Buffer;
    mode: number;
    mtimeMs?: number;
}

const BLOCK = 512;

function assertEntryPath(entryPath: string): void {
    if (!entryPath || entryPath.startsWith('/') || entryPath.includes('\0') || entryPath.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid payload path: ${JSON.stringify(entryPath)}`);
    }
}

function octal(value: number, length: number): string {
    return `${Math.floor(value).toString(8).padStart(length - 1, '0')}\0`;
}

function header(name: Buffer, entry: { type: string; size: number; mode: number; mtimeSeconds: number }): Buffer {
    const block = Buffer.alloc(BLOCK);
    name.copy(block, 0, 0, Math.min(name.length, 100));
    block.write(octal(entry.mode & 0o7777, 8), 100, 'ascii');
    block.write(octal(0, 8), 108, 'ascii');
    block.write(octal(0, 8), 116, 'ascii');
    block.write(octal(entry.size, 12), 124, 'ascii');
    block.write(octal(entry.mtimeSeconds, 12), 136, 'ascii');
    block.write('        ', 148, 'ascii');
    block.write(entry.type, 156, 'ascii');
    block.write('ustar\0', 257, 'ascii');
    block.write('00', 263, 'ascii');
    block.write('root', 265, 'ascii');
    block.write('root', 297, 'ascii');
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return block;
}

function padded(content: Buffer): Buffer[] {
    const remainder = content.length % BLOCK;
    return remainder === 0 ? [content] : [content, Buffer.alloc(BLOCK - remainder)];
}

export function createTarArchive(entries: readonly TarEntry[]): Buffer {
    const blocks: Buffer[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        assertEntryPath(entry.path);
        if (seen.has(entry.path)) throw new Error(`Duplicate payload path: ${entry.path}`);
        seen.add(entry.path);
        const name = entry.type === 'directory' ? `${entry.path}/` : entry.path;
        const content = entry.type === 'file' ? entry.content ?? Buffer.alloc(0) : Buffer.alloc(0);
        const mtimeSeconds = Math.max(0, Math.floor((entry.mtimeMs ?? 0) / 1000));
        const nameBytes = Buffer.from(name, 'utf8');
        if (nameBytes.length > 100) {
            // GNU long name: the full name travels as the data of an `L` entry before the real one (whose own name is cut).
            const longName = Buffer.concat([nameBytes, Buffer.from([0])]);
            blocks.push(header(Buffer.from('././@LongLink'), { type: 'L', size: longName.length, mode: 0o644, mtimeSeconds: 0 }), ...padded(longName));
        }
        blocks.push(header(nameBytes, { type: entry.type === 'directory' ? '5' : '0', size: content.length, mode: entry.mode, mtimeSeconds }));
        if (content.length > 0) blocks.push(...padded(content));
    }
    blocks.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(blocks);
}
