/**
 * Pure overlap computation between the changed-file sets of concurrent tasks
 * on one repository. Two tasks overlap on a path when both change it; for a
 * configured "hot" path (a directory prefix such as `db/migrations`), two tasks
 * also overlap when both change files in the same directory beneath it.
 */

export interface TaskChangedPaths {
    taskId: string;
    paths: readonly string[];
}

export interface TaskPairOverlap {
    /** Sorted, so the pair has one identity whichever task is compared first. */
    taskIds: [string, string];
    /** Shared file paths, then shared hot directories (ending in `/`), each sorted. */
    paths: string[];
}

export interface FileOverlapOptions {
    hotPaths?: readonly string[];
}

/** Most paths an event, notice or API entry lists; the total is reported beside it. */
export const MAX_OVERLAP_PATHS = 10;

function normalizePath(path: string): string {
    return path.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/** Hot path prefixes as directory prefixes ending in `/`; blanks dropped, duplicates removed. */
export function normalizeHotPaths(hotPaths: readonly string[] | string | undefined): string[] {
    const list = typeof hotPaths === 'string' ? hotPaths.split(',') : hotPaths ?? [];
    const normalized = list.map(normalizePath).map(path => path.replace(/\/+$/, '')).filter(Boolean).map(path => `${path}/`);
    return [...new Set(normalized)];
}

function parentDirectory(path: string): string {
    const index = path.lastIndexOf('/');
    return index < 0 ? '' : path.slice(0, index + 1);
}

function hotDirectories(paths: Set<string>, hotPaths: string[]): Set<string> {
    const directories = new Set<string>();
    if (!hotPaths.length) return directories;
    for (const path of paths) {
        const directory = parentDirectory(path);
        if (directory && hotPaths.some(hot => directory.startsWith(hot))) directories.add(directory);
    }
    return directories;
}

/**
 * Every pair of distinct tasks whose changes overlap, with the shared paths.
 * Entries for the same task id are merged; empty sets never overlap.
 */
export function computeFileOverlaps(tasks: readonly TaskChangedPaths[], options: FileOverlapOptions = {}): TaskPairOverlap[] {
    const hotPaths = normalizeHotPaths(options.hotPaths);
    const byTask = new Map<string, Set<string>>();
    for (const task of tasks) {
        const paths = byTask.get(task.taskId) ?? new Set<string>();
        for (const path of task.paths) {
            const normalized = normalizePath(path);
            if (normalized) paths.add(normalized);
        }
        byTask.set(task.taskId, paths);
    }
    const entries = [...byTask.entries()]
        .filter(([, paths]) => paths.size > 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([taskId, paths]) => ({ taskId, paths, directories: hotDirectories(paths, hotPaths) }));
    const overlaps: TaskPairOverlap[] = [];
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const [a, b] = [entries[i], entries[j]];
            const sharedPaths = [...a.paths].filter(path => b.paths.has(path)).sort();
            // A shared hot directory adds information only when no shared file already sits in it.
            const sharedDirectories = [...a.directories]
                .filter(directory => b.directories.has(directory) && !sharedPaths.some(path => parentDirectory(path) === directory))
                .sort();
            const paths = [...sharedPaths, ...sharedDirectories];
            if (paths.length) overlaps.push({ taskIds: [a.taskId, b.taskId], paths });
        }
    }
    return overlaps;
}

/** One task's view of a pair: the other task and the shared paths. */
export function overlapsForTask(overlaps: readonly TaskPairOverlap[], taskId: string): Array<{ otherTaskId: string; paths: string[] }> {
    return overlaps
        .filter(overlap => overlap.taskIds.includes(taskId))
        .map(overlap => ({ otherTaskId: overlap.taskIds[0] === taskId ? overlap.taskIds[1] : overlap.taskIds[0], paths: overlap.paths }));
}

/** At most `max` paths, with the full count so readers can say how many were left out. */
export function boundOverlapPaths(paths: readonly string[], max = MAX_OVERLAP_PATHS): { paths: string[]; totalPaths: number } {
    return { paths: paths.slice(0, max), totalPaths: paths.length };
}

/** "`a`, `b` and 3 more" — a bounded, human-readable path list. */
export function describeOverlapPaths(paths: readonly string[], totalPaths = paths.length): string {
    const listed = paths.map(path => `\`${path.replace(/`/g, "'")}\``).join(', ');
    const more = totalPaths - paths.length;
    return more > 0 ? `${listed} and ${more} more` : listed;
}
