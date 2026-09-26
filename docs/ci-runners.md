# CI runner routing

The owner chose rootless Docker isolation on gitfix.dev instead of VM migration
for this pilot. Compatible Linux x64 checks support four workers labelled
`[self-hosted, Linux, X64, propr-rootless]`. Four independent matrix shard jobs
remain, one job per available worker, without a nested coordinator. Other
eligible jobs share this pool, so simultaneous shard starts are not guaranteed.
These PR check jobs never select the old generic `propr` label.

**Leave `PROPR_ROOTLESS_PR_CHECKS` unset until the owner supplies host pilot
evidence.** Only the explicit value `true` opts in; unset, empty or `false`
selects GitHub-hosted runners. Set it to `false` or remove it as the operational
off switch. This implementation does not set repository variables, provision
host services, change GitHub permissions, merge or deploy.

## Approval-based trust model

The owner reports enabling manual approval for all external contributors.
Fork workflows require manual approval and their ordinary route is hosted.
Approval must include review of workflow edits and requested runner labels:
PR-editable routing is **not strict admission control**. An approved fork can
edit its workflow to request these labels directly. The flag signifies rootless
execution, not independently enforced fork exclusion. Neither setting nor
requiring `PROPR_SELF_HOSTED_PR_ACCESS_VERIFIED` would establish that guarantee;
it is no longer consulted. The previous `PROPR_SELF_HOSTED_PR_CHECKS` flag also
has no effect on these routes.

Rootless contains processes under dedicated unprivileged host accounts. It is
not a VM, does not provide a separate kernel, and is not a guarantee against
kernel exploits or cross-job persistence. Jobs with a worker's Docker socket
control that user's daemon and can leave containers or other state behind.
Job cleanup is hygiene, not a security boundary. Approval settings are an owner
report, not independently verified security evidence from this implementation.

## Placement after activation

Eligible events are same-repository PRs except Dependabot, and manual dispatch
on the repository's default branch. Forks, Dependabot, other events and
non-default-branch dispatches select hosted runners. This selection is tested
for consistency across all eligible jobs.

| Workflow | Jobs | Activated placement |
| --- | --- | --- |
| `pr-test-on-label.yml` | `shard` (four entries), `docs` | gitfix.dev rootless pool |
| `pr-build-check.yml` | `validate`, `cli-node-matrix` | gitfix.dev rootless pool |
| `cli-node-compatibility.yml` | `project-options` | gitfix.dev rootless pool |
| `pr-test-on-label.yml` | `native-electron` | Hosted Ubuntu, mandatory native assertions |
| `pr-build-check.yml` | `cli-agent-skill-glibc-231` | Hosted Ubuntu; disposable glibc 2.31 container and ordinary-user ownership changes |
| Native macOS, Windows and ARM64 checks | Existing platform jobs | Matching hosted platforms |
| Desktop Linux x64 packaging/acceptance | Existing desktop jobs | Hosted: ordinary-user sandbox, desktop/session and clean-environment requirements remain |
| Change classification, aggregate gate and failure reporters | `classify`, `test`, `comment` | Hosted control/reporting jobs |

