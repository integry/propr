---
sidebar_label: "Validation only: stage-one Linux candidate (#3002)"
title: "Linux desktop validation candidate and open gates"
description: "Review the stage-one Linux desktop validation candidate, remaining native qualification, and package lifecycle acceptance gates."
---
# Validation only: stage-one Linux candidate (#3002)

This remains a **draft validation candidate**, not merge or publication approval.
It preserves the previously integrated planning/nightly, smoke cleanup, production
setup wizard and Electron/private crash-capture corrections from #2953, #2967,
#2974 and #2975, and stages all seven reviewed corrections below.
Original feature issues remain open; macOS qualification stays separate in #2976.

## Exact integration scope

Base: `103409d6979969a3b0e9c069002cc739716cf3a4` (main). Remote main and
the initial five remote PR heads matched these revisions when inspected on 2026-10-11.
This follow-up extends candidate `37fc70d6694e6a4b29e9ef6d6090ad051817431f`
serially. Remote main was checked again and still equals the exact base above.
No source advancement was substituted. Target branch: `main`. ProPR owns the
final commit and draft PR; this document cannot attest a not-yet-created head.

| PR | Proper diff base | Incorporated head | Correction |
| --- | --- | --- | --- |
| #2991 | `103409d6979969a3b0e9c069002cc739716cf3a4` | `95f4b24a7d4745795b34f223851ae86bb188fd1b` | Unconditional RPM strip override and real-maker native payload/identity regression |
| #2995 | `9fbca5e587ad1fb94e41de8c89be3af31177d59b` | `7db383f7b293b5d40e7079553176a02281a054c8` | Mobile contextual labels constrained to tab width; eight touch/accessibility/destination cases |
| #2996 | `9fbca5e587ad1fb94e41de8c89be3af31177d59b` | `1aaf068283eddad85d53a81c12574ac4d07cd699` | Independent full/live jobs and whole-phase budgets; sanitized, fail-closed health/bundle evidence |
| #2998 | `103409d6979969a3b0e9c069002cc739716cf3a4` | `4ee489625db477819a5fcd9c6476cc6ae6f530b9` | Current-history search writes retain selection, filters, hash and navigation intent |
| #3001 | `103409d6979969a3b0e9c069002cc739716cf3a4` | `7c338d09311fd173f56dedb0cb9f39d5d0b7727a` | Caller deadline includes admission; combined cancellation and synchronous workflow budget before create |
| #3003 | `103409d6979969a3b0e9c069002cc739716cf3a4` | `205cdb7f89f49b1bd35dc33cfcffa87633933481` | Container-width step labels and metadata; narrow/coarse-pointer run targets |
| #3004 | `103409d6979969a3b0e9c069002cc739716cf3a4` | `406f192eb7898abe2dec8d405de1c8b51855d7ec` | Single-line 44px plan-history restore footer and state/interaction regressions |

The 32 input paths are disjoint. The original 26 paths remain byte-identical
to their five source heads; all six mobile paths equal their two exact heads.
The full mobile diffs were inspected against `103409d`, not unrelated ancestry.
Their base blobs also equal the serial candidate blobs, so neither integration
required a conflict resolution or any test/production adjustment. For every
existing path, its content at the proper source base equaled its content on main;
the three added paths were absent on main. Each path below is **byte-identical to its listed source head**, with
the Git blob ID provided for independent verification. This preserves all other
main paths, including Hosted worker resolution and physical admission ancestry.

