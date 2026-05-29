function truncate(value: string, maxLength = 1200): string {
    return value.length > maxLength ? `${value.substring(0, maxLength)}...` : value;
}

function unquoteDiffPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
    try {
        return JSON.parse(trimmed) as string;
    } catch {
        return trimmed.substring(1, trimmed.length - 1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
}

function normalizeDiffPath(path: string): string {
    return unquoteDiffPath(path).replace(/^a\//, '').replace(/^b\//, '').trim();
}

function splitDiffHeaderArgs(value: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuotes = false;
    let escaping = false;

    for (const char of value) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }
        if (char === '\\' && inQuotes) {
            current += char;
            escaping = true;
            continue;
        }
        if (char === '"') {
            current += char;
            inQuotes = !inQuotes;
            continue;
        }
        if (/\s/.test(char) && !inQuotes) {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }

    if (current) args.push(current);
    return args;
}

export function diffBlockPaths(header: string): string[] {
    const gitHeader = header.match(/^diff --git\s+(.+)$/);
    if (gitHeader) {
        const paths = splitDiffHeaderArgs(gitHeader[1]);
        return paths.slice(0, 2).map(normalizeDiffPath);
    }

    const combinedHeader = header.match(/^diff --(?:cc|combined)\s+(.+)$/);
    if (combinedHeader) return [normalizeDiffPath(combinedHeader[1])];

    return [];
}

export function diffPatchPath(line: string): string | null {
    const patchHeader = line.match(/^(?:---|\+\+\+)\s+(.+)$/);
    if (!patchHeader || patchHeader[1] === '/dev/null') return null;
    return normalizeDiffPath(patchHeader[1]);
}

function blockReferencesWantedFile(lines: string[], wanted: Set<string>): boolean {
    return lines.some(line => {
        const path = diffPatchPath(line);
        return path !== null && wanted.has(path);
    });
}

function isDiffBlockHeader(line: string): boolean {
    return /^diff --(?:git|cc|combined)\s/.test(line);
}

export function filterDiffToFiles(diff: string, filePaths: string[]): string {
    const wanted = new Set(filePaths.map(normalizeDiffPath));
    if (wanted.size === 0 || !diff.trim()) return '';

    const lines = diff.split('\n');
    const blocks: string[] = [];
    let current: string[] = [];
    let includeCurrent = false;
    let currentHeaderPaths: string[] = [];
    let sawDiffHeader = false;

    for (const line of lines) {
        if (isDiffBlockHeader(line)) {
            sawDiffHeader = true;
            if (current.length > 0 && includeCurrent) blocks.push(current.join('\n'));
            current = [line];
            currentHeaderPaths = diffBlockPaths(line);
            includeCurrent = currentHeaderPaths.some(path => wanted.has(path));
        } else if (current.length > 0) {
            current.push(line);
            const patchPath = diffPatchPath(line);
            if (!includeCurrent && currentHeaderPaths.length === 0 && patchPath && wanted.has(patchPath)) {
                includeCurrent = true;
            }
        }
    }

    if (current.length > 0 && includeCurrent) blocks.push(current.join('\n'));
    if (blocks.length === 0 && !sawDiffHeader && blockReferencesWantedFile(lines, wanted)) return diff;
    return blocks.join('\n');
}

function scoreConflictDiff(diff: string): number {
    return (diff.includes('<<<<<<<') ? 8 : 0) + (diff.includes('diff --cc') || diff.includes('diff --combined') ? 4 : 0)
        + (diff.includes('@@@') ? 3 : 0) + (diff.includes('@@') ? 1 : 0) + Math.min(diff.length, 2000) / 2000;
}

type ExecFileAsync = (
    file: string,
    args: string[],
    options: { cwd: string; encoding: BufferEncoding; maxBuffer: number }
) => Promise<{ stdout: string | Buffer }>;

async function getConflictStageText(execFileAsync: ExecFileAsync, worktreePath: string, stage: number, filePath: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['show', `:${stage}:${filePath}`], {
            cwd: worktreePath,
            encoding: 'utf8',
            maxBuffer: 512 * 1024,
        });
        return String(stdout).trim();
    } catch {
        return '';
    }
}

async function getUnmergedConflictContext(execFileAsync: ExecFileAsync, worktreePath: string, conflictedFiles: string[]): Promise<string> {
    const sections: string[] = [];
    try {
        const { stdout } = await execFileAsync('git', ['ls-files', '-u', '--', ...conflictedFiles], {
            cwd: worktreePath,
            encoding: 'utf8',
            maxBuffer: 512 * 1024,
        });
        const entries = String(stdout).trim();
        if (entries) sections.push(`Unmerged index entries:\n${truncate(entries, 2000)}`);
    } catch {
        // Some git versions expose less unmerged detail; fall back to stage blobs below.
    }

    for (const filePath of conflictedFiles.slice(0, 5)) {
        const ours = await getConflictStageText(execFileAsync, worktreePath, 2, filePath);
        const theirs = await getConflictStageText(execFileAsync, worktreePath, 3, filePath);
        if (!ours && !theirs) continue;
        sections.push([
            `Unmerged file: ${filePath}`,
            '<<<<<<< ours',
            truncate(ours || '(deleted)', 1200),
            '=======',
            truncate(theirs || '(deleted)', 1200),
            '>>>>>>> theirs',
        ].join('\n'));
    }

    return sections.join('\n\n');
}

export async function getConflictDiffForTitle(worktreePath: string, conflictedFiles?: string[]): Promise<string> {
    if (!conflictedFiles || conflictedFiles.length === 0) return '';
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile) as ExecFileAsync;

    let bestDiff = '';
    for (const args of [
        ['diff', '--merge', '--', ...conflictedFiles],
        ['diff', '--', ...conflictedFiles],
        ['diff', '--cc', '--', ...conflictedFiles],
    ]) {
        try {
            const { stdout } = await execFileAsync('git', args, {
                cwd: worktreePath,
                encoding: 'utf8',
                maxBuffer: 2 * 1024 * 1024,
            });
            const filtered = filterDiffToFiles(String(stdout), conflictedFiles);
            if (filtered.trim() && scoreConflictDiff(filtered) > scoreConflictDiff(bestDiff)) bestDiff = filtered;
        } catch {
            // Try the next diff mode; git versions and conflict states differ here.
        }
    }
    if (bestDiff.trim()) return bestDiff;
    return getUnmergedConflictContext(execFileAsync, worktreePath, conflictedFiles);
}
