import { open } from 'node:fs/promises';

/**
 * Test-only fsync policy for the desktop profile store suites.
 *
 * The profile store fsyncs every credential, journal, mirror and directory
 * write. Its tests prove write ordering through the `beforeIO` and
 * `afterDurabilityStep` hooks and crash atomicity by SIGKILLing child
 * fixtures. Neither observation depends on bytes reaching the disk: a killed
 * process leaves the page cache intact, and the hooks fire before the flush.
 *
 * On the shared-disk rootless CI runner one fsync costs hundreds of
 * milliseconds. `profile-store.test.ts` alone performs several hundred, which
 * pushed the unit past the 180 s per-unit budget of the sharded full suite.
 * The full-suite runner therefore sets `PROPR_DESKTOP_TEST_FSYNC=off`, and this
 * module turns `FileHandle.sync`/`datasync` into no-ops for the calling
 * process. Child fixtures inherit the variable and apply the same policy.
 *
 * Every other entry point keeps native fsync: `desktop:test`, the
 * `test:native-durability` matrix and a direct `tsx --test` leave the variable
 * unset. Any value other than `off` also keeps native fsync.
 */
export const DESKTOP_TEST_FSYNC_VARIABLE = 'PROPR_DESKTOP_TEST_FSYNC';

export type DesktopTestFsyncMode = 'native' | 'off';

export interface DesktopTestFsyncPolicy {
  readonly mode: DesktopTestFsyncMode;
  /** Runs `operation` with native fsync restored, for assertions about the flush itself. */
  withNativeFsync<T>(operation: () => Promise<T>): Promise<T>;
}

type FileHandlePrototype = {
  sync(): Promise<void>;
  datasync(): Promise<void>;
};

const noop = async (): Promise<void> => undefined;

export async function applyDesktopTestFsyncPolicy(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DesktopTestFsyncPolicy> {
  if (env[DESKTOP_TEST_FSYNC_VARIABLE] !== 'off') {
    return { mode: 'native', withNativeFsync: operation => operation() };
  }
  // Node does not export the FileHandle class; a read-only handle on this
  // module reaches its prototype on every platform.
  const probe = await open(new URL(import.meta.url), 'r');
  const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
  await probe.close();
  const native = { sync: prototype.sync, datasync: prototype.datasync };
  let nativeDepth = 0;
  prototype.sync = async function (this: FileHandlePrototype) {
    if (nativeDepth > 0) await native.sync.call(this);
  };
  prototype.datasync = async function (this: FileHandlePrototype) {
    if (nativeDepth > 0) await native.datasync.call(this);
  };
  return {
    mode: 'off',
    async withNativeFsync(operation) {
      nativeDepth += 1;
      try {
        return await operation();
      } finally {
        nativeDepth -= 1;
      }
    },
  };
}