| Final changed path | Source PR | Source and candidate blob |
| --- | --- | --- |
| `apps/desktop/assets/linux/rpm.spec.ejs` | #2991 | `1168e8b6e2b10e08d52718c7689b3d3506f01cea` |
| `apps/desktop/src/rpm-maker.test.ts` | #2991 | `43f72cf075b8e0140ecd41b0d11a6499ac045967` |
| `propr-ui/e2e/automations.pw.ts` | #2995 | `e8e5fc0f58dced0b15f8ea292594d4db82a17c2c` |
| `propr-ui/src/components/MobileBottomNavigation.tsx` | #2995 | `3ed5661adcfa932565437a09725557509f1e026d` |
| `.github/workflows/test-nightly.yml` | #2996 | `9bf0424f08050c1a59807246488e17ea0fb8c2f5` |
| `apps/desktop/scripts/nightly-native-bundle.mjs` | #2996 | `e171a40584f49bc7cb7b8a9d2d370c061f86bb6e` |
| `apps/desktop/scripts/nightly-native-bundle.test.mjs` | #2996 | `a696a67bc1b66af2ae48ed2adffedd6401eda381` |
| `scripts/nightly-health-issue.mjs` | #2996 | `7d7b9e479630da773958fd1a9aee49b96068cd36` |
| `test/e2e.test.ts` | #2996 | `4aad59dbe364e687bd2fe073886c5b8b47942235` |
| `test/e2e/helpers.ts` | #2996 | `720cd24e0e8b82c27d1986ffd023389f51ffad1a` |
| `test/e2e/modelTaskTimeout.ts` | #2996 | `672ccb819a60ff1023d9265750b51436bbdb060a` |
| `test/e2e/planGeneration.ts` | #2996 | `0130ae0b02844ab80cf74d551758ec291cc825ae` |
| `test/e2eModelTaskTimeout.test.ts` | #2996 | `20d65c8663965414326009b6ad837933fa3aafe9` |
| `test/nightlyHealthIssue.test.mjs` | #2996 | `586118e6a93f4d9b26f20f91fd192879ee6d3fbf` |
| `test/nightlyWorkflowContract.test.mjs` | #2996 | `15ab37275d50a9c5deaffec3113a8e3db6e99a02` |
| `propr-ui/e2e/task-list-search.pw.ts` | #2998 | `a0d6c28a00bc876a63b29348db329c563720a1b1` |
| `propr-ui/src/components/TaskList.test.tsx` | #2998 | `519b5a96db8993abb9340f30dbe30a565d518e0b` |
| `propr-ui/src/components/TaskList.tsx` | #2998 | `b821f7a4f34f3eb8eb31f1b91335dec1e97bf92b` |
| `propr-ui/src/components/TaskList/hooks.ts` | #2998 | `9b41e5f456d18b97a9efab801e6c89123b1e8858` |
| `propr-ui/src/hooks/useTaskSelection.ts` | #2998 | `c9a48623cc2205e8bf3ff8594cb5aa4d3fca96f8` |
| `docs/docs/architecture/agent-run-admission.md` | #3001 | `363ad0eb69cae7e291b1c2adf60207e953183600` |
| `packages/core/src/agents/agentRunAdmission.ts` | #3001 | `17d51db822d8da5359e71234d297f75f81a6c119` |
| `packages/core/src/claude/docker/dockerExecutionDeadline.ts` | #3001 | `bf6f0634c50ad1edfd8a44592e3aa6e148c3ac74` |
| `packages/core/src/claude/docker/dockerExecutor.ts` | #3001 | `b5fdad3161955eda83813a8a46aa97791e0a0f5c` |
| `test/agentRunAdmission.test.ts` | #3001 | `116cf637ccebb1276d926d213624d5c2cf84b84e` |
| `test/fixtures/agent-admission/docker.mjs` | #3001 | `6929ab2f7e4a2d4184996bbea09c9550adaf4cfd` |
| `propr-ui/e2e/task-timeline-mobile.pw.ts` | #3003 | `36650152307d6cbdabef0f36a7988eaaec033f0f` |
| `propr-ui/src/components/TaskDetails/RunTimeline.tsx` | #3003 | `4e3e926d6a077afa04fc36099467013b10dc3c4b` |
| `propr-ui/src/components/TaskDetails/TaskStatusTable.tsx` | #3003 | `e7e41dfa0639204de85d2937fe5e73ab6d5bee1d` |
| `propr-ui/src/components/TaskDetails/runTimelineColumns.ts` | #3003 | `33fa0a8fba50ea21b32b7108b2e7782aaabcd530` |
| `propr-ui/e2e/planner-studio-mobile.pw.ts` | #3004 | `be5546e05228bb422c7d3e4d16388433ba28f8ed` |
| `propr-ui/src/components/TaskPlanner/PlanHistoryDialog.tsx` | #3004 | `c122d9c9526621ead34a066c9477c33f79198cae` |

The only additional changed path is
`docs/docs/operations/linux-validation-candidate.md` (this file): the validation
handoff, equivalence map and operator instructions. It extends the inherited
#2980 runbook without changing acceptance gates. Total: **33 changed paths**.
Compare each listed path with `git diff <incorporated-head> -- <path>` after the
final orchestration commit; each comparison must be empty. Compare the complete
base-to-candidate path list with this inventory, and rerun checks if any bytes
change. Do not infer combined CI success from any source PR's results.

## Seven-correction source evidence and boundaries

The initial candidate CI reported **42 success / 14 skip**. Skips are not passes,
and that result does not qualify this seven-correction candidate. The following
source evidence is supplied by the operator in the follow-up request, rather than
new executions or CI attestations by this staging session:

