import { lstatSync, type Stats } from 'node:fs';
import { join, relative, resolve } from 'node:path';

type ElectronLogsPath = {
  setPath(name: 'logs', path: string): void;
};

export const configureNativeSmokeLogsPath = ({
  app,
  authorizedNativeSmoke,
  platform,
  userDataDirectory,
  inspectDirectory = lstatSync,
  currentUserId = typeof process.getuid === 'function' ? process.getuid() : undefined,
}: {
  app: ElectronLogsPath;
  authorizedNativeSmoke: boolean;
  platform: NodeJS.Platform;
  userDataDirectory: string;
  inspectDirectory?: (path: string) => Stats;
  currentUserId?: number;
}): string | null => {
  if (!authorizedNativeSmoke || platform === 'win32') return null;

  const resolvedUserData = resolve(userDataDirectory);
  const logsDirectory = join(resolvedUserData, 'logs');
  const logsFromUserData = relative(resolvedUserData, logsDirectory);
  if (!logsFromUserData || logsFromUserData.startsWith('..')) {
    throw new Error('Native smoke logs directory escaped the isolated user-data root');
  }

  const stats = inspectDirectory(logsDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700
    || currentUserId === undefined || stats.uid !== currentUserId) {
    throw new Error('Native smoke logs directory does not have owned 0700 authority');
  }
  app.setPath('logs', logsDirectory);
  return logsDirectory;
};
