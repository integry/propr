import path from 'path';

/**
 * Docker Compose sets PROPR_DATA_MOUNT to the directory it bind-mounts for
 * durable state. A relative DB_FILENAME resolves from the working directory,
 * so with a custom PROPR_DATA_DIR it lands on unmounted container storage and
 * the database would silently vanish with the container. Refuse that pairing.
 * Absolute filenames are an explicit choice and are left alone.
 */
export function assertRelativeDatabaseOnDataMount(
    filename: string, mount: string | undefined = process.env.PROPR_DATA_MOUNT, cwd: string = process.cwd(),
): void {
    if (!mount || path.isAbsolute(filename) || filename === ':memory:' || filename.startsWith('file:')) return;
    const resolved = path.resolve(cwd, filename);
    const relative = path.relative(path.resolve(mount), resolved);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return;
    throw new Error(`DB_FILENAME '${filename}' resolves to ${resolved}, outside the mounted data directory ${mount}. `
        + `Set DB_FILENAME to an absolute path inside PROPR_DATA_DIR (for example ${path.join(mount, 'propr.sqlite')}).`);
}
