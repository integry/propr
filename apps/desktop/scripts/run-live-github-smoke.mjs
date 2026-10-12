// The public command owns the process group and emits only a validated result enum.
import { spawn } from 'node:child_process';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, assertPrivateTree, RESULTS, resultRecord, SmokeFailure } from './live-github-smoke.mjs';

process.umask(0o077);
const harness = fileURLToPath(new URL('./live-github-smoke.mjs', import.meta.url));
let artifactIdentity;
let record = resultRecord(new SmokeFailure('configuration_failed'));
try {
  const dryRun = process.argv.slice(2).join(' ') === '--dry-run';
  if (!dryRun && (process.argv.length !== 2 || process.env.PROPR_DESKTOP_LIVE_GITHUB_SMOKE !== '1')) throw new Error();
  let env = { PATH: '/usr/bin:/bin' };
  if (!dryRun) {
    const configPath = process.env.PROPR_DESKTOP_LIVE_CONFIG;
    if (configPath !== '/var/lib/propr-desktop-live/config.json') throw new Error();
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error();
    const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
    artifactIdentity = { sourceRevision: config.sourceRevision, rpmSha256: config.rpmSha256 };
    await assertPrivateTree('/var/lib/propr-desktop-live');
    await assertPrivateTree(config.stateRoot);
    const privateHome = join(config.stateRoot, 'desktop-home');
    await mkdir(privateHome, { mode: 0o700, recursive: true });
    await assertPrivateTree(privateHome);
    const runtimeRoot = join(config.stateRoot, 'runtime');
    await mkdir(runtimeRoot, { mode: 0o700, recursive: true });
    await assertPrivateTree(runtimeRoot);
    env = { ...env, PLAYWRIGHT_BROWSERS_PATH: '/var/lib/propr-desktop-live/playwright', XDG_RUNTIME_DIR: runtimeRoot, HOME: privateHome, XDG_CONFIG_HOME: join(privateHome, '.config'),
      XDG_CACHE_HOME: join(privateHome, '.cache'), XDG_DATA_HOME: join(privateHome, '.local/share'), DISPLAY: process.env.DISPLAY,
      PROPR_DESKTOP_LIVE_CONFIG: configPath, PROPR_DESKTOP_LIVE_GITHUB_SMOKE: '1',
      PROPR_LIVE_PRIVATE_DBUS: '1' };
  }
  record = resultRecord(new SmokeFailure('app_pairing_failed'), dryRun);
  const child = spawn(dryRun ? process.execPath : '/usr/bin/dbus-run-session',
    dryRun ? [harness, '--dry-run'] : ['--', process.execPath, harness],
    { detached: true, env, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.on('data', data => { if (output.length < 4096) output += data; });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ } };
  const timer = setTimeout(kill, 270_000);
  const interrupted = () => kill();
  process.once('SIGTERM', interrupted);
  process.once('SIGINT', interrupted);
  try {
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    // Kill this process group (Desktop/DBus/keyring). Detached Playwright Chromium
    // is verified and recovered under the run lock before the next browser launch.
    kill();
    const candidate = JSON.parse(output.trim());
    if (Object.keys(candidate).sort().join(',') === 'mode,result,schemaVersion'
      && candidate.schemaVersion === 1 && candidate.mode === (dryRun ? 'fixture' : 'live')
      && RESULTS.includes(candidate.result)) record = candidate;
    else record = resultRecord(new SmokeFailure('app_pairing_failed'), dryRun);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', interrupted);
    process.removeListener('SIGINT', interrupted);
  }
} catch { /* Never print raw errors, environment, paths, or subprocess diagnostics. */ }
process.stdout.write(`${JSON.stringify({ ...record, ...(artifactIdentity ? { artifact: artifactIdentity } : {}) })}\n`);
process.exitCode = record.result === 'passed' ? 0 : record.result === 'reauthorization_required' ? 2 : 1;
