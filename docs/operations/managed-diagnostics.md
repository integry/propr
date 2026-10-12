# Managed diagnostic producer (policy 1)

This is the application/provider dependency of Fleet issue 78. It does **not** deploy anything, implement encrypted transport, or change 60-day DB/config restore backups. These diagnostics contain customer content even after credential redaction. They are tenant-private, never preview assets, GitHub attachments/comments, or public download routes.

**Scope: only producer-owned collected copies rotate. Original provider diagnostic-log growth remains unbounded for unsupported writers.** Issue #3015 adds classified native measurements and launch capacity admission; it does not claim native rollover or safe session pruning. ProPR retains application/provider production, credential redaction, bounded spool and private export. Fleet owns Storage Box transport, encryption, verified remote readback, host/Docker/journal policy and 14-day off-site retention.

See the [native provider log policy](native-provider-log-policy.md) for independent declared-root inventories, task/native-goal admission and the `dispose-local` opt-in. Existing mount admission and `discard-local` remain supported.

## Activation and lifecycle

Application runtime, daemon and launcher enable diagnostics only with `PROPR_MANAGED_LOGS=1`, with or without a Fleet secret. Unset, `0` and all other values remain disabled, including when `PROPR_FLEET_CONTROL_SECRET` is present: that credential authenticates Fleet and is never a logging-policy switch. Self-managed behavior is disabled by default. Fleet provisioning will configure the explicit policy separately in integry/propr-fleet#78. Enabled collection requires a valid `PROPR_INSTANCE_ID`; missing/invalid bindings or an existing spool bound to another instance are rejected before collection. Linux `/proc/self/fd` is required; no fallback follows symlinks on unsupported platforms.

`PROPR_DIAGNOSTIC_ROOT` defaults to `/usr/src/app/data/managed-diagnostics`, within the launcher's existing persistent data mount. Its parent must exist. The producer creates the final directory with mode 0700 and its database with mode 0600; existing roots must have the same private permissions and process owner. A root is bound to exactly one instance and policy. Never share it between tenants, mount it into an agent container, or point it at credentials, a personal home, or a worktree.

Pino's write hook queues preview-redacted application records in a bounded 1 MiB / 4,096-record buffer, flushed every 25 ms; it performs no synchronous database commits. Segment compression happens once per segment per batch. A process crash can lose the unflushed buffer. The shared Docker executor captures provider stdout/stderr, as do the separate Codex app-server, Claude native-goal and Antigravity native-goal launch paths. Capture tees existing output; it does not replace Redis/UI streams or resume data. The daemon measures explicitly allowlisted native files every 30 seconds in configured per-agent managed roots or explicit launcher provider mounts. It refuses native content export because historical run-specific credential context cannot be established across processes. Only explicit activation with a valid instance binding adds diagnostic-only read-only daemon mounts. Existing legitimate worker/API credential mounts remain independent of diagnostic policy. Vibe's worker snapshots a fresh runtime home with the run credential context periodically and before existing runtime cleanup. When Vibe copies a mounted source home, historical credential context is unknown, so native content is measured but not exported. Each runtime root has a separate measured contribution, retired only after confirmed deletion; concurrent roots remain counted. Confirmed retirement releases the root summary and file cursors from the active-source cap. Retired metadata remains until its pending segments are acknowledged, then is pruned.

An unavailable spool emits a rate-limited constant warning without an exception, path, credential or record payload. Storage failures are retried on subsequent capture; in-process lost-byte counters are reported when storage becomes writable again. A crash while storage is unavailable cannot durably record its exact lost-byte count. `historyComplete` is consequently **always false** in this producer. Fleet must establish off-site coverage from its own verified objects and producer gaps; it must not interpret a successful CLI exit or collection timestamp as proof of 14 complete days.

## Runtime portability, module identity and policy upgrades

The SQLite binding (`better-sqlite3`) loads only when a spool is constructed, i.e. when `PROPR_MANAGED_LOGS=1` and a caller first needs diagnostics. Importing the logger, `@propr/core/diagnostics` or the launch-admission modules with diagnostics disabled does not resolve or load the native binding. The full `@propr/core` entry still opens the application's own database through knex; that is separate from diagnostics.

Root daemon code and `scripts/managed-diagnostics.ts` import the runtime from the `@propr/core/diagnostics` package entry, never from relative `packages/core/src` paths. The spool singleton, application record queue and learned credential cache are also stored in a versioned process-global registry, so a duplicate module instance (for example source plus `dist`) still shares one spool and one credential cache. `DiagnosticPolicyError` is recognized across instances.

