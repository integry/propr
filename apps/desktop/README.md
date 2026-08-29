# ProPR Desktop

This workspace packages the existing `propr-ui` React source as a sandboxed Electron renderer. The desktop entry is
`propr-ui/src/desktop.tsx`; the normal web entry, service worker, CLI, API, and self-hosted deployment remain unchanged.

## Commands

Run these from the repository root:

```sh
npm run desktop:dev
npm run desktop:typecheck
npm run desktop:test
npm run desktop:package
npm run desktop:smoke # Run under xvfb-run on a headless Linux host.
npm run desktop:make
npm run desktop:audit
# On Linux hosts with the corresponding native packaging tools installed:
npm run make:deb -w @propr/desktop
npm run make:rpm -w @propr/desktop
```

Desktop development, typecheck, package, and make commands build required renderer workspace dependencies through
`desktop:prepare`, in dependency order (`@propr/shared`, `@propr/client`, `@propr/local-setup`, then `@propr/cli`). They do not depend on previously
generated workspace `dist` directories.

Development renderer URLs are accepted only when Electron Forge supplies an HTTP loopback URL. Packaged builds load
the generated renderer from the application ASAR through an app-owned protocol.

The packaged-binary smoke test verifies the hardened fuse states, launches the Linux artifact without a
sandbox-disabling flag, rejects main-process uncaught exceptions, and requires proof that `window.proprDesktop` is
exposed before accepting renderer-ready and a clean exit.

`desktop:audit` deliberately applies separate policies to the two dependency surfaces: low-or-higher advisories fail
the production-runtime audit, while high and critical advisories fail the desktop development/build-tool audit. Release
CI runs both checks directly from the committed lockfile before installing or executing the packaging toolchain.

## Security boundary

The renderer has no Node.js integration and receives only the typed `window.proprDesktop` and
`window.__PROPR_DESKTOP__` bridges. They expose metadata, validated external-browser opening, profiles, encrypted credentials, lifecycle control, guided setup, and validated deep-link
events. It never exposes a shell, command runner, arbitrary IPC call, or filesystem path/API.

Profile metadata is stored in an app-owned, permission-restricted JSON file. Credential values are encrypted with
Electron `safeStorage` before they are written separately. If OS encryption is unavailable—or Linux selects the
`basic_text` backend—the app reports that state and refuses to persist or return credentials; there is no plaintext
fallback. Profiles remain usable because they contain only a display label and validated API endpoint.

`propr://connect` and `propr://open` are the only accepted deep-link actions. A single-instance lock routes later
activations to the existing window. Desktop pairing and active-profile request authentication remain in Electron main;
the renderer never receives the device secret or instance bearer token.

## Local setup

Linux presents the guided setup wizard and binds it to the shared `@propr/local-setup` engine. Progress and recovery
state are redacted before crossing IPC and persisted without prompt secrets, allowing a safely re-runnable setup to
resume after restart. The packaged app carries the same launcher manifest, orchestrator, and stack template as the CLI.

macOS and Windows present remote connections as the supported path and explain that the local installer is Linux-only.
They do not show Docker Desktop installation or lifecycle actions.
