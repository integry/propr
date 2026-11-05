// Reuse the production-wizard lifecycle driver owned jointly with #2968. No
// Mac-only acceptance page, provider credentials, enrollment, or Docker writes.
import { stat } from 'node:fs/promises';
import { delimiter, dirname, resolve } from 'node:path';
import { runPackagedLinuxSetupLifecycle, LINUX_SETUP_ACCEPTANCE_OPT_IN } from './packaged-linux-setup-lifecycle.mjs';

if (process.platform !== 'darwin') throw new Error('Run this acceptance on a native Mac');
if (process.env.PROPR_DESKTOP_REAL_MACOS_SETUP_ACCEPTANCE !== '1') throw new Error('Set PROPR_DESKTOP_REAL_MACOS_SETUP_ACCEPTANCE=1 to opt in');
const binaryPath = process.argv[2];
if (!binaryPath?.startsWith('/') || !binaryPath.endsWith('.app/Contents/MacOS/propr-desktop')) {
  throw new Error('Pass the absolute path to the independently built .app/Contents/MacOS/propr-desktop executable');
}
const path = [dirname(process.execPath), process.env.PATH, '/Applications/Docker.app/Contents/Resources/bin', '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean).join(delimiter);
const environment = { ...process.env, PATH: path };
// Inspect socket metadata only; never load the user's Docker config/credential helpers.
const endpoint = process.env.DOCKER_HOST || await (async () => {
  for (const socket of [`${process.env.HOME}/.docker/run/docker.sock`, '/var/run/docker.sock']) {
    try { if ((await stat(socket)).isSocket()) return `unix://${socket}`; } catch { /* next */ }
  }
  throw new Error('Open Docker Desktop or set DOCKER_HOST to its local Unix socket');
})();
if (!endpoint.startsWith('unix:///')) throw new Error('Native Mac acceptance requires a local Unix Docker Desktop endpoint');
const report = await runPackagedLinuxSetupLifecycle({
  nativeMac: true, binaryPath: resolve(binaryPath),
  environment: {
    ...environment, DOCKER_HOST: endpoint,
    [LINUX_SETUP_ACCEPTANCE_OPT_IN]: '1',
    PROPR_DESKTOP_SETUP_ACCEPTANCE_OUTPUT: process.env.PROPR_DESKTOP_SETUP_ACCEPTANCE_OUTPUT || 'desktop-acceptance-artifacts/macos-setup-lifecycle.json',
  },
});
console.log(JSON.stringify({ ...report, proofScope: 'Held-pull lifecycle only; no full provisioning, health, enrollment, agent compatibility, or pairing proof.' }, null, 2));

if (report.result !== 'verified') process.exitCode = 1;
