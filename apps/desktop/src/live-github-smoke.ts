import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

const ROOT = '/var/lib/propr-desktop-live/state';
export const LIVE_SMOKE_ACCOUNT = Object.freeze({ username: 'propr-ultrafix', id: '297689653' });
export const isExpectedLiveSmokeAccount = (account: { username: string; id: string }, endpoint: string, origin: string): boolean =>
  account.username === LIVE_SMOKE_ACCOUNT.username && account.id === LIVE_SMOKE_ACCOUNT.id && endpoint === origin;

export const hasPrivateLiveSmokeDebugger = (argv: string[]): boolean =>
  argv.includes('--remote-debugging-pipe') && argv.filter(value => value.startsWith('--remote-debugging-')).length === 1;

const reject = (): never => { throw new Error('Live GitHub smoke authorization rejected'); };

export function authorizeLiveGithubSmoke(options: {
  argv: string[];
  environment: NodeJS.ProcessEnv;
  isPackaged: boolean;
  platform: string;
  appData: string;
}) {
  const requested = options.argv.includes('--propr-live-github-smoke');
  if (!requested && options.environment.PROPR_DESKTOP_LIVE_GITHUB_SMOKE !== '1') return null;
  const env = options.environment;
  if (!requested || options.argv.filter(value => value === '--propr-live-github-smoke').length !== 1
    || options.argv.some(value => /^--(?:user-data-dir|disk-cache-dir|profile-directory)(?:=|$)/.test(value))
    || !hasPrivateLiveSmokeDebugger(options.argv)
    || env.HOME !== join(ROOT, 'desktop-home')
    || env.XDG_DATA_HOME !== join(ROOT, 'desktop-home/.local/share')
    || env.PROPR_DESKTOP_LIVE_GITHUB_SMOKE !== '1' || env.PROPR_LIVE_PRIVATE_DBUS !== '1'
    || !env.DBUS_SESSION_BUS_ADDRESS || !options.isPackaged || options.platform !== 'linux'
    || options.appData !== join(ROOT, 'desktop-home/.config')
    || env.PROPR_DESKTOP_LIVE_CONFIG !== '/var/lib/propr-desktop-live/config.json') reject();
  for (const path of ['/var/lib/propr-desktop-live', ROOT, join(ROOT, 'desktop-home'), options.appData]) {
    const stat = lstatSync(path);
    if (realpathSync(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== process.getuid!() || (stat.mode & 0o077)) reject();
  }
  const configStat = lstatSync(env.PROPR_DESKTOP_LIVE_CONFIG!);
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.uid !== process.getuid!()
    || (configStat.mode & 0o077)) reject();
  const config = JSON.parse(readFileSync(env.PROPR_DESKTOP_LIVE_CONFIG!, 'utf8')) as { apiOrigin?: string; stateRoot?: string };
  const origin = new URL(config.apiOrigin ?? '');
  if (config.apiOrigin !== origin.origin || origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/'
    || origin.search || origin.hash || origin.port || config.stateRoot !== ROOT
    || !/^(?:[a-z0-9-]+\.)*(?:staging|preview)\.propr\.dev$/.test(origin.hostname)) reject();
  const socketPath = join(ROOT, 'handoff.sock');
  const socketStat = lstatSync(socketPath);
  if (!socketStat.isSocket() || socketStat.uid !== process.getuid!() || (socketStat.mode & 0o077)) reject();
  const send = (record: object): Promise<boolean> => new Promise(resolve => {
    const socket = connect(socketPath);
    let reply = '';
    socket.setTimeout(5_000);
    socket.once('connect', () => socket.write(`${JSON.stringify(record)}\n`));
    socket.on('data', data => {
      reply += data.toString();
      if (reply.length > 128) { socket.destroy(); resolve(false); }
      if (reply.includes('\n')) { socket.destroy(); resolve(reply === '{"accepted":true}\n'); }
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('close', () => resolve(false));
  });
  return {
    openExternal: async (value: string): Promise<void> => {
      const url = new URL(value);
      if (url.origin !== origin.origin || url.search || url.hash
        || !/^\/api\/desktop\/pairings\/dpr_[A-Za-z0-9_-]{22}\/browser$/.test(url.pathname)
        || !await send({ event: 'handoff', url: value })) reject();
    },
    confirmAccount: async (account: { username: string; id: string }, endpoint: string): Promise<boolean> => {
      const expected = isExpectedLiveSmokeAccount(account, endpoint, origin.origin);
      const accepted = await send({ event: 'confirmation', expected });
      return expected && accepted;
    },
  };
}