- #3003 exact `205cdb7`: independent **24 WebKit + 24 Chromium**, zero skips,
  retries or flaky cases; all **3394 tracked regular files** unchanged during
  qualification; 520px touch and 1920px aligned screenshots directly inspected.
  Both F1/F2 blockers resolved; independent Claude review **6113939661: 8/no
  blockers**. Optional S5/S6 gaps are closed by rendered browser runs, including
  wide coarse-pointer cases. Preserve intentional 44px hybrid-touch usability.
  Original standalone CI **38175937555 / 38175937592** was still running in the
  supplied record: no terminal result or inherited approval is claimed.
- #3004 exact `406f192`: root **19 WebKit + 19 Chromium** passed; original
  old-code footer control failed **3 lines versus 1**. Independent review **8/no
  blockers**; all **21 active CI** green, **805 canonical units once**, **325
  Build & Lint Chromium**; all five actual CI checkout trees equaled that head.
- Correction to stale #3001 evidence: exact `7c338d0` full suite passed **805
  canonical units once**, with all four original transports and exact-CI
  whole-tree equality. Independent **145 real-Redis/fake-Docker** cases and
  review **8/no blockers**. This does not qualify live providers or real Docker.

#3003 retains the 528px actual-container cutoff (stack below it), at least
260px labels in aligned rows, all narrow/coarse-pointer run buttons >=44px and
ordinary wide mouse density. Its source coverage includes touch/mouse, sidebar,
landscape and tablet. The standalone task-list Escape/search race is already
resolved by #2998; its existing cases are retained, neither duplicated nor waived.
#3004 retains a single-line 44px restore button fitting a 320px dialog, a
non-overflowing note, and read-only/loading/selection/restoring plus keyboard/tap
semantics. All original assertions remain intact.

Root still must independently review and test the **final combined head** in
Chromium, WebKit and native Linux. This reversible draft staging is not release
approval or completion. No publication, deployment, live nightly/provider
operation, credential/access change or cleanup feature is authorized here. Mac
remains separately deferred. Original preview publication authorization for
**681 applies only to 681**; runtime exception expiry remains **2026-10-17**.

## Seven-correction local validation

Executed on Debian 12 x64 as uid 1000, Node 22.23.3/npm 10.9.9, using the
seven-correction working tree above. The root lockfile remains SHA256
`6595f11797cad0660146317e3f7fe7bfd0ebcd8cfb095ca53c5458fe670c6108`.
Historical initial-candidate results in the next section are kept separately.

| Check | This follow-up execution |
| --- | --- |
| Locked `npm ci` | Passed; lockfile unchanged; reported 8 high vulnerabilities, assessed by unchanged scoped audits |
| `npm run test:prepare`, `npm run build`, `npm run desktop:typecheck` | All passed, including desktop and UI types |
| Strict relevant ESLint | Passed with `--max-warnings=0` for the prior core/UI correction files and all six new mobile paths |
| Focused Vitest | 97 passed in 5 files: TaskList, MobileBottomNavigation, RunTimeline, TaskStatusTable, PlanHistoryDialog; no failures/skips |
| Nightly/budget/plan/model/health/bundle/canonical-runner contracts | 207 passed, zero failures/skips |
| Execution/admission/cancellation/lease fencing/cost/network/workflow/Hosted worker | Canonical sequential runner: 15/15 files, 249 passed, zero failures/skips/cancellations, 109.0s; attempt 1, original 180,000ms per-unit timeout, real Redis/fake Docker |
| Real RPM/DEB/ZIP makers and libsolv metadata | Final run 9 passed, zero failures/skips. Initial run 7 passed / 2 skipped because extracted `cpio` was outside PATH; retained, not counted as passes |
| Production-build combined Chromium | 72 passed, zero failures/skips/retries, 3.5 minutes: 15 automations + 19 planner-mobile + 17 desktop-task-list + 2 search + 19 timeline-mobile |
| WebKit | Download succeeded; launch failed before tests for missing GTK4/GStreamer/libsecret and other runtime libraries; no combined WebKit execution/pass claimed |
| Runtime / packaging dependency audits | Both passed under unchanged policy; runtime exception remains present and expires 2026-10-17T00:00:00Z |
| Canonical discovery / four shards | 806 unique units; 202/202/201/201 exact disjoint union. Discovery only, not complete suite execution |
| Source/path equivalence | All 32 source paths match the seven exact heads in content and mode; exactly 33 changed paths against main including this runbook; no other main delta |
| Documentation | MDX compilation passed |

