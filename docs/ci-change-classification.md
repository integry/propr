# CI change classification

One shared classifier decides which checks a pull request needs. The rules live
in `scripts/ci-change-classification.mjs`, they are exercised by
`test/ciChangeClassification.test.mjs`, and every workflow reads them through
the composite action at `.github/actions/classify-changes`. No workflow restates
them, so two workflows cannot disagree about what a path means.

The policy is deliberately small. It is a conservative path-to-surface map, not
a dependency graph: it is meant to be readable and provable, and it errs towards
running more work.

## Surfaces

| Surface | What it gates |
| --- | --- |
| `core` | Root orchestrator service lint and build |
| `api` | API build, typecheck, lint, security and MCP coverage |
| `core_package` | `@propr/core` and `@propr/shared` build and changed-source lint |
| `ui` | UI and client checks, PWA and mobile browser smoke |
| `cli` | Standalone CLI Agent Skill and Node compatibility checks |
| `connect` | Native Connect discovery and authority proofs (Windows, Darwin) |
| `desktop` | Desktop packaging, installers and packaged Connect discovery |
| `docs` | Documentation site typecheck and build |

Dependency edges are stated once, in the rule table:

- `@propr/shared` is consumed by every surface.
- `@propr/client`, `@propr/cli` and `@propr/local-setup` activate the packaged
  desktop app, which bundles them.
- `propr-ui/` is the renderer the desktop app embeds, so a renderer change still
  requires the desktop tests.
- `packages/api/src/` activates `connect`, because the Connect proof scripts run
  API suites. `CONNECT_PROOF_FILES` names the individual files those scripts run
  from outside the API implementation, and a test fails if that list drifts from
  what the scripts actually execute.

## What always selects everything

These are the cases where the classifier refuses to reason about blast radius:

- Any path under `.github/`, including this classifier's own action and any
  workflow. **A classification or workflow change always runs the full matrix**,
  so the selector can never silently suppress its own validation.
- Any path under `scripts/`, and `test/ci*.test.mjs`.
- Any lockfile, `Dockerfile*`, `docker-compose*`, `config/`, `docker/`,
  `.propr/`, `.nvmrc`, `tsconfig.json`, `eslint.config.js` and the other shared
  toolchain files.
- Any path that matches no rule at all, including a brand-new workspace.
- An empty change set, a non-`pull_request` event (manual dispatch included), a
  base or head that is missing, truncated or unreachable, a shallow checkout
  that cannot be deepened to a real merge base, a malformed diff, and any
  internal failure of the classifier.

A missing or empty decision is never read as permission to skip. Workflows gate
on `!= 'false'`, never on `== 'true'`.

## Manifests

`package.json` is compared **structurally** between the merge base and the head,
not by filename and not as text. Both sides are parsed first, so whitespace and
key order differences are not a change at all.

A manifest change is narrow only when every changed top-level field is
`scripts`, the manifest is the root manifest, and every changed script key is one
of the known backend-focused test scripts:

| Script | Surfaces |
| --- | --- |
| `test:mcp` | `api` |
| `test:unit` | `api`, `core` |
| `test:notifications:server` | `api`, `core` |

Each of these names server-side test files and **no workflow invokes any of
them** — a test asserts that. Editing one therefore cannot change what a
desktop, CLI or UI check does. The full suite discovers those test files by
pattern, so their coverage is unaffected either way.

Everything else in a manifest selects every surface: dependencies of every kind,
`overrides`/`resolutions`, `engines`, `packageManager`, `workspaces`, `version`,
lifecycle, build and package scripts, any unrecognised field, any workspace
manifest's scripts, and any manifest that was added, deleted, renamed or cannot
be parsed.

## How the change set is resolved

The classifier diffs the **merge base of the captured base and head**, so it sees
the pull request's own contribution rather than `HEAD^` or the last commit. That
handles multi-commit pull requests and a base branch that advanced after the
branch point. It uses git rather than the GitHub API, so there is no pagination
or truncation that could omit a file. Renames are detected and **both** the old
and the new path are classified. Commit ids and paths are passed as arguments
and environment data, never interpolated into shell.

A shallow checkout is handled explicitly: if the merge base lands on the shallow
boundary, the checkout is deepened and the merge base is recomputed; if it still
cannot be proved, the run is broad. The classifying jobs check out with
`fetch-depth: 0` so this path is a safety net rather than the normal route.

