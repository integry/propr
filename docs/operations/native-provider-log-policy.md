# Original provider logs: protection and capacity admission

Issue #3015 builds on #3014, merged on 2026-10-12 before this implementation. **Original growth is not bounded. No native files are deleted, renamed, truncated, archived, or reopened by this implementation.** None of the audited versions has a verified safe daily-and-size rotation/reopen contract in this integration. We implement the issue's protected/unbounded fallback with real launch admission. Provider upgrades require another audit and live acceptance before introducing native maintenance.

## Exact version audit and ownership

Image pins in `Dockerfile.agent` are the compatibility baseline. Producer source allowlists are reused for classification, not disposal authorization.

| Provider/version | Original sources and writer lifetime | Treatment |
| --- | --- | --- |
| Codex 0.160.0 | `$CODEX_HOME/log/codex-tui.log` when enabled; task/goal tracing also writes `logs_<n>.sqlite` and may use WAL/SHM. `sessions/.../rollout-*.jsonl`, `archived_sessions`, and `state_<n>.sqlite` support session/thread state. App-server stderr has a separate subscriber. | Text diagnostic bytes separate; all SQLite/WAL/SHM protected as database, rollouts as session history. `RUST_LOG` controls stderr but not the independent SQL log layer. No file/DB cap claimed. |
| Claude Code 2.1.284 | `debug/<session>.txt` is diagnostic; project/session/subagent JSONL and `history.jsonl` are session history. Goal writers and UI readers outlive individual messages. | Diagnostic/session bytes separate. Existing task-mode `--no-session-persistence` is not applied to resumable goals. No tested safe debug reopen or daily/size cap; retained. |
| Antigravity 1.2.4 (release 6085322963025920) | Mounted `.gemini/antigravity-cli/log/*.log` diagnostics; `brain/<conversation>/.system_generated/logs/transcript.jsonl` session history. Entrypoint uses disposable container runtime too. Goals span invocations. | Mounted originals protected and counted by class. Container-only originals unmeasured. No rotation contract verified. |
| OpenCode 1.18.31 | Explicit source `.local/share/opencode`, runtime XDG data in `/tmp/propr-opencode-data/opencode`. Current writer appends `log/opencode.log`. DB/WAL/SHM hold session state. | **`--print-logs` still writes the file**, adding stderr. Older upstream `Log.init` fixtures that returned early on `print` do not match this binary. All originals protected. |
| Vibe 2.25.8, Python 3.12 | Assigned worker runtime under `VIBE_PROMPT_CACHE_DIR/propr-vibe-runtime/...`, mounted `/tmp/propr-vibe-home`; `logs/session/<id>/messages.jsonl` is conversation history. Source home is read-only. | Session bytes, not disposable debug bytes. Existing task runtime cleanup unchanged. No new native-goal resumption guarantee. Unregistered runtime roots unmeasured. |
| agent-tank 0.9.11 | Auxiliary package; stream diagnostics belong to the containing execution. | No extra directory traversal. |
| App-created `/tmp/claude-logs` | `issueJobCallbacks.ts` and `prCommentJobHelpers.ts` create conversation snapshots/output text for task/UI handling; launcher shares the bind mount. Multiple writers/readers and restart mappings exist. | Ownership cannot be derived from filenames, dates or completed status. Not scanned/pruned; shared-directory declarations rejected. Growth unbounded/unmeasured. |

Credentials/configuration are metadata-only categories: this inventory reads no contents. Known auth/account/credential JSON, config/settings, `.env`, and the Antigravity OAuth store remain unchanged. Unknown files are counted without content reads; unknown directories are not traversed and make inventory incomplete. Existing producer redaction/private export restrictions still apply.

Codex evidence: [version-tagged app-server subscribers](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/lib.rs), [independent SQL sink](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/state/src/log_db.rs), [configuration schema](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/config.schema.json). Installed version checks: Codex 0.160.0, Claude 2.1.284, OpenCode 1.18.31, Vibe 2.25.8. Antigravity image pin/layout audited; binary not exercised here.

An isolated OpenCode 1.18.31 `serve --print-logs` check found an original 431-byte `opencode.log` with **two open writer descriptors**, alongside stderr output. The opt-in `nativeLogPolicyLive.test.ts` also verifies these descriptors and the original inode survive metadata sweeps while the provider continues serving authenticated localhost health/UI requests. Run with `PROPR_NATIVE_LOG_LIVE=1`; optionally set `PROPR_NATIVE_OPENCODE_BINARY` to the installed executable. Linux x64 executable SHA-256: `f9dab32248695e9ebd56b16a1921798fd85112cf5a69c7dfd0cabc1e17be4a11`. These checks use private temporary homes, no customer credentials and no model request. They prove unsupported active-file behavior, not resumability or production acceptance.

## Instance-admin activation and launch admission

`PROPR_MANAGED_LOGS=1` is required, with or without Fleet. The OS/instance administrator additionally declares the exact instance-owned roots. No home inference, Fleet credential inference, member API, ownership changes or provider marker writes occur. Paths must be visible in the application's mount namespace; declaration does not mount host directories.

Example application environment:

```sh
PROPR_MANAGED_LOGS=1
PROPR_INSTANCE_ID=tenant-a
PROPR_NATIVE_LOG_ROOTS='{"instance":"tenant-a","instanceOwned":true,"roots":[{"provider":"codex","agent":"agent-a","root":"/usr/src/app/data/agent-credentials/agent-a/.codex"}]}'
```

