# Instance agent extensions

Instance Settings → Agent Extensions & Packages → Skills & MCP servers manages native Core
extension profiles. No Connect account or Hosted control is required. The API
requires a current **durable** `instance_members` administrator with
`instance.manage_settings` for every management operation. A bootstrap username
or repository assignment alone does not establish this authority: persist the
administrator in Access first.

Profiles contain a name, enabled state, optional agent/repository scopes, explicit
MCP tool permissions and immutable skill bundle references. Every save or secret
replacement creates a new revision with timestamps and the administrator's actor
ID. Automations and ordinary New Task submissions select zero or one exact
instance/profile/revision tuple. Choose the new revision after editing a profile;
queued runs do not silently move to it. Claude and Codex task execution are the
qualified targets. Goal execution and other runtimes refuse profiles.

Core rechecks the current selecting/launch administrator, scope,
capability policy, endpoint policy and current revision at the physical launch
boundary, immediately before container creation and again after capacity admission before start. Historical audit actors are provenance only; demoting a creator/editor does not revoke a valid profile used by another current administrator. A conditional database
write fences launch against disable, deletion, demotion and secret rotation. An
edit that wins before this boundary refuses the old launch; an edit after it
does not mutate the running revision. Completion revokes the gateway grant and
removes the temporary skill directory, including when execution fails.

## MCP policy

V1 supports stateless HTTPS MCP endpoints with JSON responses. Each server has a
stable name, an explicit list of allowed tool names, a read/write capability and
optional write-only bearer authentication. A write server also requires the run's
explicit write authorization. Runs without that authorization, including report phases and New Task without the write opt-in, launch with enabled write servers excluded. Action phases expose them under their explicit write policy. New Task exposes an unchecked write opt-in, persists it as part of the authenticated idempotent submission, and seals the exact payload/actor/repository/routing selection. Only that submission’s initial task can use it. Stale tasks, later label retries and replacement tasks run without extensions, as do native-export restored submissions with erased authorization. Routing/profile or payload substitutions on an eligible initial task fail authorization. Omission is false. Agent-definition action phases retain their existing explicit phase policy. `initialize`, `ping`, the initialized
notification, `tools/list` and explicitly listed `tools/call` are the only gateway
methods. Resource APIs, prompts, server-initiated requests, response cookies,
upstream session headers, SSE and stateful transports are unavailable. Connectivity
validation returns only server names and reachable booleans.

Endpoints must use port 443 and have no credentials, query parameters or fragments.
Core resolves and checks all DNS answers on every connection, then dials only a
vetted address while verifying the original TLS identity. Redirects, private,
loopback, link-local, metadata and reserved destinations are refused. The fake-IP
DNS range `198.18.0.0/15` remains reachable, matching the existing egress proxy;
TLS still verifies the original endpoint hostname. Operator-installed catalog entries can qualify local stdio and fixed internal HTTPS exceptions, as described below. Customer commands, host paths, Docker sockets and bind
mounts are rejected by the shared strict contract.

Core bounds each request to 64 KiB, each response to 1 MiB, four simultaneous
connections, 256 requests and 16 MiB of response traffic per run, with a ten-second
connection/response deadline. A run reserves a full response budget during each
request and refunds unused bytes after successful responses. Failed and oversized
responses consume the full reservation. Grants expire after twelve hours.
The existing task network policy is preserved; restricted runs additionally
capture the effective allowlist and instance-only private-address permissions in the immutable grant. Every gateway request and its DNS re-resolution must pass that captured policy. Catalog identity never overrides a restricted run’s hostname or private-address rules. Core retains per-run request/response accounting, connection reservations and resolution/denial telemetry as a `network.extensions` task event after deactivating the grant and before deleting its row. Telemetry and cleanup failures are logged without replacing the run outcome. The Core API gateway derives its container-reachable address from the existing
`PROPR_AGENT_MCP_URL` (or `PROPR_INTERNAL_API_URL`) setting and must itself
be reachable under that policy; profiles do not open internal
network destinations or relax enforced egress restrictions.

