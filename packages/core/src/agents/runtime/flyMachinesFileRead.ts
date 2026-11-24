import path from 'node:path';
import { parseFlyStat, type FlyMachinesClient } from './flyMachinesApi.js';
import type { AgentRunFileRead } from './types.js';

/** Reading files from a lingering Fly Machine through the exec API (base64 over the exec stdout). */

export type ExecRead = AgentRunFileRead | 'oversized' | null;

const EXEC_READ_CHUNK_BYTES = 3 * 1024 * 1024;
/** A credential read is one exec (stat and content from one descriptor); larger limits are refused. */
const MAX_CREDENTIAL_READ_BYTES = 2 * 1024 * 1024;

/**
 * Reads `$2` in the directory `$1` of the Machine, refusing (exit 4) a path
 * with a symlink in any component: the shell enters the directory physically
 * and checks it is `$1` itself, then opens the name and checks the descriptor
 * is that very path, so a link swapped in after the checks is caught too.
 * The stat and the content come from that descriptor. Exit 3: missing; 6:
 * larger than `$3` (after the stat line, before any content).
 */
const CONFINED_READ_SCRIPT = [
    'cd -P -- "$1" 2>/dev/null || exit 3',
    '[ "$(pwd -P)" = "$1" ] || exit 4',
    '[ -L "$2" ] && exit 4',
    '[ -e "$2" ] || exit 3',
    '[ -f "$2" ] || exit 4',
    'exec 3<"$2" || exit 3',
    '[ "$(readlink "/proc/$$/fd/3")" = "$1/$2" ] || exit 4',
    'st=$(stat -L -c "%s %Y %y" "/proc/$$/fd/3") || exit 1',
    'printf "%s\\n" "$st"',
    '[ "${st%% *}" -le "$3" ] || exit 6',
    'head -c "$(($3 + 1))" <&3 | base64 | tr -d "\\n"',
].join('\n');

/**
 * A file from the Machine (base64, in chunks), with its modification time;
 * null when it does not exist. `tail` reads only the file's last bytes; a
 * file larger than `limit` is refused right after the stat, before any
 * content is transferred. Follows symlinks: not for paths the run controls
 * that must stay inside a directory (see {@link readConfinedMachineFile}).
 */
export async function readMachineFile(client: FlyMachinesClient, id: string, filePath: string, bounds: { tail?: number; limit?: number } = {}): Promise<ExecRead> {
    const sized = await client.exec(id, ['/bin/sh', '-c', '[ -f "$1" ] || exit 3; stat -c "%s %Y %y" "$1"', 'sh', filePath], 30);
    if (sized.exit_code === 3) return null;
    const stat = parseFlyStat(sized.stdout);
    if (sized.exit_code !== 0 || !stat) throw new Error(`Could not stat ${filePath} in Fly Machine ${id}: ${sized.stderr.trim() || `exit ${sized.exit_code}`}`);
    const { size, mtimeMs } = stat;
    if (bounds.limit !== undefined && size > bounds.limit) return 'oversized';
    const chunks: Buffer[] = [];
    let total = 0;
    for (let offset = bounds.tail && size > bounds.tail ? size - bounds.tail : 0; offset < size; offset += EXEC_READ_CHUNK_BYTES) {
        const length = Math.min(EXEC_READ_CHUNK_BYTES, size - offset);
        const read = await client.exec(id, ['/bin/sh', '-c', 'tail -c +"$(($2 + 1))" "$1" | head -c "$3" | base64 | tr -d "\\n"', 'sh', filePath, String(offset), String(length)], 60);
        if (read.exit_code !== 0) throw new Error(`Could not read ${filePath} from Fly Machine ${id}: ${read.stderr.trim() || `exit ${read.exit_code}`}`);
        const chunk = Buffer.from(read.stdout.trim(), 'base64');
        total += chunk.length;
        // The file may have grown since the stat: never hold more than it reported.
        if (bounds.limit !== undefined && total > bounds.limit) return 'oversized';
        chunks.push(chunk);
    }
    return { content: Buffer.concat(chunks), mtimeMs };
}

export interface ConfinedPath { directory: string; name: string }

/** `root/relative` split for {@link readConfinedMachineFile}; throws unless `relative` is a plain path below the absolute `root`. */
export function confinedCredentialPath(root: string, relative: string, maxBytes: number): ConfinedPath {
    const segments = relative.split('/');
    if (!path.posix.isAbsolute(root) || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`Credential path ${relative} is not a plain path inside the store ${root}`);
    }
    if (maxBytes > MAX_CREDENTIAL_READ_BYTES) throw new Error(`Credential reads are limited to ${MAX_CREDENTIAL_READ_BYTES} bytes`);
    const directory = path.posix.join(path.posix.normalize(root), ...segments.slice(0, -1)).replace(/(.)\/+$/, '$1');
    return { directory, name: segments[segments.length - 1] };
}

/**
 * The regular file `target` from the Machine, in one exec, never through a
 * symlink: `'refused'` when a component of its path is one (or it is not a
 * regular file), null when it does not exist, `'oversized'` past `maxBytes`.
 */
export async function readConfinedMachineFile(client: FlyMachinesClient, id: string, target: ConfinedPath, maxBytes: number): Promise<ExecRead | 'refused'> {
    const read = await client.exec(id, ['/bin/sh', '-c', CONFINED_READ_SCRIPT, 'sh', target.directory, target.name, String(maxBytes)], 60);
    if (read.exit_code === 3) return null;
    if (read.exit_code === 4) return 'refused';
    if (read.exit_code === 6) return 'oversized';
    const newline = read.stdout.indexOf('\n');
    const stat = newline < 0 ? undefined : parseFlyStat(read.stdout.slice(0, newline));
    if (read.exit_code !== 0 || !stat) {
        throw new Error(`Could not read ${path.posix.join(target.directory, target.name)} from Fly Machine ${id}: ${read.stderr.trim() || `exit ${read.exit_code}`}`);
    }
    const content = Buffer.from(read.stdout.slice(newline + 1).trim(), 'base64');
    // Read through the same descriptor up to one byte past the limit: a file that grew after the stat is refused.
    if (content.length > maxBytes) return 'oversized';
    return { content, mtimeMs: stat.mtimeMs };
}