Temporary Debian package indexes and extracted tools under `/tmp/propr-3005-tools`
supply real Redis 7.0.15 and packaging prerequisites, without installing services,
changing host libraries or changing credentials/access. Initial Redis/RPM tool
launches exposed missing local dependencies; setup was completed before their
respective tests. The packaging retry only added the extracted `bin` directory
containing `cpio` to PATH; no assertions or source were changed. Real makers
verified the original pinned x64/ARM64 bytes and ELF identity; x64 performed
non-root identity publication and fresh-process persistence. ARM64 execution was
not performed on this x64 host. These fixture packages do not qualify the full
installed desktop, native GUI, preload/reload, secure store or setup lifecycle.

Logs are transient `/tmp/propr-3005-*.log`, with canonical focused results at
`/tmp/propr-3005-execution-summary.json`; the table is the handoff record.
The source-head browser counts above are operator evidence, not these local
combined counts. Full final-head CI, independent review, complete canonical
execution, native Linux/source-bound runtime qualification, live providers and
real Docker remain unqualified here. No acceptance gate, timeout, assertion,
retry policy, skip condition, native pin or runtime binding was weakened.

Reproduce the added combined UI checks with the locked production build (the
Playwright configuration builds and serves it locally). Keep all existing cases
and disable retries explicitly:

```sh
(cd propr-ui && npx eslint --max-warnings=0 \
  e2e/task-timeline-mobile.pw.ts e2e/planner-studio-mobile.pw.ts \
  src/components/TaskDetails/RunTimeline.tsx \
  src/components/TaskDetails/TaskStatusTable.tsx \
  src/components/TaskDetails/runTimelineColumns.ts \
  src/components/TaskPlanner/PlanHistoryDialog.tsx)
(cd propr-ui && npx vitest run \
  src/components/TaskList.test.tsx src/components/MobileBottomNavigation.test.tsx \
  src/components/TaskDetails/RunTimeline.test.tsx \
  src/components/TaskDetails/TaskStatusTable.test.tsx \
  src/components/TaskPlanner/PlanHistoryDialog.test.tsx)
(cd propr-ui && npx playwright test e2e/automations.pw.ts \
  e2e/task-list-desktop.pw.ts e2e/task-list-search.pw.ts \
  e2e/task-timeline-mobile.pw.ts e2e/planner-studio-mobile.pw.ts --retries=0)
```

The original reproduction commands below retain the core lint, contract tests,
15-file canonical execution selection, maker regression and audit invocations.
They also document the initial narrower UI selection; use the combined UI
selection above for this follow-up. The local browser runs use privacy-safe
intercepted APIs, without provider operations. The 320px history footer, 520px
touch timeline and 1920px aligned sidebar-hidden touch timeline screenshots were
directly inspected. Captures are transient review evidence only, not authorization
to publish runtime artifacts or a release.

## Initial five-correction validation (historical)

Environment: Debian 12 x64, uid 1000, Node 22.23.3, npm 10.9.9. All checks
used the combined files in the equivalence map. Root lockfile SHA256:
`6595f11797cad0660146317e3f7fe7bfd0ebcd8cfb095ca53c5458fe670c6108`.
These checks are fixture
evidence, not final-head CI, independent review, live nightly, actual Fleet
acceptance or normal installed-user qualification.

| Check | Result |
| --- | --- |
| Root locked `npm ci` | Passed; lockfile unchanged; npm reported 8 high vulnerabilities, evaluated separately by the unchanged scoped audit policy below |
| `npm run test:prepare` and `npm run build` | Passed for the shared/client/core/local-setup/CLI workspaces and root |
| `npm run desktop:typecheck` | Passed on one isolated rerun, including desktop and UI; original concurrent invocation aborted with exit 134 (retained) |
| Changed core and UI ESLint, `--max-warnings=0` | Passed, including both browser test files and TaskList tests; no threshold changes |
| TaskList and MobileBottomNavigation Vitest | 54 passed, 0 skipped |
| Nightly budget/plan/model/health/bundle and canonical-runner contracts | 207 passed, 0 failed, 0 skipped |
| Execution/admission/network/cost/workflow and Hosted worker tests | Canonical sequential runner: 15/15 files, 249 passed, 0 failed, 0 skipped, 111.4s; initial concurrent run: 245 passed, 1 failed, 0 skipped |
| Isolated real-Redis admission diagnostic rerun | 27 passed, 0 failed, 0 skipped, including both deterministic workflow-budget cases and saturation at 2/6/12 |
| Real RPM/DEB/ZIP maker regression and libsolv metadata tests | 9 passed, 0 failed, 0 skipped after completing user-local tool setup; initial attempt: 7 passed, 2 RPM payload cases skipped because cpio was outside PATH |
| Production-build Chromium, automations + desktop task list + delayed search | 34 passed, 0 skipped, 0 retries; includes all eight mobile 320/390px cases and original keyboard/dialog/typing assertions |
| WebKit | Blocked before testing: browser downloaded, launch failed for missing GTK4/GStreamer/libsecret and other runtime libraries; no WebKit pass claimed |
| Runtime / desktop packaging dependency audits | Passed under unchanged policy; runtime braces-related exception remains present and expires 2026-10-17T00:00:00Z; packaging audit passed without exception |
| Canonical discovery and four-shard coverage | 806 unique units, shards 202/202/201/201; union equals full discovery, no duplication; discovery is not execution |
| Changed documentation | MDX compilation passed |

