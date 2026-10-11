# Validation only: combined Linux candidate (#2980)

This remains a **draft validation candidate**, not merge or publication approval.
It combines the selected planning/nightly, smoke cleanup, production setup wizard,
and Electron/private crash-capture corrections from #2953, #2967, #2974 and #2975.
Original feature issues remain open; macOS qualification stays separate in #2976.

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

## Reproduce on gram: native Linux x64

Use an isolated clean checkout of the final candidate commit, with the qualified
ordinary-user X11/Secret Service synthetic-fixture session already available.
Do not change keyrings, credentials, permissions, sandbox policy, host libraries,
or grants to make a run pass. Run each command once initially; retain its exit,
signal and full log, including failures. Any additional diagnostic attempts must
have a declared count and retain every outcome. Commands below build local files
only; they do not publish or write image tags.

From the repository root, replace the placeholder with the final orchestration
commit (not one of the four input heads):

```sh
set -euo pipefail
candidate_sha=<full-final-candidate-commit>
test "$(git rev-parse HEAD)" = "$candidate_sha"
test -z "$(git status --porcelain --untracked-files=normal)"
evidence_dir=$(mktemp -d /tmp/propr-2980-evidence-XXXXXXXX)
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
crash_evidence_dir=$(mktemp -d /tmp/propr-2980-crashes-XXXXXXXX)
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
