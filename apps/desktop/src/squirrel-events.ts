import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

type SpawnUpdate = (command: string, args: string[]) => void;

export const DESKTOP_EXECUTABLE_NAME = 'propr-desktop';
export const SQUIRREL_PACKAGE_NAME = 'propr_desktop';

export const squirrelAppUserModelId = (
  executableName = DESKTOP_EXECUTABLE_NAME,
): string => `com.squirrel.${SQUIRREL_PACKAGE_NAME}.${executableName}`;

const defaultSpawnUpdate: SpawnUpdate = (command, args) => {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
};

export const handleSquirrelStartupEvent = ({
  argv = process.argv,
  execPath = process.execPath,
  quit,
  spawnUpdate = defaultSpawnUpdate,
  schedule = setTimeout,
}: {
  argv?: readonly string[];
  execPath?: string;
  quit: () => void;
  spawnUpdate?: SpawnUpdate;
  schedule?: (callback: () => void, delay: number) => unknown;
}): boolean => {
  const event = argv[1];
  if (!event?.startsWith('--squirrel-')) return false;

  const executableName = basename(execPath);
  const updateExecutable = resolve(dirname(execPath), '..', 'Update.exe');
  switch (event) {
    case '--squirrel-install':
    case '--squirrel-updated':
      spawnUpdate(updateExecutable, ['--createShortcut', executableName]);
      schedule(quit, 1_000);
      return true;
    case '--squirrel-uninstall':
      spawnUpdate(updateExecutable, ['--removeShortcut', executableName]);
      schedule(quit, 1_000);
      return true;
    case '--squirrel-obsolete':
      quit();
      return true;
    case '--squirrel-firstrun':
      return false;
    default:
      // Unknown Squirrel flags must not suppress normal startup.
      return false;
  }
};