The initial execution failure was `physical Docker wrappers saturate 12 across
processes and standard/native entrypoints` (`Timed out`). The single isolated
admission rerun passed without changing assertions or timing. Concurrent resource
contention is plausible, but its root cause was not established. The typecheck
abort is likewise preserved rather than erased by its successful isolated rerun.
The final serial focused run passed with the canonical runner's original
180,000ms per-unit timeout and no retries.
No production code, skips, assertions, timeouts or lint thresholds were altered
in response to these results.

Redis 7.0.15 and packaging tools were obtained from Debian package indexes into
an owned `/tmp/propr-3002-tools` directory, without installing services or changing
host permissions. The Redis fixtures bind separate loopback ports with persistence
disabled and own their teardown. Docker is simulated in these execution tests.
The real makers verified identical native payload hashes across RPM, DEB and ZIP:

- Linux x64: `7199378f1c7b443a05c596eae7c66f9a77cc01b4a493c07748df0df1083950f6`.
- Linux ARM64: `916679f413251c4b23c51167987a874bbbdd9d96991882bfac9093e0ea5fa051`.

All three x64 payloads passed real non-root identity publication and fresh-process
persistence. ARM64 payload bytes/ELF were verified, but ARM64 native execution was
not performed on this x64 container. The real makers package fixture applications,
not the complete installed desktop. Focused Chromium screenshots of mobile labels
and the closed pane were directly inspected; they are UI evidence only.

Reproduction of the focused checks (use the repository's locked dependencies and
real Redis/packaging binaries; missing prerequisites remain a limitation):

```sh
npm ci
npm run test:prepare
npm run build
npm run desktop:typecheck
(cd packages/core && npx eslint --max-warnings=0 \
  src/agents/agentRunAdmission.ts src/claude/docker/dockerExecutionDeadline.ts \
  src/claude/docker/dockerExecutor.ts)
(cd propr-ui && npx eslint --max-warnings=0 \
  src/components/MobileBottomNavigation.tsx src/components/TaskList.tsx \
  src/components/TaskList/hooks.ts src/components/TaskList.test.tsx \
  src/hooks/useTaskSelection.ts e2e/automations.pw.ts e2e/task-list-search.pw.ts)
npm exec --workspace propr-ui -- vitest run \
  src/components/TaskList.test.tsx src/components/MobileBottomNavigation.test.tsx
NODE_ENV=test npx tsx --experimental-test-module-mocks --test \
  test/e2eModelTaskTimeout.test.ts test/e2ePlanGeneration.test.ts \
  test/e2eTaskMatching.test.ts test/e2eTaskCompletion.test.ts test/e2eModelMatrix.test.ts \
  test/nightlyHealthIssue.test.mjs test/nightlyWorkflowContract.test.mjs \
  apps/desktop/scripts/nightly-native-bundle.test.mjs \
  test/testSuiteRunner.test.mjs test/ciFullSuiteSelection.test.mjs
# Use a real redis-server binary; do not substitute a fake or accept skips.
PROPR_TEST_REDIS_SERVER="$(command -v redis-server)" NODE_ENV=test PROPR_DEMO_MODE=true \
  node scripts/run-test-suite.mjs \
  test/agentRunAdmission.test.ts test/dockerExecutorWatchdog.test.ts \
  test/dockerExecutorEnvironment.test.ts test/dockerExecutorLiveOutput.test.ts \
  test/dockerTaskContainer.test.ts test/agentRunCostGate.test.ts \
  test/runCostCapEnforcement.test.ts test/repositoryWorkflowAdmission.test.ts \
  packages/core/test/dockerExecutionOwnership.test.ts \
  packages/core/test/dockerAbortController.test.ts \
  packages/core/test/dockerContainerControl.test.ts \
  packages/core/test/networkEgressExecution.test.ts \
  packages/core/test/repositoryWorkflow.test.ts \
  packages/core/test/workflowConcurrency.test.ts test/workerConcurrency.test.ts
npx tsx --test apps/desktop/src/rpm-maker.test.ts
(cd propr-ui && npx playwright test e2e/automations.pw.ts \
  e2e/task-list-desktop.pw.ts e2e/task-list-search.pw.ts --retries=0)
npm run audit:runtime
npm run desktop:audit:packaging
```