Provider launch arguments contain gateway URLs and environment **names** only.
The remote credential stays encrypted in Core and is never sent to the executor.
Run tokens are also redacted across subprocess chunk boundaries before live
output, task buffers, diagnostics or session inspection.
Bearer/header values, exact configured secrets and their common encodings are
redacted from gateway output, including tool descriptions. Upstream errors and
connectivity validation disclose no response content. Claude uses a strict MCP
catalog. Codex ignores its ambient user configuration while retaining the existing
`CODEX_HOME` authentication. This also skips operator settings in
`CODEX_HOME/config.toml`, including custom `model_provider`, provider base URLs
and profiles. Profile runs use ProPR’s explicit runtime launch settings; custom
providers configured only in that file are unsupported with a profile. Leave the
profile unselected when relying on those operator settings.
Profile runs refuse `.codex/config.toml` in the task
container workspace or its ancestry after repository setup because the qualified CLI has no project-config ignore
switch. These limitations are displayed in the editor.

## Operator-installed catalog

An operator supplies a bounded JSON array through `PROPR_EXTENSION_CATALOG_FILE` on Core and workers. Install it outside task/repository mounts, owned by the operator with no group/other write permissions. The file contains configuration and secret **references**, never secret values. No API accepts catalog installation or command configuration. Restart/update the operator service configuration through its existing secret-management mechanism; never put credentials in profile/UI input.

A stdio entry contains `id`, `kind: "stdio"`, an absolute `executable` under `/usr/local/bin`, `/usr/bin` or `/opt/propr` already installed in the qualified task image, a fixed `args` array, `secretEnv` mapping child environment field names to operator-managed service environment references, and allowed `tools` and required `capability`. There is no shell interpolation, customer argument substitution, host path/socket access or additional bind mount. Both Claude and Codex launch the installed `/opt/propr/extension-stdio-bridge.mjs` adapter in the existing isolated task container. It enforces the selected tools and bounded JSON protocol, drops child stderr and redacts configured secrets and encodings. Secret values travel through inherited environment names only, stay out of launch args/config JSON, and the launcher does not write them to the repository or provider home. Stdio catalog credentials are disclosed to the task container, including the agent CLI, shell tools and repository setup hooks. Those processes can read, persist or transmit them; output redaction does not prevent that access. Use only credentials appropriate for that trust boundary. Deployments must rebuild the qualified task image to include the adapter; no runtime package installation is attempted.

An HTTPS catalog entry instead contains `kind: "https"`, one credential-free fixed `url`, explicit pinned IP `addresses`, optional operator `bearerSecretRef`, and allowed `tools` and required `capability`. TLS identity and every resolved address must match; redirects remain refused. Restricted runs additionally need the hostname in their effective allowlist and private IP literals in the instance-owned address allowlist. Merely installing an internal catalog entry grants no network exception to a run.

The public catalog returns only `id`, canonical SHA-256 `digest`, allowed `tools`, declared `capability`, and opaque secret status `{count, configured}` (no environment names or secret references). The selected capability must match the operator entry; a write entry cannot be relabeled read to avoid a run write grant. Profiles reference `{kind: "catalog", name, catalogId, digest, enabled, tools, capability}`. The digest covers the entire private entry, including fixed arguments and secret reference names, using recursively sorted object keys and JSON encoding; secret values are excluded. Resolve and digest-check the entry at save, launch preparation, physical container creation/start, and each HTTPS gateway call. Catalog edits/removal fail existing mismatched selections closed. Choose the newly installed digest in a new profile revision. Customer `command`, `argv`, `args`, `env`, endpoint overrides, host paths, sockets and mounts are always rejected. Settings validation does not execute local catalog tools; their qualification and connectivity are exercised only in an authorized selected task run.

## Skills

Import a strict tar/tar.gz archive (5 MiB compressed, 4 MiB expanded, 256 entries),
or a GitHub repository authorized by the caller at an exact 40-character commit
and relative directory. Imports verify the commit object and materialize file
contents, source provenance and a SHA-256 content digest. Branch and tag names
are refused. Reimport to update a skill; saved bundles never fetch mutable source
contents at launch.

