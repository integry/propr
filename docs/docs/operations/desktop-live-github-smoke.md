# Optional nightly Desktop GitHub smoke

This is separate from the deterministic installed-RPM release gate. Signed preview publication never depends on this workflow. Its Actions summary reports `passed`, `reauthorization_required`, `account_mismatch`, `api_compatibility_failed`, `repository_access_failed`, `app_pairing_failed`, `runtime_source_mismatch`, or `configuration_failed`. Release validation can link the optional run and its result. A fixture success is never live acceptance evidence.

## One-time operator enrollment on Gram

Use an exclusive Linux Unix account and self-hosted runner with the `propr-desktop-live-github` label. Do not use a personal workstation account. Install Node from `.nvmrc`, RPM/GnuPG tools, DBus, gnome-keyring, Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH=/var/lib/propr-desktop-live/playwright npx playwright install chromium`), and a private graphical display or Xvfb. Set DISPLAY in the runner service. Keep this runner off PR/untrusted workflows. Enable the repository variable `PROPR_DESKTOP_LIVE_GITHUB_SMOKE_ENABLED=1` only after enrollment; disabling it stops nightly execution. The workflow accepts no artifact URLs, credentials, or untrusted dispatch inputs.

Create `/var/lib/propr-desktop-live` owned by that runner account with mode 0700. Create `config.json` with mode 0600 and exactly reviewed public artifact identity and local paths, for example:

```json
{
  "apiOrigin": "https://staging.propr.dev",
  "sourceRevision": "FULL_40_CHARACTER_SOURCE_SHA",
  "rpmSha256": "EXACT_64_CHARACTER_SIGNED_RPM_SHA256",
  "arch": "x64",
  "rpmPath": "/var/lib/propr-desktop-live/preview.rpm",
  "stateRoot": "/var/lib/propr-desktop-live/state"
}
```

Create `state`, `state/browser`, `state/runtime`, and `state/desktop-home` with mode 0700. `stateRoot` is fixed to `/var/lib/propr-desktop-live/state`; normal profile locations are refused. The origin must be HTTPS in the explicit `staging.propr.dev` or `preview.propr.dev` namespace (subdomains allowed). Production and managed tunnel origins are refused. Serve the preview browser UI and pairing approval page on the same reviewed origin as the API; a hosted production frontend is refused. Deploy the matching source-aligned staging/preview backend with authentication protocol 2 and the packaged API compatibility contract. Install the exact signed RPM using the existing signed-preview operator procedure. The signed RPM must include the live-smoke bridge from this change; older packages cannot run the harness. The command verifies the owner-pinned native signature, SHA256, installed RPM metadata/file verification, and installed published runtime/image source binding on every run. It launches `/usr/lib/propr-desktop/propr-desktop`; it does not install or upgrade host software itself.

Enroll manually using Playwright's **same** dedicated persistent Chromium directory `state/browser`, in a private `dbus-run-session`, with HOME/XDG configuration and data directories under `state/desktop-home`. Use this concrete operator session from `apps/desktop` after installing dependencies (close its browser window after completing sign-in):

```sh
env PLAYWRIGHT_BROWSERS_PATH=/var/lib/propr-desktop-live/playwright \
HOME=/var/lib/propr-desktop-live/state/desktop-home \
XDG_RUNTIME_DIR=/var/lib/propr-desktop-live/state/runtime \
XDG_CONFIG_HOME=/var/lib/propr-desktop-live/state/desktop-home/.config \
XDG_DATA_HOME=/var/lib/propr-desktop-live/state/desktop-home/.local/share \
XDG_CACHE_HOME=/var/lib/propr-desktop-live/state/desktop-home/.cache \
dbus-run-session -- node --input-type=module <<'NODE'
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
process.umask(0o077);
const config = JSON.parse(await readFile('/var/lib/propr-desktop-live/config.json', 'utf8'));
await new Promise((resolve, reject) => {
  const daemon = spawn('/usr/bin/gnome-keyring-daemon', ['--unlock', '--components=secrets'],
    { stdio: ['pipe', 'ignore', 'ignore'] });
  daemon.once('error', reject);
  daemon.once('close', code => code === 0 ? resolve() : reject(new Error('Private keyring unavailable')));
  daemon.stdin.end('\n');
});
const context = await chromium.launchPersistentContext(`${config.stateRoot}/browser`, { headless: false });
const closed = new Promise(resolve => context.once('close', resolve));
const page = await context.newPage();
await page.goto(`${config.apiOrigin}/api/auth/github`);
await closed;
NODE
```

The operator performs all interactions in that window. Run this session with the private HOME/XDG paths and no DEBUG/PWDEBUG, tracing, HAR, videos, storage-state exports, or console/error logging. Only the operator performs GitHub login, 2FA, CAPTCHA, and any fresh OAuth consent. Verify the account is exactly `propr-ultrafix` before granting consent. Close Chromium cleanly to save the session. Do not enroll through a normal browser or copy cookies/tokens into this profile. Existing access to `propr-ultrafix/propr-desktop-acceptance-20260909` is required; this procedure grants no account or repository permissions.

The harness starts a new private DBus session and an isolated keyring under `state/desktop-home/.local/share`. This dedicated smoke keyring uses an empty local unlock password to permit unattended startup; its protection is the exclusive Unix account and owner-restricted filesystem. It must contain only smoke credentials. Do not reuse/import the runner's normal keyring. Restrict the entire state tree to its owner and exclude it from backups, artifact collection and support bundles. If stronger local keyring policy is required, do not enable the runner until an operator supplies an equivalent unattended private keyring arrangement.

## Unattended command and results

```sh
PROPR_DESKTOP_LIVE_GITHUB_SMOKE=1 \
PROPR_DESKTOP_LIVE_CONFIG=/var/lib/propr-desktop-live/config.json \
node apps/desktop/scripts/run-live-github-smoke.mjs
```

The wrapper supplies a clean child environment, separate DBus/keyring, private Desktop home and browser profile, a process-group deadline, and suppresses all subprocess/provider diagnostics. Output contains schema version, mode, a fixed result enum, and the validated public source SHA/RPM SHA256 when configuration is available; no private paths or session data are serialized. Exit 0 means success, 2 means operator reauthorization is required, and 1 means another classified failure. Runs are exclusive; concurrent commands refuse the private lock. A killed run may leave `state/run.lock`; remove it only after verifying no smoke processes are running. Never print profile, keyring, request/response bodies, headers, approval URLs, device codes or credentials during investigation.

Playwright invokes the production Desktop preload pairing and connection boundaries. The opt-in packaged Linux bridge routes the validated Desktop browser handoff over an owner-only Unix socket **in memory**, opens it only in the dedicated browser, and drives the ProPR server GitHub sign-in path. This avoids handing approval URLs to OS browser command arguments. At the production native verified-account confirmation checkpoint, the opt-in bridge accepts only the exact expected identity and configured origin; it refuses every other identity. No interactive native confirmation is required during unattended runs. Signed builds keep Node inspection disabled; Playwright connects only to the private loopback renderer debugger. It checks browser identity before clicking Approve desktop, then checks the native confirmation checkpoint and connected Desktop bearer identity independently. It reads repository visibility and branches through the activated Desktop transport, and makes no repository mutations. The run removes its Desktop profile through the production revocation path on completion; abrupt termination may require operator cleanup of outstanding device access.

A login/recovery page or fresh OAuth authorization form yields `reauthorization_required`. The harness never types credentials or approves fresh consent. Account mismatch stops before repository operations. Network/pairing failures remain separate from session reauthorization. No screenshots or diagnostic artifacts are collected. Chromium's required profile-directory argument identifies only the dedicated private directory; cookies/tokens and approval URLs are never arguments.

## Rotation and clearing

Disable the opt-in variable, stop the runner, and close all smoke Chromium, Desktop, DBus and keyring processes. Revoke only the dedicated smoke device sessions/grant through the normal operator UI if rotation requires it. Remove the dedicated state tree and recreate its owner/modes; never clear a normal browser or system keyring. Re-enroll manually, update the frozen RPM digest/source config for a new preview, and run a dispatch before re-enabling unattended runs. Expired or revoked sessions require this operator action; nightly jobs do not attempt recovery.

## Credential-free validation

```sh
node --test apps/desktop/scripts/live-github-smoke.test.mjs
node apps/desktop/scripts/run-live-github-smoke.mjs --dry-run
```

Dry-run uses local in-memory stage fixtures and never launches Electron, Chromium, or GitHub. Tests cover classifications, wrong-account refusal at each identity boundary, safe output even with secret error sentinels, origin rejection, and runtime/source/image binding. The workflow always runs these fixtures on a hosted runner. The live job is optional and runs only from main on the dedicated runner; it is not a dependency of publication.