Local logs retain original failures separately from reruns under
`/tmp/propr-3002-*.log`, with the canonical focused summary at
`/tmp/propr-3002-execution-summary.json`. These transient files are not durable CI
artifacts; the results above are the handoff record. Complete 806-unit execution,
all-workspace/backend/UI/dependency/migration qualification and actual live E2E
remain required on the final candidate.

## Evidence policy

Final-head CI, independent review and native qualification must identify the exact
source revision and artifacts tested. Prior-source results and operator-session
logs remain in the PR review history; they are not qualification for a later head.
Recheck main at handoff and explicitly reconcile any additional delta. Do not
silently carry evidence across a changed source, harness, lockfile or runtime.
No final-head qualification is claimed by this document.

Retain the historical intermittent shutdown SIGSEGV and failed live-nightly
outcomes in the review record. The Electron update does not prove the crash cause;
#2973 remains open. Keep live-nightly dispatch paused until serving API evidence
explains the failure. Dependent early returns do not prove model implementation.
See [the shutdown investigation](./desktop-native-shutdown-investigation.md).

Both E2E suites wait a bounded interval for plan work, log settlement timeout and
continue cleanup of known resources. A request still pending at that point can
overlap cleanup; cancellation cannot undo a mutation already accepted by a remote
API. Recovery plan creation uses the shared slow-generation budget, with room in
the enclosing suite for the remaining recovery steps.

At the next exact-head native run, verify repeat preload attestation after each
reload, Electron zoom persistence, all five Continue stages with the default
draft, and the cancelled heading **Setup needs attention**. Unit and browser
fixture results do not establish these native behaviors. The original menu
Back-click timeout and concurrent stress crash remain unexplained.

## Reproduce on gram and the operator openSUSE machine

Run separately on gram and the operator's openSUSE machine, recording each host.
The coding container used here is Debian 12, not that openSUSE host. Use an
isolated clean checkout of the final candidate commit, with the qualified
ordinary-user X11/Secret Service synthetic-fixture session already available.
Do not change keyrings, credentials, permissions, sandbox policy, host libraries,
or grants to make a run pass. Run each command once initially; retain its exit,
signal and full log, including failures. Any additional diagnostic attempts must
have a declared count and retain every outcome. Commands below build local files
only; they do not publish or write image tags.

From the repository root, replace the placeholder with the final orchestration
commit (not one of the seven input heads):

```sh
set -euo pipefail
candidate_sha=<full-final-candidate-commit>
test "$(git rev-parse HEAD)" = "$candidate_sha"
test -z "$(git status --porcelain --untracked-files=normal)"
evidence_dir=$(mktemp -d /tmp/propr-3002-evidence-XXXXXXXX)
printf '%s\n' "$candidate_sha" > "$evidence_dir/source.txt"
node --version > "$evidence_dir/build-node.txt"
uname -a > "$evidence_dir/kernel.txt"
cat /etc/os-release > "$evidence_dir/os-release.txt"
sha256sum package-lock.json > "$evidence_dir/lock.sha256"
npm ci 2>&1 | tee "$evidence_dir/install.log"
npm run test:prepare 2>&1 | tee "$evidence_dir/prepare.log"
npm run build 2>&1 | tee "$evidence_dir/build.log"
npm run desktop:typecheck 2>&1 | tee "$evidence_dir/types.log"
npm run desktop:test 2>&1 | tee "$evidence_dir/desktop-tests.log"
npm run desktop:package 2>&1 | tee "$evidence_dir/package.log"
npm run desktop:smoke:inspect 2>&1 | tee "$evidence_dir/inspect.log"
sha256sum apps/desktop/out/propr-desktop-linux-x64/propr-desktop \
  apps/desktop/out/propr-desktop-linux-x64/resources/app.asar \
  > "$evidence_dir/package.sha256"
npm run desktop:smoke 2>&1 | tee "$evidence_dir/smoke-ordinary.log"
crash_evidence_dir=$(mktemp -d /tmp/propr-3002-crashes-XXXXXXXX)
PROPR_DESKTOP_NATIVE_CRASH_DIRECTORY="$crash_evidence_dir" \
  npm run desktop:smoke 2>&1 | tee "$evidence_dir/smoke-capture.log"
env -u PROPR_DESKTOP_ACCEPTANCE_OUTPUT \
  npm run desktop:acceptance 2>&1 | tee "$evidence_dir/visual.log"
env -u PROPR_DESKTOP_ACCEPTANCE_OUTPUT \
  npm run desktop:acceptance:verify 2>&1 | tee "$evidence_dir/visual-verify.log"
cp -a desktop-acceptance-artifacts "$evidence_dir/visual"
PROPR_DESKTOP_REAL_LINUX_SETUP_ACCEPTANCE=1 \
PROPR_DESKTOP_SETUP_ACCEPTANCE_SOURCE_SHA="$candidate_sha" \
PROPR_DESKTOP_SETUP_ACCEPTANCE_OUTPUT="$evidence_dir/linux-setup-lifecycle.json" \
  npm run desktop:acceptance:setup-linux 2>&1 | tee "$evidence_dir/setup-lifecycle.log"
sha256sum -c "$evidence_dir/package.sha256"
```

