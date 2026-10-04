# 0.9.0 release preparation audit

Baseline: `v0.8.15` through `c2de30509` (task base HEAD), inclusive of 177
first-parent changes. Reviewed the first-parent history, feature commits and
current implementation; release notes do not treat open PRs as shipped. The
changelog date is the preparation date. No package, image, installer or tag
availability is implied.

## Coverage

“Current” means the existing reference was checked and retained, rather than
rewritten just to produce a diff. Paths below are relative to this directory.

| Delivered change / history evidence | Documentation disposition | Source cross-check / screenshot |
| --- | --- | --- |
| Goals, native Claude/Codex execution, corrective inputs (#2091, #2446, #2469, #2592) | Added [Goals](docs/features/goals.md); linked from [launching work](docs/features/launching-work.md), overview, usage and README | `packages/core/src/goals.ts`, `agents/goalCapabilities.ts`, `propr-ui/src/pages/GoalsPage.tsx`; `goals.png` |
| One-off task launch and creation menu (#2464, #2580, #2618) | Added [launching work](docs/features/launching-work.md); CLI/API READMEs link to it | `new-task.pw.ts`, task submission API; `new-task.png` |
| Navigation/dashboard, activity summaries, usage tips, repository list (#2485, #2528, #2548, #2567, #2573, #2587) | Updated [Web UI](docs/features/web-ui.md), README, usage and metrics images; [usage tips](docs/features/usage-tips.md) already current | `SidebarNavigation.tsx`, dashboard components and browser fixtures; `dashboard.png` |
| Full-plan refinement, file-based generation, revision history (#2576, #2583, #2588, #2589) | Updated [planning](docs/features/planning.md) and [Planner Studio](docs/tutorials/planner-studio.md) | `PlanEditor.tsx`, `PlanHistoryDialog.tsx`, planner services; `plan.png`, `plan-history.png` |
| Inbox, PWA/push, per-repository notifications (#1731, #2435, #2458, #2582) | Added [Inbox](docs/features/inbox.md); updated notification navigation and CLI examples; operational [PWA guide](docs/operations/pwa-web-push.md) otherwise retained | Inbox/notification components, repository settings and CLI; `notifications.png` |
| MCP enablement, consent, connected apps, operator tools, filters (#2291, #2333, #2445, #2494, #2551, #2553, #2590, #2629) | Added [site guide](docs/features/mcp.md); clarified UI vs environment enablement in [MCP reference](mcp.md); [coverage](mcp-coverage.md) and [operator surface](mcp-operator-surface.md) current | `mcp/configResolver.ts`, `browser.ts`, tools and `McpServerSection.tsx`; `mcp-settings.png`, `mcp-apps.png`, `mcp-consent.png` |
| Desktop install/pairing/accounts/settings/About (#1970, #2347, #2408, #2417, #2423, #2537) | Updated [desktop guide](docs/operations/desktop-application.md), discovery version example and package README; retained platform/publication constraints | `application-about.ts`, native menu fixture, connection renderer; `desktop-connect.png` |
| Visual evidence, private images, galleries/lightbox (#2102, #2370, #2462, #2538) | Updated [visual previews](docs/features/visual-previews.md); existing upload/storage limits retained | task/goal gallery and authenticated media routes; `previews.png` |
| `/fix F# S#`, multiline instructions, model routing (#2554, #2513) | [PR commands](docs/features/pr-commands.md) already current; release summary and README link to current identifiers | shared slash-command parsing and review selection; historical GitHub review image explicitly labeled |
| CI cancellation and non-blocking checks (#2560, #2562 and merged check-policy work) | [PR follow-up](docs/features/pr-followup.md) already covered workflow selection/restart; added closed-PR behavior; [configuration](docs/operations/configuration-reference.md) current | follow-up suspension, `closedPullRequestCiCancellation.ts`, `nonBlockingChecks.ts` |
| Agent/model updates, synthetic pools (#1994, #2131, #2275, #2511, #2619) | [agents/models](docs/features/agents-and-models.md), [synthetic pools](docs/features/synthetic-pools.md), [Agent Tank](docs/operations/agent-tank.md) current | model definitions (Opus/Sonnet 5.5), pool config/runtime; settings fixture uses current Claude models |
| Security, execution, reconciliation, operations (#2152, #2521, #2522, #2564, #2584, #2585) | Added goal/recovery and connected-client boundaries to [execution safety](docs/features/execution-safety.md) and [security](docs/concepts/security-overview.md); retained [maintenance](docs/operations/maintenance.md), [CI runners](ci-runners.md), [CI selection](ci-change-classification.md) | goal/worker recovery, access roles, desktop pairing, CI workflow sources |
| Push refresh, append logs and read performance (#2559, #2565, #2611) | Web UI live-update reference retained; removed five-second polling/mock-backend claims from UI README | activity subscriptions, live-detail hooks and API read paths |

## Release metadata

Root, all six release-versioned `@propr` packages, desktop package, matching root
lockfile records, caret dependencies, `PROPR_VERSION` and launcher version/image
pins are 0.9.0. Launcher `git_sha` records the audited base commit; publication
workflows generate their own source-bound manifests. Private UI (0.0.1), docs
(0.0.0) and launcher package (0.0.0), private-workspace `*` dependencies, API
compatibility date, third-party image versions and historical/legacy fixtures
retain their independent meanings. Entries from 0.8.15 and earlier are preserved.
The future release comparison and Unreleased links follow the release convention;
the v0.9.0 endpoint becomes available only after a release tag exists.

## Screenshot provenance and reproduction

Committed assets live in `docs/static/img/screenshots/0.9.0/`. They are captures
of production components/routes, with local example data and no live credentials.
The desktop image is a Chromium renderer capture, not an installed/native-window
capture. MCP connected apps uses the real local HTTPS consent/grant routes;
its fixture deliberately has no access-log table, so **Activity unavailable** is
an honest displayed state. The grant ID is an ephemeral test identifier.

From the repository root (after workspace dependencies and Playwright Chromium
are installed):

```sh
npm run build -w @propr/shared
npm run build -w @propr/client
npm run build -w @propr/core
PROPR_CAPTURE_PREVIEWS=1 npm run test:browser -w propr-ui -- \
  e2e/release-documentation.pw.ts e2e/goals-regressions.pw.ts \
  e2e/settings-layout.pw.ts e2e/new-task.pw.ts
MCP_CAPTURE_PREVIEWS=true NODE_ENV=test npx tsx --test packages/api/test/mcpBrowser.test.ts
PROPR_DESKTOP_MENU_PREVIEWS=.propr/previews/desktop node --test apps/desktop/scripts/desktop-native-menu.test.mjs
```

Copy only inspected captures into the committed asset directory:

| Capture basename | Documentation asset |
| --- | --- |
| `release-dashboard` | `dashboard.png` |
| `release-previews` | `previews.png` |
| `release-plan`, `release-plan-history` | `plan.png`, `plan-history.png` |
| `goals-queue` | `goals.png` |
| `new-task-desktop` | `new-task.png` |
| `settings-ai-models`, `settings-personal-notifications` | `settings.png`, `notifications.png` |
| `settings-mcp`, `mcp-connected-apps` | `mcp-settings.png`, `mcp-apps.png` |
| `mcp-consent-desktop` | `mcp-consent.png` |
| `desktop/linux-connect` | `desktop-connect.png` |

Existing image references were audited. README dashboard/planner references now
use current captures; GitHub PR/review images remain historical examples, labeled
as such. Existing logos remain. Dashboard placeholders in usage/metrics and the
plan-review placeholder are replaced. Uncaptured lower-priority placeholders are
comments, not broken image references or claimed evidence.

## Validation

Passed on this worktree:

- `EXPECTED_VERSION=0.9.0 RELEASE_TAG=v0.9.0 RELEASE_CANDIDATE=true npm run release:verify`.
- `node --test test/releaseValidation.test.mjs`: 15 tests.
- `npx tsx --test test/orchestratorProprUrlsDrift.test.ts`: 13 tests.
- Workspace/lock audit: all nine root/workspace manifests agree on versions and internal dependency ranges. Historical changelog sections from 0.8.15 and earlier compare byte-for-byte with the base.
- Shared, client and core workspace builds; Vite production build; UI and docs TypeScript checks.
- `npm run build --prefix docs`: production docs build succeeded with broken-link errors enabled.
- Static HTML audit: 62 rendered pages, 3,298 local href/src targets including fragments; repository Markdown audit: 17 files and 71 relative file/image references. No missing targets. External websites were not availability-checked.
- Playwright: 36 distinct tests across `dashboard-sections`, `new-task`, `settings-layout`, `task-details-visual-previews`, `goals-regressions` and `release-documentation`. The new capture initially used a full-path file locator where the UI shows a basename; corrected it and reran successfully. Capture assertions now wait for rendered opacity before photographing animated plan content.
- `PlanHistoryDialog.test.tsx`: 12 tests; automatic UI Docker-context postcheck: 2 tests.
- MCP browser suite: 3 tests, including real HTTPS consent, CSRF, revocation and reauthentication handling.
- Desktop native-menu/renderer fixture: 1 test exercising Linux/macOS dispatch with no skips.
- ESLint on the three changed/new UI browser specs; `npm run tips:generate` (14 tips, no catalog drift); `git diff --check`.
- All 12 committed PNGs were opened and visually inspected; largest is 209,239 bytes, well below 10 MiB. Five rendered-documentation preview images were inspected, with successful embedded-image decoding and a valid transient publication manifest.

Limits: captures exercise real UI components with fixture data, not live coding
providers, OS push delivery or production GitHub credentials. Desktop native
window decoration, installer/keychain/signing, Docker image startup and release
publication were not exercised. The full backend suite was not run for this
metadata/documentation change. Vite reports its existing large-chunk warning;
the MCP fixture reports its intentionally absent access-log table. No release,
tag, deployment or GitHub workflow operation was performed. The orchestrator
should keep the resulting PR **draft**.

## Issue #2636 validation follow-up

Reproduced the migration-owner argv failure: the launcher correctly selected
`propr/app:0.9.0`, while the test expected `propr/app:0.8.15`. The expectation now
reads `images.app` from the checked-in launcher manifest; the full strict argv
assertion still checks every flag, environment value, bind and command.

Audited the other `0.8.15` test references, including escaped regex literals.
The desktop local-setup discovery-401 compatibility cases and setup recovery
fixtures intentionally describe the legacy runtime. Desktop runtime-manifest and
preview-image tests retain legacy image rejection checks. The remaining desktop,
CLI and client references are explicit discovery, pairing, IPC, connection,
About/menu or version-validation fixtures, not current-release expectations.
All of these fixtures are preserved. The screenshot mapping now associates
`settings-mcp` and `mcp-connected-apps` only with their respective assets;
`mcp-consent-desktop` retains its separate consent row. All 12 assets are unchanged.

Passed after the fix:

- `node --test test/orchestratorMigrationPhase.test.mjs test/releaseValidation.test.mjs`: 28 tests (13 migration-phase and 15 release-validation).
- `npx --no-install tsx --test test/orchestratorProprUrlsDrift.test.ts`: 13 version/URL-drift tests.
- `EXPECTED_VERSION=0.9.0 RELEASE_TAG=v0.9.0 RELEASE_CANDIDATE=true npm run release:verify`: release metadata consistent for v0.9.0.

This follow-up changes only the migration test and this audit. The earlier
build/link/visual review remains recorded above; no application behavior or UI
changed, so no new visual previews were generated. The PR must remain **draft**
with Ultrafix disabled.

## Issue #2637 validation follow-up

On 2026-09-29, reproduced the API lint regression in `mcpBrowser.test.ts`: the
real-consent test callback had complexity 21 against the existing limit of 20.
Extracted the optional connected-app capture into `captureConnectedAppsPreview`,
reducing the callback complexity to 20. The capture flag, viewport, screenshot
path and animation setting are preserved, as are all real browser assertions
and lint rules. No application behavior changed.

Passed after the refactor on the `release/0.9.0-docs-fixed` base
(`73da70a516e41c94d2969ff8648972eb0fb3fc54`):

- `npm run lint -w @propr/api -- --max-warnings 0`: exit 0, zero errors and zero warnings across the full API workspace.
- `MCP_CAPTURE_PREVIEWS=false npm run test:mcp:browser`: 3 tests passed, 0 failed, 0 skipped; real HTTPS consent, desktop/mobile selection, CSRF, revocation and reauthentication assertions remain intact.
- `node --test test/orchestratorMigrationPhase.test.mjs test/releaseValidation.test.mjs`: 28 tests passed (13 migration-phase and 15 release-validation), 0 failed, 0 skipped.
- `npx --no-install tsx --test test/orchestratorProprUrlsDrift.test.ts`: 13 version/URL-drift tests passed, 0 failed, 0 skipped.
- `EXPECTED_VERSION=0.9.0 RELEASE_TAG=v0.9.0 RELEASE_CANDIDATE=true npm run release:verify`: exit 0; release metadata consistent for v0.9.0.

The browser fixture still reports its intentionally absent `mcp_access_log`
table. Screenshot capture was disabled; all 12 existing documentation PNGs
retain their pre-refactor SHA-256 hashes. No screenshots were recaptured and no
preview files were generated for this nonvisual change. Only the browser test
and this audit were edited; the release/docs implementation and migration fix
are preserved. These are local targeted validation results, not a claim that
broader CI or the full backend suite passed. The resulting PR must remain
**draft**, with ProPR owning commits, push and PR creation; no merge, release
publication, deployment, Ultrafix or recursive tasks were performed.
