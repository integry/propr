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
`desktop:prepare`, in dependency order (`@propr/shared` then `@propr/client`). They do not depend on previously
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

The renderer has no Node.js integration and receives only the typed `window.proprDesktop` bridge. It exposes metadata,
validated external-browser opening, profiles, encrypted credentials, lifecycle placeholders, and validated deep-link
events. The renderer adapter discovers an instance's public compatibility and desktop-authentication capabilities before
launching browser approval. It never exposes a shell, command runner, arbitrary IPC call, or filesystem path/API.

Profile metadata is stored in an app-owned, permission-restricted JSON file. Credential values are encrypted with
Electron `safeStorage` before they are written separately. If OS encryption is unavailable—or Linux selects the
`basic_text` backend—the app reports that state and refuses to persist or return credentials; there is no plaintext
fallback. Profiles remain usable because they contain only a display label and validated API endpoint.

Opaque instance tokens are requested by the shared client device flow and written immediately through the encrypted
credential bridge. They are resolved afresh for REST and Socket.IO connection attempts, are never placed in URLs,
logs, localStorage, sessionStorage, or profile metadata, and bearer requests explicitly omit cookies. Switching named
profiles clears renderer-scoped state and cookies for both instance origins. Removing a paired profile first attempts
to revoke only its current instance token, then removes its encrypted local credential even if the instance is offline.

`propr://connect` and `propr://open` are the only accepted deep-link actions. A single-instance lock routes later
activations to the existing window. Local lifecycle methods intentionally return `not-implemented`; this scaffold does
not download, install, start, or execute ProPR runtime components.