Nothing about runner eligibility changed: the same rootless opt-in, hosted
fallback, preflight, isolated `HOME`/`TMPDIR`/Redis and cleanup steps run as
before, and superseded runs still cancel because every gate uses `!cancelled()`
rather than `always()`. There is no `pull_request_target` execution and no
broadened token: the classifying jobs check out with `persist-credentials:
false` and `contents: read`.

## Gates and aggregates

Every gated job carries `if: ${{ !cancelled() && needs.classify.outputs.<surface>
!= 'false' }}`. A classifier that failed, was cancelled or never ran leaves the
output empty, which runs the job.

Aggregates keep their names and stay meaningful. They accept a skipped
constituent **only** when the classifier job succeeded, reported `status=ok`, and
explicitly reported that surface as `false`. A failure, a cancellation, a missing
result or an unexplained skip still fails the aggregate:

| Workflow | Aggregate |
| --- | --- |
| `pr-build-check.yml` | `CLI and Connect Compatibility Guard` |
| `desktop-release-guard.yml` | `Finalize unsigned validation checksums` |
| `desktop-connect-discovery-guard.yml` | `Packaged Connect Discovery Guard` |
| `cli-node-compatibility.yml` | `CLI Node Compatibility Guard` |

Each gate script is executed directly by the tests against success, failure,
cancellation, skip and missing-result inputs, so the semantics are proved rather
than asserted as YAML substrings.

Every run writes a job summary listing the decision per surface and the reason
per path, so skipped work is always inspectable.

## What stays broad on purpose

- **The full test suite (`pr-test-on-label.yml`) is unchanged and still runs
  unconditionally on every pull request**: all four shards, the discovered-unit
  coverage verification, the docs/test-preparation job and the hosted native
  Electron units. It is not narrowed by the classifier, and `test:mcp` did not
  become a substitute for it. Partitioning the full suite — including its UI and
  native units — is a separate question that this policy deliberately does not
  answer.
- **`Validate Changes` in `pr-build-check.yml` runs on every pull request.** It
  classifies inside the job to choose which changed-area sections to run, and it
  passes `require-resolution: true`, so an unresolvable change set fails that job
  loudly instead of silently reporting the conservative fallback with empty file
  lists.
- Tag pushes in `desktop-release-guard.yml` never consult the classifier. The
  release preflight, signing, finalization and publication jobs are byte-for-byte
  unchanged.
- The nightly suite and CodeQL are untouched.

## Before and after, for a pure API/MCP change

Taking the change set of PR #2501 — five files under `packages/api/mcp/`, four
under `packages/api/test/`, and a root `package.json` whose only structural delta
adds one test file to `scripts.test:mcp`:

| Check | Before | After |
| --- | --- | --- |
| Run Full Test Suite (4 shards, docs, native Electron, coverage) | runs | runs |
| Validate Changes (API build/typecheck/lint, security, release metadata, CLI packaging, actionlint, ShellCheck) | runs | runs |
| PWA and mobile browser smoke | runs | not applicable |
| Docs typecheck and build | not selected | not applicable |
| CLI Agent Skill (Node 22, Node 24) | runs | not applicable |
| CLI Agent Skill (glibc 2.31) | runs | not applicable |
| CLI Agent Skill (Darwin arm64) | runs | not applicable |
| Windows Connect Discovery | runs | not applicable |
| Connect Discovery and Darwin ACL | runs | not applicable |
| CLI Node Compatibility (Node 22, 24) | runs | not applicable |
| Desktop package validation (4 platform/arch legs) | runs | not applicable |
| Renderer axe boundary | runs | not applicable |
| Packaged Connect (4 targets) | runs | not applicable |

"Before" is what the filename-only path filters selected: the desktop and
packaged-Connect workflows listed `package.json`, so a manifest edit confined to
a backend test script pulled in the whole installer and Connect matrix, and
`pr-build-check.yml`'s CLI and Connect jobs had no filter at all.

This table is a statement about **which checks are selected**, not a claim about
wall-clock time. The narrowed jobs are the ones that competed with backend tests
for the four rootless workers, but no runtime figure is claimed here from the
list of skipped names alone.

## Changing the rules

Add or change a rule in `scripts/ci-change-classification.mjs` and add the case
to `test/ciChangeClassification.test.mjs`. Because every path under `.github/`
and `scripts/` is broad, the pull request that changes the policy runs the full
matrix and validates itself.
