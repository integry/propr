# Optional nightly Desktop GitHub smoke

This is separate from the deterministic installed-RPM release gate. Signed preview publication never depends on this workflow. Its Actions summary reports `passed`, `reauthorization_required`, `account_mismatch`, `api_compatibility_failed`, `repository_access_failed`, `app_pairing_failed`, `runtime_source_mismatch`, or `configuration_failed`. Release validation can link the optional run and its result. A fixture success is never live acceptance evidence.

## One-time operator enrollment on Gram

Use an exclusive Linux Unix account and self-hosted runner with the `propr-desktop-live-github` label. Do not use a personal workstation account. Install Node from `.nvmrc`, RPM/GnuPG tools, util-linux `flock`, DBus, gnome-keyring, Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH=/var/lib/propr-desktop-live/playwright npx playwright install chromium`), and a private graphical display or Xvfb. Set DISPLAY in the runner service. Keep this runner off PR/untrusted workflows. Enable the repository variable `PROPR_DESKTOP_LIVE_GITHUB_SMOKE_ENABLED=1` only after enrollment; disabling it stops nightly execution. The workflow accepts no artifact URLs, credentials, or untrusted dispatch inputs.

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

The operator performs all interactions in that window. Run this session with the private HOME/XDG paths and no DEBUG/PWDEBUG, tracing, HAR, videos, storage-state exports, or console/error logging. Only the operator performs GitHub login, 2FA, CAPTCHA, and any fresh OAuth consent. Verify the account is exactly `propr-ultrafix` (GitHub numeric user ID `297689653`) before granting consent. Close Chromium cleanly to save the session. Do not enroll through a normal browser or copy cookies/tokens into this profile. Existing access to `propr-ultrafix/propr-desktop-acceptance-20260909` is required; this procedure grants no account or repository permissions.

The harness starts a new private DBus session and an isolated keyring under `state/desktop-home/.local/share`. This dedicated smoke keyring uses an empty local unlock password to permit unattended startup; its protection is the exclusive Unix account and owner-restricted filesystem. It must contain only smoke credentials. Do not reuse/import the runner's normal keyring. Restrict the entire state tree to its owner and exclude it from backups, artifact collection and support bundles. If stronger local keyring policy is required, do not enable the runner until an operator supplies an equivalent unattended private keyring arrangement.

## Unattended command and results

```sh
PROPR_DESKTOP_LIVE_GITHUB_SMOKE=1 \
PROPR_DESKTOP_LIVE_CONFIG=/var/lib/propr-desktop-live/config.json \
node apps/desktop/scripts/run-live-github-smoke.mjs
```

The wrapper supplies a clean child environment, separate DBus/keyring, private Desktop home and browser profile, a 180-second journey deadline, a 240-second last-resort harness exit, and a 270-second process-group deadline, and suppresses all subprocess/provider diagnostics. Output contains schema version, mode, a fixed result enum, and the validated public source SHA/RPM SHA256 when configuration is available; no private paths or session data are serialized. Exit 0 means success, 2 means operator reauthorization is required, and 1 means another classified failure. Runs are exclusive; concurrent commands refuse the private lock. The PID-bearing `state/run.lock` is removed on normal deadline cleanup. Under a kernel `flock`, subsequent runs reclaim locks only when the recorded PID is dead; malformed locks or live/reused PIDs require operator inspection. Before browser launch, a stale Chromium singleton is recovered only for the same host and a dead PID, or an owner-matched Playwright browser with this exact dedicated profile. Detached Chromium is outside the wrapper process group, so the next run verifies and stops it under the run lock. Never print profile, keyring, request/response bodies, headers, approval URLs, device codes or credentials during investigation.

Playwright invokes the production Desktop preload pairing and connection boundaries. The opt-in packaged Linux bridge routes the validated Desktop browser handoff over an owner-only Unix socket **in memory**, opens it only in the dedicated browser, and drives the ProPR server GitHub sign-in path. This avoids handing approval URLs to OS browser command arguments. At the production native verified-account confirmation checkpoint, the opt-in bridge accepts only the exact expected username, numeric GitHub user ID, and configured origin; it refuses every other identity. No interactive native confirmation is required during unattended runs. Signed builds keep Node inspection disabled; the harness speaks renderer CDP over inherited pipes on fds 3/4, with no TCP debugger listener. Smoke authorization rejects TCP debugger flags. In smoke mode Desktop explicitly selects `gnome-libsecret`; preflight still rejects unavailable storage or `basic_text`. Confirm that preflight succeeds with a dispatch on the enrolled runner after installing the updated signed RPM. It checks browser identity before clicking Approve desktop, then checks the native confirmation checkpoint and connected Desktop bearer identity independently. It reads repository visibility and branches through the activated Desktop transport, and makes no repository mutations. On completion or the normal journey deadline, the run cancels pairing and removes its Desktop profile through the production durable revocation path. It awaits profile-save authority before cleanup, so an in-flight save cannot recreate the removed profile. Removal journals revocation; it does not prove that an unavailable server has already revoked access. On restart, the smoke removes leftover nightly profiles through the same path, and Desktop retries its durable pending revocations. Abrupt termination or continued server unavailability may still require operator cleanup of outstanding device access.

A login/recovery page or fresh OAuth authorization form yields `reauthorization_required`. The harness never types credentials or approves fresh consent. Account mismatch stops before repository operations. Network/pairing failures remain separate from session reauthorization. No screenshots or diagnostic artifacts are collected. Chromium's required profile-directory argument identifies only the dedicated private directory; cookies/tokens and approval URLs are never arguments.

This journey covers browser sign-in and Desktop browser pairing. It does **not** prove the separate Desktop GitHub OAuth device flow, including its expiring-token compatibility; #3036 remains separate. A saved prior identity cannot satisfy these pinned account checks.

## Rotation and clearing

Disable the opt-in variable, stop the runner, and close all smoke Chromium, Desktop, DBus and keyring processes. Revoke only the dedicated smoke device sessions/grant through the normal operator UI if rotation requires it. Remove the dedicated state tree and recreate its owner/modes; never clear a normal browser or system keyring. Re-enroll manually, update the frozen RPM digest/source config for a new preview, and run a dispatch before re-enabling unattended runs. Expired or revoked sessions require this operator action; nightly jobs do not attempt recovery.

## Credential-free validation

```sh
node --test apps/desktop/scripts/live-github-smoke.test.mjs
node apps/desktop/scripts/run-live-github-smoke.mjs --dry-run
```

Dry-run uses local in-memory stage fixtures and never launches Electron, Chromium, or GitHub. Tests cover classifications, wrong-account and reclaimed-login refusal at each identity boundary, timeout cleanup, stale-lock and browser-singleton recovery, CDP pipe framing, safe output even with secret error sentinels, origin rejection, and runtime/source/image binding. The workflow always runs these fixtures on a hosted runner. The live job is optional and runs only from main on the dedicated runner; it is not a dependency of publication.