Configuration is bounded to 32 KiB/128 disjoint roots and bound to the spool's instance. Ancestor symlinks, traversal, duplicate/overlapping roots and the shared Claude directory are refused. Root/traversed directories require the process owner; files require regular type, single link and directory-owner match. Linux descriptors pin ancestors; replacement races are checked against descriptor inodes. Unsafe/missing roots/entries produce incomplete inventory, never successful zero-byte measurement. Nothing modifies provider credentials, transcripts, working trees or Docker internal logs.

Before a configured agent's task or native-goal Docker admission, all declared roots receive fresh metadata checks. New launches are refused on:

- Unsafe inventory or unavailable status storage (including unavailable filesystem capacity).
- Fewer than 256 MiB available on any declared root's filesystem, including usage by unrelated writers.
- A measured or persisted capacity lower bound of at least 256 MiB in one root or 1 GiB across declared roots.

These thresholds are **not disk limits on existing writers**. Checks neither reserve space nor take a consistent snapshot of concurrent native activity. Simultaneous launches may pass before later output consumes capacity. Existing customer runs are not killed; they may grow past thresholds or fill disk. A refused resumable task keeps session/work for a later launch after operator storage action. Stale high-water marks can be released with the confirmed private CLI `reset-native-capacity` procedure in [managed diagnostics](managed-diagnostics.md#operator-release-of-stale-native-capacity); reset the affected `native-state` and `native-capacity` source IDs after verifying remediation. No resume-dependent deletion is authorized. With no declared roots, admission reports `unconfigured`, not bounded success; the existing physical Docker gate still checks recognized explicitly owned mounts, spool capacity, free bytes and free inodes. Container-only state and shared UI files remain unmeasured.

Each root processes at most 4,096 entries/250 ms, with a 2-second aggregate traversal budget. `scan-limit` (entry/deadline exhaustion) and `unmeasured-directory` incompleteness use observed lower bounds plus persisted high-water marks for byte admission rather than refusing solely because the scan is incomplete. No unknown-home recursion, content reading, multi-GB buffering, scratch copy or asynchronous queue occurs. Sparse file size uses `fstat`. Status rows share the existing bounded database and transactional restart/concurrency behavior. Saturated copy source/cursor tracking is a collection warning only and does not block launches. Status storage failure refuses an affected launch; daemon collection remains best effort with its existing coverage warning. Exact full-disk/crash losses remain unknown, not zero.

Private CLI `status` refreshes inventories; daemon sweeps persist them every 30 seconds. `nativeMaintenance.sources[].bytes` separates `diagnostic`, `session`, `database`, `auth-config`, and `unknown` from `spool.bytes` (compressed copies). These are logical file lengths; `allocatedBytes` separately reports observed allocated file blocks, and `availableBytes` is real filesystem capacity. Admission conservatively uses logical lengths, so sparse logs can refuse a launch without consuming that much disk. `observedBytes` and allocated usage are partial lower bounds when incomplete; even complete declared-root metadata is not a complete provider/container inventory. Historical rows have `checkedAt` and may remain after configuration removal. `nativeAdmission` uses only the current declaration. Names are hashed; paths, contents and secrets are absent. `growthBounded=false`, `rotation=unsupported`, `disposal=protected`, and `existingWritersCapped=false` are explicit.

## Archive acknowledgement and local-only opt-in

Default disposal still requires encrypted upload **plus readback acknowledgement** of an exact sealed spool segment. Export/collection are not acknowledgement. Absent/failed acknowledgement retains data; bounded copies drop new data with reported gaps. There is no native disposal to coordinate with acknowledgement. Acknowledging a diagnostic copy cannot authorize session deletion; no archive-retrieval/resume path exists.

For intentional local-only diagnostics, an OS-admin can set `PROPR_DIAGNOSTIC_DISPOSAL=local-only` and dispose one exact sealed copy through the private CLI:

```sh
node dist/scripts/managed-diagnostics.js dispose-local SEGMENT SHA256 --local-only-loss-accepted
```

This explicitly accepts diagnostic-copy loss without a hosted account. It records `local-only-disposal` gaps/dropped uncompressed bytes atomically with deletion; latest receipt retry is idempotent. It never creates a remote acknowledgement, silently evicts old segments or deletes native files. It requires managed activation plus the local-only opt-in. `ack ... --encrypted-upload-readback-verified` remains distinct. Fleet owns encryption, transport and 14-day off-site retention; 60-day DB/config backup policy is unchanged.

The existing `PROPR_DIAGNOSTIC_LOCAL_ONLY=1` / `discard-local ... --accept-local-diagnostic-loss` interface remains supported with its `local-only-discard` accounting. Both interfaces dispose only collected copies.

## Acceptance and residual gaps

`nativeLogPolicy.test.ts` covers pinned layouts, classification, a real open append descriptor during collection/export/capacity refusal, daily boundary, immutable session/auth/config canaries, missing acknowledgement, restart, local-loss receipts, sparse 3 GiB metadata scans, entry bounds, incomplete inventories, free-space refusal, injected ENOSPC reporting failure, hardlink/symlink/FIFO/traversal/ancestor swaps and foreign canaries. The existing producer suite covers size/daily rollover of copies, concurrent processes, cursor CAS, redaction and outage bounds. Task/native-goal, executor and launcher regressions are also relevant.

There is deliberately **no original-file rollover/pruning acceptance claim**: the audit did not establish a safe supported mechanism. Active/recoverable/resumable state and uncommitted/unpublished work remain protected. Admission does not close active-writer growth. Fleet must validate deployed image digests, host/container capacity and off-site readback/outages without killing customer runs. No live pruning, deployment, permissions change, public rollout, SSH or billing/reset change is included. No UI changes or preview assets are involved.