Provider-file cursors store `dev:ino` and, only when the filesystem reports a distinguishable birth time, that birth time. When birth time is unavailable, Node substitutes ctime, which changes on every append, so ctime is never treated as file identity. Legacy `dev:ino:birthtimeMs` cursors are read as `dev:ino` without replay. Inode changes, a mismatched anchor fingerprint and truncation still reset the cursor and record a `source-replaced` gap.

The spool binds to its instance permanently. It binds to a policy only until an explicit upgrade. Changing any limit requires a new `MANAGED_LOG_POLICY.version` and a declared `MANAGED_LOG_POLICY_MIGRATIONS` step whose `previous` policy exactly matches the stored binding. Each step runs inside the startup transaction. It seals open segments so stored segments are never extended under different bounds, and keeps the instance binding, cursors, gaps and every unacknowledged segment, including segments already exported but not acknowledged. Steps are recorded in `policyHistory`. Changing a limit without a version bump, an undeclared or mismatched step, a downgrade, or a different instance still refuses startup with `DiagnosticPolicyError`. Status and export manifests report the current `policyVersion`. Lowered byte/count limits never evict stored data; they apply only to new copies.

### Worker and agent-container UID alignment

`Dockerfile.agent` entrypoints start as root, `chown` managed provider homes to `node` (UID 1000) and drop privileges to it, so provider-written files are owned by UID 1000. Supported ownership mappings are:

| Deployment | Worker UID | Supported provider-root owner |
| --- | --- | --- |
| Hosted (`docker/Dockerfile.app.prod`, no `USER`) | 0 | 0 or the agent container UID (`PROPR_AGENT_CONTAINER_UID`, default 1000) |
| Native / self-managed | the host user's UID | the same UID only (for example a host user 1000 with the stock image) |

Every directory and file below a provider root must have the root's owner. Ownership is checked explicitly and is never inferred from the parent directory. Unsupported root mappings fail closed: a non-root worker whose UID differs from the container UID, a root worker with a foreign container UID, or a platform without POSIX UIDs. Such roots are not read or exported: the collector, and pre-spawn capture before reading any credential store, report `ownership-unsupported`. Declared-root inventories report `unsupported-ownership`, and new launches are refused with `provider file ownership unsupported; align worker and agent container UIDs`. Mixed ownership inside a supported root (a missed `chown`, or a planted foreign-owned file or credential store) is not a UID-mapping problem and is never remedied by changing `PROPR_AGENT_CONTAINER_UID`: such entries are not read or exported, the collector reports `unsafe-source`, declared-root inventories report `unsafe-entry`, and new launches are refused as an incomplete or unavailable native inventory. Inspect and remove or re-own the foreign entry. If a root worker's `PROPR_AGENT_CONTAINER_UID` is not an unsigned UID, only root-owned homes are supported and refusals name `invalid PROPR_AGENT_CONTAINER_UID` instead. `status` includes `providerOwnership` (worker UID, supported owners, effective container UID, configuration error, mapping). To resolve a refusal, run the native worker as the agent container UID or use a custom agent image whose UID matches, setting `PROPR_AGENT_CONTAINER_UID` for root workers. Ownership is never changed automatically.

## Source and version audit

Audited from `Dockerfile.agent`, `agents/version/types.ts`, `configManagerAgents.ts`, the five Docker argument builders, `agentLogin.ts`, `docker/launcher/orchestrator.mjs`, provider entrypoints, and the native-goal/runtime helpers. This checkout's image defaults are below; selectable tags/custom images can differ. These are repository-supported versions, **not live container acceptance results**. Tests use filesystem fixtures of these managed layouts, not installed provider CLIs or a Hosted production instance.

`M` is the configured `PROPR_MANAGED_CREDENTIALS_DIR`, not the application's `HOME`. Browser-created credential paths map to `M/<agent-id>/<suffix>`. Explicit `HOST_*` mappings are mounted HOST:HOST into application containers. Paths below are relative to the identified provider root unless stated otherwise.