Archives reject traversal, absolute paths, links, devices, duplicate/case-colliding
paths, extension headers and decompression bombs. A root `SKILL.md` must contain
valid YAML frontmatter with `name` and `description`. Optional `requirements` is
a list of declarations displayed in the editor and task instructions. Declarations
never install endpoints, secrets or capabilities. Scripts and assets remain
untrusted task input and are never executed during import.

Only selected bundles are copied into a unique temporary directory under
`PROPR_EGRESS_SOCKET_DIR/extensions/<instance-id>`, verified against the saved digest and mounted read-only
at `/opt/propr/extensions`. The launch prompt identifies their `SKILL.md` paths.
Every staging ancestor must be a real directory. Writes use no-follow directory handles under a private operator staging root. Launch rechecks directory/file identities, rejects links, replacement races and unexpected files, and recomputes the saved content digest immediately before the read-only mount. Cleanup uses a retained parent handle so substituted ancestors cannot redirect it. The worker sweeps staging at startup and periodically, reclaiming run directories when their recorded PID namespace matches and their owner process is dead. New staging names also record the host boot identity, and the owning worker refreshes a lease every minute. Directories from foreign PID namespaces on the same host and boot are reclaimed after 48 hours without a refresh. Live owners in the current namespace, other host/boot identities, and legacy foreign directories are retained; legacy directories without owner evidence require manual cleanup after stopping tasks. No bundle is installed into a provider or executor home. Docker-outside-Docker
deployments use the existing `HOST_PROPR_EGRESS_SOCKET_DIR` mapping; a
missing/unusable bind namespace fails the launch. Skill-bearing runs require
Docker Engine **25 or newer** (API **1.44 or newer**) for
`bind-recursive=disabled`; older engines reject the mount option. Other task mounts, sandbox
settings and repository isolation remain in force.

## Backup, restore and reset

Profile revisions, immutable bundle contents and AES-256-GCM encrypted credential
custody live in the customer database. Encryption uses the existing private
credential trust root (`PROPR_CREDENTIAL_ENCRYPTION_KEY`, then
`SYSTEM_TASK_SECRET`, then `SESSION_SECRET`) with domain separation and
instance/profile/revision authenticated binding. Configure the same root on API
and workers. Never store the root in profile input.

Normal list/read/history/config projections contain only authentication field names and presence markers. Native database exports retain public profile revisions and bundle contents, erase encrypted extension credentials and sealed submission authority, and remove run grants. Reconfigure remote bearer tokens after a native export restore. Operator catalog files and secret references/values are never stored in the database or included in exports. Raw operator backups require the matching private encryption root; a different root fails decryption closed. Revision and the dedicated `extension_instance_identity` database row
must be restored together; IDs from another installation cannot be substituted.
The native database export removes ephemeral run grants, so an old execution
token cannot regain access after restore. Normal execution revokes grants on
completion; abandoned grants expire after twelve hours. Operator raw database
backups must also discard `extension_run_grants` before restoring service.

A full instance reset removes the database (including profiles, bundles, revision
history and encrypted secret material) and its data directory. After stopping tasks, discard temporary extension
staging under `PROPR_EGRESS_SOCKET_DIR/extensions/<instance-id>` as well. A queue reset alone is not a full instance reset. Profile
deletion tombstones new selection/launches while retaining encrypted revisions for
already running snapshots. Do not delete staging from an active task.

## Validation

API composition tests set `PROPR_API_DISABLE_AUTOSTART=1` before importing the server. Production startup is automatic for direct, symlinked and importing supervisor entries.

Deterministic Core and API tests cover durable local administrator success,
non-administrator and stale-session denial, CSRF preflight, tenant/profile/revision
substitution, capability and scope checks, rotation, disabling/deletion, URL and
DNS rejection, archive attacks, encrypted custody, sentinel redaction and temporary
mount cleanup. A synthetic TLS MCP fixture proves a selected gateway grant can
call the approved tool, an unselected grant cannot, redirects are refused and
oversized responses fail. Qualified pinned Claude/Codex CLI tests check exclusive
MCP catalogs and environment authentication. The browser test renders the actual
settings editor and checks security/provenance/history and write-only controls.

Skill-bearing runs require a Linux worker with `/proc/self/fd` available for secure directory-handle staging. Non-Linux workers reject skill staging with an explicit error; MCP-only profiles do not require these staging primitives.
