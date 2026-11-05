import { homedir } from 'node:os';
import { join } from 'node:path';

/** Finder does not read shell startup files. Return a search path for setup
 * children without changing the host environment or the user's configuration. */
export function localSetupSearchPath(
  platform: NodeJS.Platform = process.platform,
  path = process.env.PATH,
  home = homedir(),
): string | undefined {
  if (platform !== 'darwin') return path;
  return [...new Set([
    ...(path ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(entry => entry.startsWith('/')),
    '/Applications/Docker.app/Contents/Resources/bin',
    join(home, '.docker', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ])].join(':');
}
