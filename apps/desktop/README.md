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

The packaged-binary smoke test verifies the hardened fuse states and launches the Linux or Windows artifact without a
sandbox-disabling flag. From the packaged custom-protocol renderer it drives preload IPC, activation-scoped REST and
Socket.IO upgrades through Electron session interception, scope rotation and same-ID origin editing. It also checks
cookie omission, both-origin storage cleanup, stale-scope fencing, renderer/main secret custody, uncaught exceptions,
and a clean exit.

`desktop:audit` deliberately applies separate policies to the two dependency surfaces: low-or-higher advisories fail
the production-runtime audit, while high and critical advisories fail the desktop development/build-tool audit. Release
CI runs both checks directly from the committed lockfile before installing or executing the packaging toolchain.

## Security boundary

The renderer has no Node.js integration and receives only the typed `window.proprDesktop` bridge. It exposes metadata,
validated profiles, status-only pairing/probe/invalidation operations, lifecycle placeholders, and validated deep-link
events. Pairing, browser approval, credential persistence, authenticated probes, and revocation run in Electron main.
The bridge never exposes a credential value, shell, command runner, arbitrary IPC call, or filesystem path/API.

Profile metadata is stored in an app-owned, permission-restricted JSON file. Credential values are encrypted with
Electron `safeStorage` before they are written separately. If OS encryption is unavailable—or Linux selects the
`basic_text` backend—the app reports that state and refuses to persist credentials; there is no plaintext
fallback. Profiles remain usable because they contain only a display label and validated API endpoint.

Opaque instance tokens are bound to profile ID plus normalized origin in encrypted main-process storage. Electron's
session request boundary strips renderer-supplied Authorization and Cookie headers from every HTTP(S) and WS(S)
request, including inactive or mismatched profile origins, then injects the active bearer only for matching REST and
Socket.IO requests. Set-Cookie is stripped from remote responses, so the packaged renderer has no parallel cookie
identity. Tokens never enter renderer JavaScript, URLs, logs, localStorage, sessionStorage, or profile metadata.
Switching named profiles clears renderer and instance-origin state. Removing or changing a paired profile first
attempts current-token revocation at the old bound origin, then removes the credential.

`propr://connect` and `propr://open` are the only accepted deep-link actions. A single-instance lock routes later
activations to the existing window. Local lifecycle methods intentionally return `not-implemented`; this scaffold does
not download, install, start, or execute ProPR runtime components.
