# ProPR Management UI

The React/TypeScript UI manages repositories, agents, plans, tasks, native goals,
Inbox, MCP settings and previews. It uses the authenticated API and Socket.IO
updates; polling is a fallback when the socket is unavailable. See the
[Web UI guide](../docs/docs/features/web-ui.md) for user workflows.

## Development

Use Node.js 22.12+ and install the root workspaces:

```sh
npm ci
npm run build -w @propr/shared
npm run build -w @propr/client
npm run dev -w propr-ui
```

Vite serves the UI at `http://localhost:5173`. API calls live in `src/api`,
pages in `src/pages`, shared components in `src/components`, and desktop
presentation in `src/desktop`. The entry point is `src/main.tsx`.

### Desktop presentation fixtures

Desktop mode is enabled explicitly by the typed `window.__PROPR_DESKTOP__`
preload bridge. The normal hosted and self-hosted web UI never relies on user
agent detection and continues to use the standard presentation.

For browser-based development and deterministic screenshots, open one of these
fixture URLs after starting Vite:

- `/?desktop-fixture=first-run`
- `/?desktop-fixture=recents`
- `/?desktop-fixture=offline`
- `/?desktop-fixture=incompatible`
- `/?desktop-fixture=connected`

The preload-facing adapter contract lives in `src/desktop/types.ts`. Browser
fixtures implement the same profile persistence, discovery, authentication,
external-browser, local-setup, and connection interfaces without exposing host
commands to React.

## Checks and screenshots

```sh
npm run build -w propr-ui
npm run typecheck -w propr-ui
npm run test -w propr-ui
npm run test:browser -w propr-ui
```

Playwright browser tests in `e2e/` run the real built UI with safe API fixtures.
`PROPR_CAPTURE_PREVIEWS=1` enables captures in tests that support it. See the
[0.9.0 capture record](../docs/release-0.9.0-audit.md) for selected documentation
assets and verification. Production uses the live API; fixtures do not prove
provider execution, push delivery or release availability.