| Provider/version | Host and agent-container mapping | Diagnostic/session allowlist | Protected/excluded native state | Writer lifetime and safe mechanism |
| --- | --- | --- | --- | --- |
| Application / Pino 9 | Application stdout; private spool under mounted data | Complete JSON records from Pino hook | Existing DB-backed task/LLM history stays under its existing policy | Application process; managed capture owns rotation. Fleet owns stdout/journald/Docker rotation. |
| Codex 0.160.0 | `M/<id>/.codex` or explicit `CODEX_CONFIG_PATH`/`HOST_CODEX_DIR` → `/home/node/.codex:rw` | `log/codex-tui.log`; `sessions/YYYY/MM/DD/rollout-*.jsonl`; same under `archived_sessions` | `auth.json`, config.toml, token/auth stores never exported; `state_<n>.sqlite` and `logs_<n>.sqlite` plus WAL/SHM measured and protected, not copied as files | Exec/app-server can keep descriptors open for the task/goal. No verified writer-reopen contract is assumed. Snapshot complete append records; rotate the managed copies. Native SQLite diagnostics require a future schema-aware reader and remain protected. |
| Claude 2.1.284 | `M/<id>/.claude` or explicit `CLAUDE_CONFIG_PATH`/`HOST_CLAUDE_DIR` → mounted Claude home | `debug/*.txt`; `projects/<slug>/*.jsonl`; `projects/<slug>/<session>/subagents/agent-*.jsonl` | `.credentials.json`, settings/config, caches excluded; `history.jsonl` measured/protected; transcripts stay available for native goals/resumption | Task/goal process; no signal/reopen assumed. Read-only measurements plus stdout/stderr capture; no rename/truncate of active transcript or debug files. |
| Antigravity 1.2.4 (release 6085322963025920) | `M/<id>/.gemini`, legacy explicit root → `.gemini-source`; entrypoint may copy selected auth into disposable `/tmp/propr-antigravity-home/.gemini` | In a mounted root: `antigravity-cli/log/*.log`, `antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl`; managed stdout/stderr includes native-goal segments | `antigravity-cli/antigravity-oauth-token`, settings, arbitrary brain/project/cache contents excluded | Task/goal process. Disposable container-only files are not falsely reported as mounted history. No native rotation/reopen proven; mounted append history is measured but not exported without complete credential context. Existing transient transcript/UI handling remains unchanged. |
| OpenCode 1.18.31 | `M/<id>/.config/opencode`; sibling `M/<id>/.local/share/opencode` or explicit `HOST_OPENCODE_DATA_DIR` supplies credentials. Runtime uses disposable XDG data via `PROPR_EPHEMERAL_STATE=1` | Mounted data root `log/*.log` when present; managed stdout/stderr for every execution | `auth.json`, `account.json`, config excluded; mounted `opencode.db`/WAL/SHM measured/protected, never exported | Runtime native DB/logs can be container-only; no broad copy or SQLite live-file copy. Captured stream is the supported diagnostic history for disposable runs. |
| Vibe 2.25.8, Python 3.12 | Explicit `.vibe` source is read-only. Runtime: `VIBE_PROMPT_CACHE_DIR/propr-vibe-runtime/propr-vibe-home-*` assigned by worker → `/tmp/propr-vibe-home`, also `HOME`/`VIBE_HOME` | Assigned runtime `logs/session/<id>/messages.jsonl`, plus stdout/stderr; same allowlist in an explicit mounted source | config.toml, credentials.json, .env, prompt cache files, skills and secrets excluded | Task-local runtime; snapshot while active and on child close, before existing cleanup. Does not add or promise Vibe native-goal resumption. |
| agent-tank 0.9.11 | Auxiliary runtime package in agent image, not a sixth `AGENT_TYPES` provider | Its diagnostic messages on the owning provider's captured streams | No extra home scan | Shares execution lifetime and stream policy. |
| Shared `/tmp/claude-logs` | Launcher/Claude bind mount, not an isolated per-agent home | **No directory-wide collection**; associated execution stream is already captured with known agent identity | Conversation/output JSON is used by existing UI/session mappings. Unknown ownership is reported as `ownership-unverified`; nothing is removed | Multiple task writers/watchers, including JSON snapshot rewrites; cannot prove tenant/task ownership or safe reopen from filenames alone. |

Only these exact structural allowlists are traversed. New provider versions/formats require review of fixtures and this table; unknown/unparseable records are dropped with gaps, not shipped as raw bytes. Missing optional directories are valid. Native state has no archive-retrieval dependency because this policy never prunes it. It does not assert a complete byte inventory of excluded, unrecognized, or container-only state.