Build/lint/docs coverage is unchanged in kind; see
[Deduplicated validation](#deduplicated-validation) for the invocations that
moved rather than disappeared. No `pull_request_target` execution or
permission expansion is introduced. Release/deployment workflows, including the
separate label-authorized PR Preview deployment, are unchanged.
The glibc and desktop exceptions retain their existing environment validation;
they are not weakened to fit the rootless pilot.

## Expected pilot topology and workflow prerequisites

Host provisioning and validation are separate owner-managed work. This is the
expected contract, not a claim that the workers are configured or validated:

- Each worker has a dedicated unprivileged host user, a user-scoped rootless
  Docker daemon, and its own runner installation, work and temporary directories.
  The runner executes in a container on that daemon and connects only to that
  daemon's socket. Production `/var/run/docker.sock`, production credentials,
  other users' sockets and host Docker client credentials are never mounted.
- Export an explicit `DOCKER_HOST=unix:///run/user/<host-uid>/docker.sock` in the
  runner container, with its own socket mounted at that path. Unset
  `DOCKER_CONTEXT`, `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH`. Job setup replaces
  HOME and Docker client config, so a saved HOME-based Docker context is not a
  reliable endpoint. `ci-rootless-preflight.sh` rejects default/remote/production
  endpoints, checks the daemon reports rootless, and requires cgroup v2/systemd.
  It does not prove socket ownership, host mount isolation or effective limits.
- CI paths used as Docker bind sources must contain the same files at the same
  absolute path inside the runner and the daemon's host mount namespace. Map
  the workspace, work/temp roots and any bind-source scratch paths accordingly;
  runner-only container paths do not satisfy sibling-container binds. The lint
  tools use read-only `--mount` binds, which fail for missing source directories
  rather than creating empty host directories. Pilot evidence must also prove
  file identity, not merely that a path exists.
- The runner uses `--network host` inside its own daemon's RootlessKit network
  namespace, **not production host networking**. Redis publishes a dynamically
  assigned loopback port; the runner must be able to reach that port. Validate
  this with the actual Docker version and network driver. Ordinary bridge
  networking gives the runner a different loopback and breaks this assumption.
- Per-user cgroup limits cap the runner and sibling Docker workloads together:
  target `CPUQuota=200%`, `MemoryHigh=6G`, `MemoryMax=8G` per worker, at most eight
  CPU equivalents and 32 GiB across four users. Delegate the controllers needed
  for CPU, memory and PID limits. The workflow does not configure these limits.
  Redis keeps `--memory 512m --memory-swap 512m --cpus 1 --pids-limit 64`;
  lint tool containers keep `--memory 1g --memory-swap 1g --cpus 1
  --pids-limit 256`, `--network none` and `--rm`. Individual limits supplement
  the combined user cap. Daemon metadata alone cannot prove their enforcement.

The runner image must already provide Bash, Git, Docker CLI, curl, tar, gzip,
unzip, Python 3, make, g++, sha256sum, timeout and bootstrap Node/npm (Node 22+
for pre-setup diagnostics). Setup-node selects each job's requested Node version;
its tool cache and the workspace/temp paths must be writable by the runner's
container user. Browser libraries, CA certificates and native build dependencies
belong in the runner image. Jobs install npm packages and browser binaries into
job state; they never apt-install system packages into the production host.
Missing prerequisites fail rather than trigger host provisioning.

Container UID 0 is not proof of host root, and nonzero UID is not proof of a
rootless daemon. Record both the runner-visible UID and the externally verified
host user/daemon mapping. Native Electron and desktop checks retain their hosted
ordinary-user sandbox/session environments; no sandbox flags or assertions are
weakened for the pilot.

Every eligible job uses clean checkout and `persist-credentials: false`. HOME,
XDG state, Docker client config, npm and Playwright caches are job-local under
`RUNNER_TEMP`; docs also gets `PROPR_CACHE_DIR`. A private `/tmp/propr-ci.*`
directory avoids long Chromium socket paths. The shard build verifies old dist
output is absent and fresh output exists.

Final `always()` steps remove generated files only from the job's own workspace
and private temp directory. Shards stop only owned Redis containers, on the
validated rootless daemon; failed preflight cannot enable Docker cleanup.
Runner-managed process/temp cleanup still applies. Hard failure can bypass
cleanup; recovery removes only the same owner's older Redis attempts. No global
prune or cleanup of other workers/daemons is introduced.

Before activation, the owner supplies all four user/daemon/runner mappings,
mount and file-identity evidence, Redis loopback reachability, effective per-user
and per-container resource enforcement (including concurrent workloads), and
network/production-access evidence. `ci-runner-evidence.sh` records placement
and container-visible cgroups; hidden parent limits require host-side evidence.
No activation or completed security checks are claimed by this design.

Docker's [rootless client and resource-limit documentation](https://docs.docker.com/engine/security/rootless/tips/)
and [networking limitations](https://docs.docker.com/engine/security/rootless/troubleshoot/)
explain the endpoint, delegation and namespace assumptions.

## Change-based job selection

Which checks a pull request runs is decided once, by the shared classifier
described in [CI change classification](ci-change-classification.md). Nothing in
that policy changes runner eligibility, the rootless opt-in, the hosted
fallback, the preflight, isolation, Redis ownership, cleanup or superseded-run
cancellation described in this document. It only decides whether a job is
applicable to the change set, and every gate skips solely on an explicit `false`
decision, so a failed or missing classifier runs the work.

`Run Full Test Suite`, with all four shards, its coverage verification, the
docs/test-preparation job and the hosted native Electron units, still runs
unconditionally on every pull request.

## Deduplicated validation

Eight rootless jobs now serve a pull request instead of eleven: four shards,
docs, `validate`, and the two `cli-node-matrix` entries. The three that went
away — `visual-previews` and both `cli-init-json` matrix entries — did so
because another enforced check already ran the same assertions in at least as
capable an environment. Nothing was made optional, and no timeout, shard count
or worker count changed.

### Focused suites the full suite already covers

`Run Full Test Suite` discovers every `*.test.*`/`*.spec.*` file under `test/`
and under each non-native workspace, and runs `propr-ui` as four vitest
`--shard` parts. `Build & Lint Check` used to re-run five focused subsets of
exactly that set.

| Removed invocation | Units | Covering gate | Environment |
| --- | --- | --- | --- |
| `visual-previews` job (`npm run test:visual-previews`) | 17 server files + 7 `propr-ui` files | Shards + `propr-ui` parts | Job-level `PROPR_DEMO_MODE=true` was inert: both tests that depend on it set it themselves. The shards additionally provide isolated Redis. |
| `npm run test:notifications` | 12 server files + 15 `propr-ui` files | Shards + `propr-ui` parts | Identical (`NODE_ENV=test`) |
| `npm run test:mcp` and `test:mcp:browser` | 12 files | Shards | The shard job installs the same Chromium |
| `npm run test:unit` | 35 files | Shards | Identical |
| Hosted tunnel step, now `npm run test:hosted-tunnel` | 12 server files + 2 `propr-ui` files | Shards + `propr-ui` parts | `PROPR_DEMO_MODE=true` was inert: these tests inject the value through fixtures |

Branch protection was inspected before removing anything. The repository
ruleset on `main` carries only `deletion` and `non_fast_forward`, and
`gh pr checks <pr> --required` reports no required status checks on the branch,
so no named check in this repository is a configured merge gate today. The
names are still treated as the merge contract: `Run Full Test Suite`,
`Validate Changes`, `CLI Agent Skill (Node 22)` and `CLI Agent Skill (Node 24)`
are unchanged, and the two removed names — `Visual preview release matrix` and
`CLI init JSON (Node 22|24)` — were removed rather than left as empty
always-green jobs, because a green placeholder would assert validation that no
longer runs there.

`test/ciWorkflowDeduplication.test.mjs` re-derives the full-suite manifest and
fails if any named file stops being discovered, if a focused package script
disappears, if the build check starts running one of them again, or if the full
suite acquires a path filter that could hide the gate. All the focused scripts
remain in `package.json` for local runs.

The full suite skips shards on draft pull requests, as it did before; the build
check has never been the gate that drafts rely on for test results, and a draft
cannot be merged.

### Assertions that stay in the build check

The PWA and mobile browser smoke test runs Playwright `*.pw.ts` specs. Those
match neither full-suite discovery nor the `propr-ui` vitest config, so it is
not duplicated and keeps its own Chromium install. CLI release packaging,
release-candidate metadata, workflow lint, release shell lint and the
changed-area lint/typecheck/build gate are likewise unique and unchanged, and
`Validate Changes` still fails closed on the changed-area result.

### One Linux CLI job per Node version

`CLI init JSON (Node 22)` and `CLI init JSON (Node 24)` ran a second `npm ci`
and a second `@propr/shared` + `@propr/local-setup` build purely to execute one
test file. That command is now a step of the existing `CLI Agent Skill (Node N)`
job, whose check name is unchanged; the Node 22 and Node 24 matrix entries both
remain, and the native glibc 2.31, Darwin and Windows proofs are untouched.

The Agent Skill suite, the init JSON test and the CLI build each keep their own
step and outcome, so a failure in one still reports the others exactly as two
independent jobs did. The final gate is fail-closed: any constituent that is
not an explicit `success` — failed, cancelled, skipped or never run — fails the
check and is named in an `::error::` annotation.

### Work removed inside a job

`Validate Changes` built `@propr/shared` up to three times per run. The MCP
preparation build (`npm run test:prepare`) went away with the MCP step; the CLI
packaging step already builds `@propr/shared` and `@propr/local-setup` from the
same checkout, on the same runner, with the same toolchain, so the changed-area
checks and the Playwright smoke test reuse them. Reuse requires both the
recorded success of that step and the presence of the built entry point, and
falls back to building otherwise. The root `tsc` build's dependency on
`@propr/local-setup` — `packages/api` imports it through its published types,
while `@propr/core` and `@propr/shared` are mapped to their sources by the root
tsconfig — is now explicit instead of relying on a preparation step.

The desktop `prepare:renderer` script builds four workspaces and is a
pre-script of `package`, `typecheck`, `test`, `make` and
`test:native-durability`. A single packaging job therefore ran those four `tsc`
builds up to four times over byte-identical sources.
`apps/desktop/scripts/prepare-renderer.mjs` now records a stamp keyed to the
source files git reports for every built workspace, the assets the CLI build
copies in, the root manifest and lockfile, and the running Node version,
platform and architecture. A failed or output-less build writes no stamp.

Reuse requires two things to still hold. The key must match: any changed byte,
Node major, platform or architecture rebuilds, and so does a source that git
still lists but that no longer exists on disk — a deletion or rename that has
not been staged is keyed as absent, which invalidates the stamp and lets the
compiler judge the new tree instead of aborting the hash. A read failure that
is not a missing file (a permission denial, a directory where a file belongs)
still fails the script rather than granting reuse.

The generated tree must also be exactly the one that was built. The stamp
carries the complete inventory — every file under each workspace's `dist`,
with its size, so nested modules, their declarations and the copied asset trees
are all covered, not only the entry points a later step loads by name. Removing
or replacing any of them rebuilds. Incremental `.tsbuildinfo` state is excluded
from both the inventory and the key, because `tsc --noEmit` rewrites it without
producing output. The declared `outputs` list remains as the post-build check
that fails a build which exits 0 without emitting what later steps load.

Nothing is cached, uploaded or downloaded: the stamp lives under
`node_modules/.cache`, which `npm ci`, a clean checkout and the self-hosted
`git clean -ffdxq` all discard, so no build output crosses a job, a machine or
a trust boundary. The full suite still asserts `test ! -e packages/shared/dist`
before preparing its own workspace.

### Desktop latency floor

Desktop validation is a separate gate from the Linux pull-request checks and it
is not redesigned here. macOS x64 (`macos-15-intel`) remains the longest
desktop path: it must package natively, make and mount a DMG, run the packaged
inspection and the packaged Connect lifecycle, and none of that has a
demonstrably safe shortcut that keeps the native architecture, install,
deep-link, relaunch, removal, signing and acceptance assertions intact. Only
the repeated renderer preparation was removed. Desktop therefore remains a
multi-minute gate on any pull request that touches its path filters, and total
pull-request wall-clock time is still bounded by it.

## Redis ownership

`scripts/ci-redis.sh` computes `propr-ci-redis-<sha256>` from the NUL-delimited
run ID, job ID, instance (including empty), and attempt. This avoids both
component-boundary and sanitization collisions. Matrix jobs pass
`CI_REDIS_INSTANCE=shard-N`. State files use the same hash in the job's temp
directory; optional `CI_REDIS_ENV_FILE` separates connection settings.
Docker assigns each container a loopback-only port.

Before every removal, including `stop`, the helper inspects the Redis marker,
run, job, instance and attempt labels. It removes by the inspected immutable
container ID, not a name that could have been replaced. `start` recovers only
older attempts matching the exact owner; it preserves newer attempts and all
other owners. An unexpected owner fails closed. Existing callers with no
instance, including nightly, retain one container per job and attempt.

Regression tests prove `job=shard, instance=default` and
`job=shard-default, instance=<omitted>` coexist and either stop order preserves
the other. They also cover foreign labels, tampered state, field-boundary
collisions, retries and resource limits using a Docker CLI double.

## Coverage, required check and partial reruns

Sorted discovered test units are assigned deterministically to four shards.
Files run serially within each shard with fresh data directories and an
isolated Redis flush between files. Native workspace suites such as `propr-ui`
are split into four workspace parts. Docs preparation runs once in its own job.

Every unit is bounded by the same per-unit timeout (`PROPR_TEST_TIMEOUT_MS`,
180s by default). `propr-ui` once crossed it as a single unit and failed the
nightly suite with no earlier signal, so the timing report now also lists the
units that passed while using 60% or more of that budget, and each one becomes
a run annotation. A unit listed there is the next one to split.

The shared runner's disk serves fsync slowly, and the desktop profile-store
suites perform several hundred per run; `apps/desktop/src/profile-store.test.ts`
took 90-124s there before crossing the budget. The runner therefore sets
`PROPR_DESKTOP_TEST_FSYNC=off` for every unit, and those suites (with their
crash fixtures) turn file-handle fsync into a no-op for the process. Their
assertions cover write ordering through the store's hooks and crash recovery
after SIGKILL, which the page cache preserves. Native fsync stays in force for
`desktop:test`, the `test:native-durability` matrix and any direct `tsx --test`
run, and an explicit value of the variable is passed through unchanged.

The required **Run Full Test Suite** name stays unchanged. Its gate requires
all shards, docs, complete summary verification, and the hosted native Electron
job to succeed. Electron runs on hosted Ubuntu on both routes with
`PROPR_REQUIRE_NATIVE_ELECTRON=1`; an unavailable binary/headless environment
fails instead of silently skipping assertions. The shared-host shards retain
the full unit manifest, and hosted Electron supplies mandatory native execution.

The gate verifies every discovered unit ran exactly once across the four
selected summaries. Failed, cancelled, skipped or missing results fail closed.
Artifact names include run ID, attempt and shard. On a partial rerun the gate
uses the newest attempt per shard and retains passing earlier-attempt artifacts.

Shard logs and build failure logs are sanitized before upload, raw copies are
removed, and comments read the sanitized artifacts. Shard stage records contain
actual runner names and attempts. A newer PR push cancels the superseded run;
its gate fails closed and its failure reporter avoids posting a stale comment.

## Verification and timing evidence

Local regression validation covers Redis ownership, rootless prerequisites,
routing activation and fork/default-branch cases, coverage verification, partial reruns, mandatory
Electron enforcement, sanitization and cleanup. Docker ownership tests use a
CLI double; no real Docker daemon or gitfix.dev execution was available here.

The following is **pre-change baseline evidence only**, from head
`04332060be3baff9b31afd09118e3aefe929147b`, attempt 1. It cannot validate the
resulting follow-up head or prove self-hosted placement.

| Check | Actual `runner_name` | Queue (created to started) |
| --- | --- | --- |
| Full suite shard 1 | `GitHub Actions 1000041693` | 2 s |
| Full suite shard 2 | `GitHub Actions 1000041694` | 2 s |
| Full suite shard 3 | `GitHub Actions 1000041689` | 3 s |
| Full suite shard 4 | `GitHub Actions 1000041692` | 3 s |
| Docs | `GitHub Actions 1000041695` | 2 s |
| Run Full Test Suite | `GitHub Actions 1000041716` | 3 s |
| Validate Changes | `GitHub Actions 1000041706` | 2 s |

[Full suite run 35783212970](https://github.com/integry/propr/actions/runs/35783212970)
succeeded, with API creation-to-final-update duration **5m37s**.
[Build/lint run 35783212968](https://github.com/integry/propr/actions/runs/35783212968)
succeeded in **5m16s** by the same measure. All executed jobs in these two runs
were hosted; native Electron was disabled in that earlier head. These are not
claims that this follow-up's required checks have passed.

### Expected effect of the deduplication

The pre-change reference for this follow-up is PR #2469 head
`0d08e4dc09ba18a2850fc02720c138d1af0ed910`:
[full suite 35841864469](https://github.com/integry/propr/actions/runs/35841864469)
15m39s with shards of 406/427/400/391 s started after 133/417/527/134 s of
queueing, [build/lint 35841864435](https://github.com/integry/propr/actions/runs/35841864435)
585 s on one worker, and
[desktop 35841864440](https://github.com/integry/propr/actions/runs/35841864440)
13m51s dominated by macOS x64 at 684 s.

The changes here remove three rootless jobs (eleven to eight on four workers)
and the notification, MCP, fast-unit, hosted-tunnel and visual-preview
invocations plus one `@propr/shared` build from `Validate Changes`. Queue time
is a function of pool occupancy, so the expected effect is shorter shard
queueing and a shorter build/lint job — **these are projections until a real
run on the rootless pool is measured, not results.** Desktop is untouched apart
from renderer preparation and remains an approximately fourteen-minute gate, so
no claim about total pull-request time below that figure is warranted.

After publication and authorized activation, capture the exact PR head and
query runs filtered by that full SHA, then every attempt's paginated jobs:

```sh
gh pr view 2466 --repo integry/propr --json headRefOid
gh api 'repos/integry/propr/actions/runs?head_sha=<FULL_SHA>&per_page=100' --paginate
gh api repos/integry/propr/actions/runs/<RUN>/attempts/<ATTEMPT>/jobs --paginate
gh pr checks 2466 --repo integry/propr --required
```

Record actual `runner_name`, `labels`, job `created_at`, `started_at`,
`completed_at`, conclusion, run attempt and total workflow duration. Queue time
is job start minus creation (not time waiting on dependencies). Check all four
shards, every eligible build/docs job, coverage verification, native Electron,
and the aggregate gate. Correlate API runner names with the administrator's
verified four-worker inventory and job cgroup summaries. Do not reuse timings
from an older head as proof. **Resulting-head CI and gitfix.dev placement remain
pending activation and a new run.**

There is no automatic fallback when activated workers are busy/offline. Set
`PROPR_ROOTLESS_PR_CHECKS=false` to route new jobs hosted; already queued jobs
need cancellation/restart. For partial failures rerun failed jobs and verify
the aggregate gate, including prior successful shard artifacts.

## Nightly

`test-nightly.yml` keeps its unsharded full suite/live E2E and existing
self-hosted labels. Scheduled/manual runs across refs share
`nightly-test-suite` with `cancel-in-progress: false`: one active run, at most
one pending run. This does not serialize other workflows; nightly retains the
legacy pool while PR checks select only the rootless label. Nightly also
receives the Redis ownership fix. This follow-up does not activate or change nightly runner access.
