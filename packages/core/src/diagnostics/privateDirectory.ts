import fs from 'node:fs';
import path from 'node:path';
import { ProviderEntryOwnershipError } from './providerOwnership.js';

const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
/** Linux openat equivalent using pinned descriptors; never re-resolve an ancestor. */
export class PinnedDirectory {
    constructor(readonly fd: number) {}
    static open(absolute: string, createPrivate = false): PinnedDirectory {
        if (!path.isAbsolute(absolute) || absolute.includes('\0') || absolute.split('/').includes('..')) throw new Error('unsafe diagnostic directory');
        let dir = new PinnedDirectory(fs.openSync('/', directoryFlags));
        try {
            const parts = absolute.split('/').filter(Boolean);
            for (let i = 0; i < parts.length; i++) {
                if (createPrivate && i === parts.length - 1) {
                    dir.createPrivateChild(parts[i]);
                }
                const next = dir.child(parts[i]);
                dir.close(); dir = next;
            }
            if (createPrivate) {
                const stat = fs.fstatSync(dir.fd);
                if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('diagnostic directory must be owned and private');
            }
            return dir;
        } catch (e) { dir.close(); throw e; }
    }
    private createPrivateChild(name: string): void {
        try { fs.mkdirSync(this.path(name), { mode: 0o700 }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    path(name: string): string {
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error('unsafe diagnostic entry');
        return `/proc/self/fd/${this.fd}/${name}`;
    }
    child(name: string): PinnedDirectory { return new PinnedDirectory(fs.openSync(this.path(name), directoryFlags)); }
    file(name: string): number {
        const fd = fs.openSync(this.path(name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1) { fs.closeSync(fd); throw new Error('unsafe diagnostic file'); }
        // Ownership is checked explicitly; it is never assumed from the directory.
        if (s.uid !== fs.fstatSync(this.fd).uid) { fs.closeSync(fd); throw new ProviderEntryOwnershipError(); }
        return fd;
    }
    close(): void { fs.closeSync(this.fd); }
}