Known auth stores are opened solely to obtain redaction values (bounded to 64 KiB per store, 128 KiB aggregate); their contents never become export records. Malformed/unsafe auth stores refuse the corresponding snapshot. Structured auth/token/password/secret/header fields, known token prefixes, JWTs, bearer/basic auth, credential assignments and URL credentials are redacted, along with credential-name-filtered environment values and run-specific injected credentials. Substring replacement requires at least eight characters; structured credential fields remain redacted at any length. Stream capture requires an available effective authentication root (see [provider stream capture coverage](#provider-stream-capture-coverage)). Native content additionally requires explicit complete credential context for the records being read. Timestamp/severity-prefixed single-line native text and structured JSON objects are supported. Unknown native text/continuation lines and PEM/binary/oversized/malformed structured records are rejected. Redaction is versioned and conservative, not a claim to recognize every possible secret or remove customer content.

## Provider stream capture coverage

**Credential roots.** Before any stdout/stderr capture, the worker resolves the provider credential root with the same pure resolver the launchers mount from (`packages/core/src/config/agentConfigPaths.ts`), so hosted, native and Compose installs agree:

| Provider | Root used for redaction context |
| --- | --- |
| Codex | Managed `M/<id>/.codex`; default `~/.codex` through `CODEX_CONFIG_PATH`, then `HOST_CODEX_DIR`, else `HOME/.codex` outside a container; custom absolute path as configured |
| Claude | Managed `M/<id>/.claude`; default `~/.claude` through `CLAUDE_CONFIG_PATH`, then `HOST_CLAUDE_DIR` (the mounted host Claude home in Compose), else `HOME/.claude`; other `~` paths against `HOME`; absolute paths as configured |
| Antigravity | Launcher-computed root (`ANTIGRAVITY_CONFIG_PATH` override, legacy `.antigravity` → `.gemini` sibling); managed `M/<id>/.gemini` |
| OpenCode | Data directory, never the config directory: `HOST_OPENCODE_DATA_DIR` for unmanaged agents, else the `.local/share/opencode` sibling of the resolved `.config/opencode` path (managed or not) |
| Vibe | Launcher-computed runtime home or mounted config (`VIBE_CONFIG_PATH`, else the agent path) |

`M` defaults to `~/.propr/agent-credentials` when `PROPR_MANAGED_CREDENTIALS_DIR` is unset, matching native launches. Launcher-only `HOST_*` variables are never required when the launch path resolves. Capture is refused, with a `capture` source gap naming the reason, when the root is `credential-root:unmapped-default-root` (containerized Codex default without a mapping — the launch refuses too), `credential-root:relative-root`, `credential-root:no-mounted-auth-store` (OpenCode with a config path that is not `.config/opencode`, or an agent `XDG_DATA_HOME` the launcher would forward — today it is reserved and never forwarded, so it does not change the mount), `credential-root:unsupported-provider` or `credential-root:missing`; unreadable or malformed stores remain `unsafe-source` and UID mismatches `ownership-unsupported`.

**Records.** Every complete line is a record, and so is a bounded final line without a trailing newline when the stream closes; a trailing `\r` is removed. Oversized lines (over the 64 KiB record bound), including an oversized unterminated tail, are `oversize-record` gaps and are never exported. Control characters (including ANSI escapes), replacement characters, PEM blocks, long base64 runs and malformed JSON-looking lines are `unsafe-record` gaps.

**Continuations.** Besides timestamp/severity heads, stdout/stderr accept Docker CLI/daemon errors (`docker: …`, `Error response from daemon: …`, `Unable to find image '…'`, `See 'docker … --help'.`) and exception heads (`TypeError: …`, `Error [CODE]: …`, `Traceback (most recent call last):`, `panic: …`, `Caused by: …`). A head opens a window of at most 64 continuation records, exported as `{"continuation": …}`, limited to stack-frame shapes: JavaScript/Java `    at …`, Python `  File "…", line N[, in f]`, `... N more`, `Caused by:`, `[cause]:`, Go `goroutine N [state]:` and `/path.go:N`. Continuation records receive the same credential, token, header and URL redaction; any `{`/`}`, trailing credential assignment or other shape is rejected, and any non-continuation line closes the window. A head that is itself rejected (for example an `unsafe-record` with control characters) opens no window, so its frames are gaps rather than headless continuations. Native text files use the same head recognition, so their timestamp/severity, Docker-error and exception head lines export as single-line `{"message": …}` records with the same redaction, but they never open a continuation window: their stack-frame lines remain gaps. These records are redaction version 2.

**Run environment.** Credential discovery scans the final command and the post-network-policy create arguments separately (admission replaces the final vector with `docker start`). It recognizes `-e K=V`, `--env K=V`, `--env=K=V`, `-eK=V` and inherited `-e K` (resolved from the launch environment), with credential-named values plus secret-shaped parts of any value: URL userinfo (for example proxy or `GIT_CONFIG_VALUE_*` URLs), `Bearer`/`Basic`/`token` header values and credential-named fields in JSON values such as MCP configurations.

**Intentionally unsupported.** Python source lines printed under a traceback frame, Node `code: '…'` property dumps, indented free text, multi-line JSON, ANSI-coloured output, `--env-file` contents (files are not read) and secrets under innocuous names without a recognizable shape. These are counted gaps or rely on the remaining text redaction; they are never exported raw.

## Bounds and protection

| Limit (policy 1) | Value |
| --- | --- |
| Record / uncompressed segment | 64 KiB / 256 KiB |
| Compressed per source / total outbox payload | 8 MiB / 64 MiB |
| Segments / active source cursors | 1,024 / 2,048 |
| SQLite main database | 96 MiB max pages, 4 KiB pages |
| SQLite journal | DELETE mode; at most the bounded database's modified pages plus journal headers; no unbounded WAL. Budget **200 MiB** for main DB plus journal. |
| Collection read / entry count / traversal deadline | 1 MiB / 4,096 entries / 250 ms traversal per provider sweep (excluding per-file collection) |
| Transaction record processing / SQLite lock wait | Byte-bounded batches, no CPU-based drops / 100 ms (initial schema setup 1 second) |
| Credentials / nesting | 512 values and 512 KiB redaction input; 32 structured-record levels |
| Protected native source / aggregate admission warning | 256 MiB / 1 GiB measured retained native state |
| Daemon roots | At most 128 enabled agents; 2-second pass budget checked between roots, rotating fairly between passes |

Segments contain only redacted canonical JSONL. UTC day changes seal the preceding day's segment; crossing the size limit rolls earlier. A private export seals its segment immediately. No active provider file is rotated: only the producer-owned copies rotate. Compression is deterministic gzip, with bounded decompression of at most one segment when extending an unsealed segment. There is no multi-GB read, full recursive listing, or unbounded capture queue. An idle segment can remain unsealed until the next write/export; no subsequent UTC day's records are appended to it.

SQLite IMMEDIATE transactions serialize rotation/export/prune and commit the native inode, bounded anchor fingerprint and newline cursor with the records. Duplicate concurrent snapshots fail cursor CAS. Replaced/truncated files expose a gap. Oversize unfinished records are discarded through their terminating newline; their tail cannot become a supposedly safe new record. Directories are opened component-by-component with NOFOLLOW and pinned via Linux descriptors; files require regular type, single link and a supported owner matching the provider root (see UID alignment above), and are opened NONBLOCK/NOFOLLOW. FIFOs, devices, hardlinks, symlinks, traversal and swapped ancestors are refused or remain bound to the original descriptor. The spool is outside all provider roots and accessible only to the trusted application/Fleet OS principal.

Native session ownership does not authorize deletion, even for completed tasks: running, recoverable and unknown tasks all keep their state. Measured protected capacity appears in status and blocks new physical agent launches at 256 MiB per root or 1 GiB across measured roots. Source tracking saturation remains a collection status warning and does not block launches. Duplicate mounts of a root contribute their largest measured footprint once. Incomplete inventories report `inventoryComplete: false`; scan bounds, deadlines and unknown directories use measured lower bounds and persisted high-water marks for byte admission. Unsafe entries and unavailable storage still refuse launches; unknown bytes are never replaced with a synthetic capacity limit. Operators must expand storage or resolve ownership/state retention; a daily timer cannot safely cap an uncooperative active native writer. Container-only native files and the ambiguous shared directory are explicitly outside that measured bound.

## Private Fleet protocol

Run in the application environment (source development uses `npx tsx scripts/managed-diagnostics.ts`):

```sh
node dist/scripts/managed-diagnostics.js status
node dist/scripts/managed-diagnostics.js export
node dist/scripts/managed-diagnostics.js ack SEGMENT SHA256 --encrypted-upload-readback-verified
```

`nativeMaintenance` reports the independent metadata inventory; `nativeAdmission` reports current declared-root eligibility, including `unconfigured` when no roots are declared. These checks supplement the existing mount and filesystem admission described below.

`status` emits the policy version, the current redaction adapter version (`redactionVersion`), the distinct versions of stored segments (`segmentRedactionVersions`), instance, all source identities, next sequence, cumulative dropped bytes/gaps, last successful clean collection, protected reasons, capacity warnings, and compressed spool usage. `nativeSources` separately reports protected native sources with `growthBounded: false`, unknown measurements as `null`, and explicit container-only/unowned/excluded coverage limitations. `measuredBytes` (and legacy `protectedBytes`) is populated only for an allowlisted native inventory with no recorded uncertainty; it is never a complete provider-home measurement. The shared physical Docker admission boundary enforces diagnostics capacity before initial admission and again after any entitlement wait, before container creation. This also applies to explicitly enabled self-managed instances without Fleet or Redis entitlement admission. Capacity high-water marks remain conservative until a complete scan or an explicit operator capacity reset; historical gaps remain visible; spool usage measures only collected compressed copies. No paths, credentials or record contents appear in status. A last-success timestamp denotes collection, not upload or complete history.

`export` emits `null`, or one JSON object:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "policyVersion": 1,
    "redactionVersion": 2,
    "tenantPrivate": true,
    "instance": "tenant-instance",
    "provider": "codex",
    "agent": "agent-id",
    "source": "stdout",
    "sourceId": "sha256-of-source-identity",
    "segment": 42,
    "utcDay": "2026-10-12",
    "collectionWindow": { "start": 1791763200000, "end": 1791763201000 },
    "firstSequence": 1,
    "lastSequence": 20,
    "compressedBytes": 1000,
    "uncompressedBytes": 4000,
    "sha256": "sha256-of-exact-gzip-bytes",
    "encoding": "gzip-jsonl",
    "droppedBytes": 0,
    "gaps": 0,
    "historyComplete": false,
    "lastSuccessfulCollection": 1791763201000
  },
  "gzipBase64": "..."
}
```

`redactionVersion` is the adapter that produced that segment, recorded per segment. Segments stored before an upgrade (including those spooled before per-segment versions existed, which are version 1) are preserved, never extended by a newer adapter, and export with their original version; new records after an upgrade start a new segment. Native `source` is a SHA-256 of its allowlisted relative filename; absolute filesystem/repository paths are not in manifests. Times describe **collection**, not provider event time. Sequence is monotonic per tracked source, including rejected input records. Discarded oversize byte ranges are also counted as gaps even when a complete record could not be assigned a sequence. Gap/dropped-byte counts are cumulative and can change between exports of the same immutable payload.

Fleet must use a private pipe, validate instance binding, digest and lengths, encrypt before off-site upload, verify a readback, then acknowledge that exact sealed segment/digest. An interrupted export/upload is retried from the same oldest unacknowledged segment. Export alone does not acknowledge. Acknowledgement permits immediate local pruning; retrying the most recent acknowledgement is idempotent. Fleet owns encryption keys, transport, remote coverage/gap reporting and the 14-day encrypted diagnostic retention policy. Do not attach the envelope to a task or GitHub.

Outage policy: keep unacknowledged data regardless of age; once any byte/file-count cap is reached, drop **new diagnostic copies** and persist gaps/dropped bytes. Native state and UI logs remain intact. No silent unacknowledged eviction, no promise of 14-day local storage, and no claim of full remote history. A saturated source/cursor inventory is a collection warning only and does not block launches. Recovery does not clear historical gap counters. Exact losses during ENOSPC/process death may be unknown, so Fleet must report an interval of unknown coverage rather than infer zero loss.

## Operator release of stale native capacity

A `protected native state capacity` refusal can persist after a root is removed/disabled or diagnostics are cleaned up: incomplete scans preserve a high-water mark, and other agents cannot refresh an absent root. After verifying storage remediation, the instance OS administrator can reset a specific native capacity source through the private CLI:

```sh
node dist/scripts/managed-diagnostics.js status
node dist/scripts/managed-diagnostics.js reset-native-capacity SOURCE_ID --operator-storage-remediation-verified
```

Source development uses `npx tsx scripts/managed-diagnostics.ts` with the same arguments. Keep `PROPR_MANAGED_LOGS=1`, the same `PROPR_INSTANCE_ID` and private `PROPR_DIAGNOSTIC_ROOT`. Select the exact `sources[].id` for the affected provider/agent's `native-state` (including a hashed root suffix) or `native-capacity:<hash>` row. If both rows track the affected root, reset both. Repeat only for other verified stale contributions; aggregate refusals may have several contributors.

The confirmation asserts that the operator verified removal/deactivation or reduced retained bytes and coordinated any writers that could invalidate that remediation. Disabling an agent alone does not stop an existing writer. Remove obsolete roots from `PROPR_NATIVE_LOG_ROOTS` as well; a still-declared missing/unsafe root continues to refuse launches. Storage expansion alone does not lower retained logical-byte measurements.

The reset clears only that row's capacity high-water mark and cached inventory, marking it unmeasured/incomplete. It does not certify a zero-byte inventory, delete native files, change copy cursors or historical gaps, discard spool segments, or acknowledge backup. It is serialized with measurement transactions and survives restart. The next scan rebuilds the lower bound; roots with currently oversized diagnostic logs still refuse, and unsafe inventory, unavailable storage and filesystem reserve checks remain enforced. Scans are snapshots, so external writers can grow after any check; this command does not reserve space or cap them.

## Verification and limits of evidence

`packages/core/test/managedDiagnosticsCoverage.test.ts` covers native/Compose/managed root fixtures for all five providers, explicit refusals, unterminated final lines, Docker errors, bounded stack continuations, malformed JSON, oversized and control-character lines, and post-policy environment canaries. `packages/core/test/managedDiagnosticsPortability.test.ts` covers ctime-substituted birth time, legacy cursors, inode and anchor resets, SQLite-free disabled imports, duplicate module instances, an explicit policy upgrade, and hosted/native/mixed UID ownership fixtures. `packages/core/test/managedDiagnostics.test.ts` exercises real temporary files and SQLite, UTC midnight and multiple rolls, deterministic sealed retry, cursor CAS/restart, active Codex/Claude writer descriptors, all five provider layouts, unchanged credentials/resume files, private CLI export/ack and the real application logger hook. It covers secret canaries, absent acknowledgement, partial/oversize records, symlink/hardlink/FIFO/ancestor replacement, real SQLite-full and injected ENOSPC commit failure, concurrent processes, and a sparse 3 GiB provider file with a bounded RSS assertion. Existing logger, Docker execution/watchdog, native goals, provider agents and launcher suites are also relevant.

No live Hosted instance, installed provider-version behavior, encryption/readback service, or production acceptance is claimed. Fixtures validate the repository integration contract; Fleet must perform end-to-end private upload/readback and outage acceptance against deployed image digests. No UI changes or visual preview are involved.


## Original native files: issue #3015 safety boundary

Dependency PR #3014 was merged on 2026-10-12 before this implementation. No overlapping native maintenance writer is introduced. All supported native sources in the audit table remain protected: disposable diagnostic text files have an **unsupported writer lifecycle**, JSONL transcripts/history remain resume-dependent, and SQLite/WAL/SHM remain database state. Configuration, credentials and unrecognized entries are excluded from content collection. Completed status, file age, filenames and off-site export do not establish permission to delete any of these originals.

The current image defaults were checked against installed `claude --version` (2.1.284), `codex --version` (0.160.0) and `opencode --version` (1.18.31). This verifies installed versions, not their resume/rotation behavior. An isolated OpenCode 1.18.31 experiment ran `run --pure --model nonexistent/nonexistent test` with separate disposable HOME/XDG directories, model fetching and automatic updates disabled, and no customer credentials. Both default output and `--print-logs --log-level DEBUG` created `data/opencode/log/opencode.log`; stderr output did **not** suppress the original file. The invalid-model runs exited 1. The documented [print-logs option](https://opencode.ai/docs/cli/) is consequently not treated as a disk bound. Antigravity 1.2.4 and Vibe 2.25.8 layouts remain repository fixtures; their installed binaries were not tested here.

No provider-supported UTC daily plus size reopen/rollover has been verified for these persistent writers. No original is copytruncated, renamed, unlinked, archived or pruned, including after a task completes. Native daily/size rotation is **unsupported**, rather than simulated by rolling the copy spool. Container-only OpenCode/Antigravity state and disposable Vibe homes follow existing task cleanup; this change does not expand that cleanup or promise native-goal resumption. A real archive-retrieval/resume implementation and verified writer lifecycle are prerequisites for future native disposal, even with Fleet readback acknowledgement.

Measurements distinguish `diagnosticBytes/Files`, `sessionBytes/Files` and `databaseBytes/Files`, with a timestamp, descriptor identity digest, bounded-scan completeness and excluded-entry count. These are logical file sizes, useful for growing/sparse files; they are not allocated-block totals or a provider-home disk inventory. Missing classes are zero only within the explicit allowlist. Excluded directories are not recursively measured. `capacityBytesLowerBound` counts diagnostic-class bytes only and preserves their previous high-water mark when a scan is incomplete, including across restart. Session, database, auth/config and unknown bytes do not drive per-root or aggregate byte refusal; classified session/database totals remain visible in the inventory, and declared-root inventories also report auth/config and unknown bytes. `measuredBytes` and legacy `protectedBytes` continue to report allowlisted native-state totals separately from diagnostic capacity. Legacy all-class high-water marks are replaced using available classified diagnostic evidence, without deleting native files or resetting copy obligations. Historical collection gaps remain visible independently of a fresh measurement. Native and managed-spool usage stay separate.

Before launching, the gate measures at most 16 distinct recognized provider mounts, using the same pinned descriptor for filesystem capacity and inventory. Eligibility requires the exact per-agent provider suffix under explicitly configured `PROPR_MANAGED_CREDENTIALS_DIR`, or an exact explicit provider mount environment path. An arbitrary Docker bind argument or personal HOME does not authorize measurement. Other roots are reported as unmapped, not traversed. Credentials are not opened for these measurement-only scans. Each inventory retains the existing 4,096-entry / 250 ms bound; no file contents, multi-GB buffers or scratch copies are needed. Unsafe eligible inventories refuse launch. Entry bounds, deadlines and excluded directories retain incomplete status and use measured lower bounds plus persisted high-water marks for byte admission. Missing/unsafe spool storage also refuses new agent admission instead of assuming capacity is available.

The spool filesystem and eligible native filesystems must have at least 64 MiB available to the process and nonzero free inodes. These are descriptor-pinned `statfs` snapshots, not storage reservations. Concurrent admitted writers can exhaust capacity after checking; **no launch limit caps an already-running writer**. Existing customers' runs and descriptors are never stopped by this gate. Status therefore continues to expose `growthBounded: false`, unknown/unmeasured sources and `existingWritersCapped: false`. Session and database growth is governed by these filesystem reserve checks rather than diagnostic byte limits. Operators must investigate storage and retained diagnostic logs; this implementation offers no automatic native deletion to clear a refusal. Shared `/tmp/claude-logs` still has unverified multi-task ownership and is neither recursively collected nor deleted, including files created by ProPR for UI/session mappings.

## Explicit local-only diagnostic disposal

Fleet archival continues to require exact sealed-segment acknowledgement only after encrypted upload **and verified remote readback**. Collection/export is not backup. Without Fleet, an instance administrator may opt into `PROPR_DIAGNOSTIC_LOCAL_ONLY=1`, in addition to `PROPR_MANAGED_LOGS=1`, and invoke the private CLI:

```sh
npx tsx scripts/managed-diagnostics.ts discard-local SEGMENT_ID SHA256 --accept-local-diagnostic-loss
```

This disposes only that exact sealed managed-copy segment. It records `local-only-discard` gaps and lost bytes, returns `offsiteAcknowledged: false`, and does not create a remote acknowledgement or touch originals. Wrong/unsealed digests, missing activation or missing local-only policy refuse disposal. There is no member API/control, hosted account requirement or automatic age-based eviction. Administrators can repeatedly consume this bounded private spool without inventing an off-site backup. Existing export/redaction/privacy and unknown-loss reporting during ENOSPC/crash apply unchanged. Neither this policy nor the native admission gate changes the 60-day DB/config backup policy.

`packages/core/test/nativeLogAdmission.test.ts` adds classification, measurement-only credential canaries, active diagnostic descriptors across UTC midnight, ancestor replacement with pinned inventory, partial-scan/restart high-water marks, free-byte/inode/ENOSPC refusal, multi-GB original growth, self-managed launch refusal, growth during entitlement waiting, and local-only loss accounting. The diagnostics producer suite separately covers simultaneous collectors/writers, bounded reads, daily/size copy rollover, rejected files, SQLite-full and readback absence. These fixtures are not evidence of production original-file rollover or provider-native resumed-session acceptance; both remain unsupported/protected here.