Capture and verification both use the supported default
`<repository-root>/desktop-acceptance-artifacts`, with any inherited
`PROPR_DESKTOP_ACCEPTANCE_OUTPUT` override unset for each command. Only after
verification succeeds is that directory copied into the owned evidence directory;
the copy is optional. Do not use the evidence directory as the capture output:
artifact cleanup requires the dedicated basename and an allowlisted canonical
parent, and rejects symlinks.

Stop on failure and retain the result; subsequent independent checks can be run
separately with that failure still recorded. The complete smoke is four isolated
launches per invocation, with all existing credential scans, shutdown, connection,
fuse and sandbox checks. The visual verifier must accept **67 captures**, production
`LocalSetupWizard` presentation, zero serious/critical findings, and all **seven
200% zoom keyboard actions**: Continue, Cancel safely, Back, Review saved choices,
Restart with aligned runtime, Retry setup, Connect securely. Inspect original
captures as well as machine reports. Browser-only preview evidence cannot satisfy
this gate. The separate setup report must say `verified`, with bounded cancellation,
fresh retry, interrupted relaunch and owned cleanup; exit zero with `unverified`
means the lifecycle is still pending. This bounded harness stops before actual
provisioning or GitHub enrollment.

Record source/tree and lock hashes, harness source, binary and app.asar hashes,
architecture, actual Electron/Chromium/embedded Node versions from each diagnostic
`runtime.json`, installed libc/libsecret/GLib versions and relevant ELF build IDs.
Electron must actually be 44.7.0; build-time Node is a separate value. Keep raw
crash dumps private and outside preview/public artifact roots. Follow the
[upstream fixture procedure](./desktop-native-shutdown-investigation.md#regression-provenance-and-remaining-acceptance)
for unchanged official fixture bytes and all three upstream success assertions.

Packaging without an explicit source-bound runtime manifest embeds the checked-in
launcher metadata: record it as **unbound**, even if the app and harness match the
candidate. Do not count that as current-source full setup/task qualification.
If an already-approved runtime manifest is supplied separately, verify its source
revision, API compatibility, architecture, and immutable app/UI/agent digests before
passing `PROPR_DESKTOP_RUNTIME_MANIFEST` to packaging; record its hash and the
packaged manifest. Never borrow another PR's/frozen preview's binding or stamp the
candidate SHA onto old images. New image/tag writes and runtime publication require
a separate decision and are outside this staging task.

## Remaining qualification

Integration CI and independent review on the final head, actual native Linux
acceptance, mobile/usability checks, actual live E2E, first-user sign-in/pairing/task,
and proof of all three existing-repository access boundaries remain pending.
The frozen preview and all publication decisions stay unchanged. Existing docs
risk acceptance and runtime exception expiry are unchanged. #2976 macOS guided
setup stays on its separate qualification branch; human Safe Storage approval and
real GUI lifecycle remain pending, not excluded or implicitly complete. No
user-owned server cleanup, TTL, or repository inventory work is included.

## Package and installed-lifecycle operator gates

From the same clean, source-identified checkout and evidence directory above,
run on native Linux x64 and separately on native ARM64 (cross-build success does
not establish ARM execution). Record the explicit target and all six DEB/RPM/ZIP
artifact hashes, metadata architecture, sandbox owner/mode, fuse and native-addon
hash checks. Do not edit pins or strip/sandbox settings to accommodate the host.

```sh
# Set to x64 on gram/the x64 openSUSE host; arm64 only on a native ARM64 host.
target_arch=x64
PROPR_DESKTOP_ENABLE_DEB=1 PROPR_DESKTOP_ENABLE_RPM=1 \
  npm run make --workspace=@propr/desktop -- --platform=linux --arch="$target_arch" \
  2>&1 | tee "$evidence_dir/make-$target_arch.log"
npx tsx --test apps/desktop/src/rpm-maker.test.ts \
  2>&1 | tee "$evidence_dir/maker-payloads-$target_arch.log"
find apps/desktop/out/make -type f \
  \( -name '*.deb' -o -name '*.rpm' -o -name '*.zip' \) \
  -exec sha256sum {} + > "$evidence_dir/packages-$target_arch.sha256"
```

Require all real-maker cases to execute; missing tools/skips remain pending.
The maker tests use fixture applications with actual pinned native addons. Their
x64 identity probe does not prove installation, sign-in, pairing or a real task.
Extract each actual application package with `dpkg-deb -x`, `rpm2cpio | cpio`, or
`unzip` into separately owned evidence directories and compare its unpacked
`directory-operations.node` to the checked-in architecture-specific prebuild;
record the packaged runtime manifest as well. Inspect DEB/RPM architecture and
sandbox metadata, not merely the filename. Repeat unchanged packaged smoke and
native acceptance against the matching actual package, retaining every failure.

For installed install/launch/upgrade/relaunch/remove evidence, use the existing
`npm run desktop:acceptance:install-linux --` harness with its explicit `--arch`,
`--previous-version`, `--version`, `--previous-deb`, `--deb`, `--previous-rpm`,
`--rpm`, and `--sandbox-isolation` arguments. It requires canonical artifact
names, strictly ordered versions, a matching native host, approved disposable
package-manager containers and `PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE=1`.
For example, with already prepared canonical artifacts and versions, the
existing default-isolation invocation is:

```sh
# Operator supplies previous_version, candidate_version, previous_deb, candidate_deb,
# previous_rpm and candidate_rpm from the approved artifact inventory.
PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE=1 \
  npm run desktop:acceptance:install-linux -- \
  --arch "$target_arch" \
  --previous-version "$previous_version" --version "$candidate_version" \
  --previous-deb "$previous_deb" --deb "$candidate_deb" \
  --previous-rpm "$previous_rpm" --rpm "$candidate_rpm" \
  --sandbox-isolation docker-default \
  2>&1 | tee "$evidence_dir/installed-$target_arch.log"
```

Select only an already authorized isolation mode; do not add host permissions or
access grants for this task. Preserve failed lifecycle evidence and user-data
preservation assertions. Disposable package-manager tests supplement the human
normal installation and first-user session on the openSUSE machine; they do not
replace it.

Ordinary CI artifacts with checked-in c2de/version runtime bindings stay
**unbound to this candidate**. Source-bound acceptance requires an independently
approved manifest whose source is the final candidate SHA, whose compatibility
and architecture match, and whose app/UI/agent image references are immutable
verified digests. Record manifest, source/tree, lockfile, binary and artifact
hashes together. The above commands neither create nor authorize runtime image
publication. If no approved matching runtime exists, full source-bound setup and
real-task qualification remains blocked, even when payload tests pass.

## Full release scope retained

- Exact integrated source, complete final-head CI and independent review, all
  canonical workspace/backend/UI tests, dependency audits and migration checks.
- Actual live E2E; assignment, GitHub and intake behavior; partial-failure actor
  boundaries and creator attribution; cancellation, entitlement, cost and network
  enforcement. Semantic API disconnect propagation is still incomplete; finite
  execution deadlines do not claim to complete it.
- Phone/tablet/touch, keyboard/dialog/typing ownership, zoom and accessibility;
  mobile targets remain at least 44px. Native wizard 67-capture and seven 200%
  keyboard gates, unchanged smoke, and bounded real setup lifecycle remain required.
- Linux x64/ARM64 package payload integrity and installed lifecycles; this
  openSUSE machine's normal first-user install, sign-in/pairing/secure-store and
  real task; all three existing authorized repository fixtures and access
  boundaries. Fake Docker fixtures are not actual Fleet acceptance.
- Separate #2976 Mac human GUI/Keychain/Safe Storage lifecycle and publication
  gates. Exact 681 preview publication decisions and existing docs risk
  acceptance are unchanged; runtime exception expiry stays **2026-10-17**.

The original actual nightly run 681 result (**34 passed, 3 failed**, shared deadline)
is retained and not waived. No replacement actual live nightly was dispatched.
The corrected #3001 exact-head evidence is recorded above; its pass is source
provenance and is not inherited as final combined qualification. Combined review
and qualification remain pending. No merge, publication, deployment,
image/tag write, protected approval, credential/keychain operation, access grant,
user-owned storage cleanup or repository inventory is part of this candidate.
The original issues are not closed and their PRs are not claimed merged.
