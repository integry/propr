import { lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { App, CrashReporter } from 'electron';

const SWITCH = '--propr-native-crash-directory';
const PHASES = new Set([
  'startup', 'admission-closed', 'deep-links-closed', 'native-actions-closed', 'tray-closed', 'ipc-closed', 'session-closed', 'protocol-disposed', 'notifications-closed',
  'credentials-dispose-started', 'authentication-cleared', 'lifecycle-drain-started',
  'setup-drain-started', 'ipc-drain-started', 'deep-link-drain-started', 'service-drain-finished',
  'profiles-close-started', 'profiles-close-finished', 'session-disposed',
  'ipc-disposed', 'window-destroyed', 'final-quit', 'will-quit',
]);

/** Local, opt-in capture for synthetic packaged Linux smoke runs only. */
export const configureNativeShutdownDiagnostics = ({
  app,
  crashReporter,
  argv,
  authorizedSmokeDirectory,
  platform = process.platform,
}: {
  app: Pick<App, 'setPath'>;
  crashReporter: Pick<CrashReporter, 'start' | 'addExtraParameter'>;
  argv: readonly string[];
  authorizedSmokeDirectory: string | null;
  platform?: NodeJS.Platform;
}): { recordPhase(phase: unknown): void } | null => {
  const switches = argv.filter(argument => argument === SWITCH || argument.startsWith(`${SWITCH}=`));
  if (switches.length === 0) return null;
  if (platform !== 'linux' || authorizedSmokeDirectory === null || switches.length !== 1) {
    throw new Error('Native crash capture requires one authorized Linux smoke launch');
  }
  const root = switches[0].slice(SWITCH.length + 1);
  if (!isAbsolute(root) || resolve(root) !== root || /[\0\r\n]/.test(root)) {
    throw new Error('Native crash capture requires a canonical absolute directory');
  }
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(root) !== root
    || stats.uid !== process.getuid?.() || (stats.mode & 0o777) !== 0o700) {
    throw new Error('Native crash capture requires an existing owned 0700 directory without links');
  }
  const profile = realpathSync(authorizedSmokeDirectory);
  const within = (parent: string, child: string): boolean => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith('../') && path !== '..' && !isAbsolute(path));
  };
  if (within(profile, root) || within(root, profile)) {
    throw new Error('Native crash capture must be separate from smoke profile cleanup');
  }

  // Each process owns a fresh child; the operator owns retention of this root.
  // Dumps can contain memory, so never send them through the public logger or
  // place them in userData (whose plaintext-credential scan must stay strict).
  const directory = mkdtempSync(join(root, 'launch-'));
  const dumps = join(directory, 'dumps');
  mkdirSync(dumps, { mode: 0o700 });
  writeFileSync(join(directory, 'runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    platform,
    arch: process.arch,
    electron: process.versions.electron ?? null,
    chromium: process.versions.chrome ?? null,
    node: process.versions.node,
  })}\n`, { flag: 'wx', mode: 0o600 });
  app.setPath('crashDumps', dumps);
  crashReporter.start({
    uploadToServer: false,
    ignoreSystemCrashHandler: false,
    extra: { propr_shutdown_phase: 'startup' },
  });
  return {
    recordPhase(phase) {
      if (typeof phase === 'string' && PHASES.has(phase)) {
        crashReporter.addExtraParameter('propr_shutdown_phase', phase);
      }
    },
  };
};
