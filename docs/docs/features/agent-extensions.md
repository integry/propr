---
sidebar_label: "Instance agent extensions"
title: "Configure agent skills and MCP extensions"
description: "Manage the instance extension library of authorized MCP servers and skill bundles, with per-item limits, applied automatically to Claude and Codex issue tasks, pull request follow-ups and automation runs."
---
# Instance agent extensions

Instance Settings → Agent Extensions & Packages → Skills & MCP servers manages the
native Core **extension library**: one instance-wide list of MCP servers and skill
bundle references. No Connect account or Hosted control is required. The API
requires a current **durable** `instance_members` administrator with
`instance.manage_settings` for every management operation. A bootstrap username
or repository assignment alone does not establish this authority: persist the
administrator in Access first.

## The settings screen

**Skills & MCP servers** opens with a short explanation of how items reach runs,
then two flat lists, **MCP servers** and **Skills**. Each row shows:

- an **enabled checkbox**. Ticking or unticking it saves at once through the
  single-item endpoint (`POST /api/instance/extensions/v1/items/enabled`), with no
  form and no separate Save step. While the request runs the checkbox is
  disabled; if it fails, the checkbox returns to its previous state and the error
  is shown. A switched-off row stays in the list, dimmed with an **Off** status,
  and keeps all its settings and its stored secret;
- the name, kind (HTTPS endpoint, operator catalog entry or skill source) and,
  for servers, a **Read** or **Write** badge;
- where it applies (**All repositories** or the repository list, plus any agent
  limit) and whether it applies automatically;
- notes and warnings: the Codex configuration limitation (below) on items that
  can reach a Codex agent, a missing Bearer token, *Imported from profile X; not
  applied automatically* on migrated items, and the automations that add the item
  explicitly (on a switched-off item: that those automations currently run
  without it).

**Add server** opens one form: an HTTPS endpoint (with tool discovery and a
write-only Bearer token) or an operator catalog entry, the allowed tools and
capability, then the item limits: **Limit to repositories** (empty means every
repository), **Apply automatically** (on by default) and, under **Advanced**,
**Limit to agents**. **Add skill** picks a skill already imported, or imports one
from a tar/tar.gz archive or a pinned GitHub commit, with the same three limits.
Saving a form creates a new library revision at once. **Edit** opens the same
form for a row; renaming a server or changing its endpoint clears its stored
token, so enter it again. **Remove** asks for confirmation; an item an automation
adds is refused with the automations named.

A warning above a list appears when more than 8 enabled servers or 8 enabled
skills could apply to one repository and agent combination: only 8 are used per
run. **Validate saved MCP connectivity** checks the saved HTTPS servers, and
**Revision history** lists every library revision with the administrator and
time. Bearer tokens are never shown; the form only says whether one is
configured.

Automations pick further items in their editor under
[Additional extensions](./agents.md#extensions).

## Library items

An item is an MCP server (`https` or operator `catalog`, see below) or a reference
to an imported skill bundle. Server names are unique across the library. The
library holds up to 32 servers and 32 skill bundles. Each item has:

| Field | Meaning |
| --- | --- |
| `enabled` | Turns the item off without removing it. A disabled item keeps its configuration, limits and stored secret, applies to no run, and can be re-enabled at any time. Disabling is never refused, even when an automation adds the item; that automation then runs without it and reports it as skipped. |
| `repositories` | Optional `owner/repo` list. Empty means every repository. A run on several repositories needs all of them in the list. |
| `agents` | Optional agent aliases (an advanced option in the editor). Empty means every agent. |
| `autoApply` | Default `true` for new items. Items with `autoApply` reach every matching issue task, pull request follow-up and automation run. When `false`, the item is used only where it is added explicitly, through an [automation's extensions](./agents.md#extensions); tasks never receive it. |

Every save, single-item enable/disable and secret replacement creates a new library
revision with a timestamp and the administrator's actor ID. Saving requires the
revision the edit is based on (`expectedRevision`); a concurrent change is refused
and must be reloaded. A server's credential is stored once, sealed to the library
revision. Enabling or disabling an item carries the sealed credentials into the new
revision unchanged, without decrypting them. Removing or renaming an item that an automation adds explicitly is
refused with a message naming those automations; remove it from them first.

## Which runs use extensions

At launch, Core resolves the run's extension set against the **current** library
revision: enabled `autoApply` items whose repository and agent limits match, plus
enabled matching items the run adds explicitly (these ignore `autoApply`). An
explicitly added item that is missing, disabled, outside its limits, lacks its
credential, or needs write authorization the run does not have is skipped with a
reason; it is never an error. Items are ordered by name. A run carries at most 8
MCP servers (counting its own ProPR server) and 8 skill bundles. When more apply,
explicit items are kept first, then automatic items by name; the rest are listed
as omitted.

### Which runs use extensions

| Run | Items | Write servers |
| --- | --- | --- |
| Issue implementation task, however it was started (label, New Task, MCP, plan or epic), including retries and replacement attempts | Matching `autoApply` items | Only the initial task of a New Task submission with the write opt-in |
| Pull request follow-up (comments, `/fix`, Ultrafix fix steps), including retries | Matching `autoApply` items | Never |
| Automation run | Matching `autoApply` items plus the automation's added items | Action phase only |

Resolution happens when the task's container is created, not when it is
queued. Editing the library never invalidates a queued task: it launches with the
library as it is at that moment. Claude and Codex task execution are the qualified
targets. Other runtimes, and goal runs, launch without extensions as before
(goal execution refuses explicitly added items). Review runs and Ultrafix review
steps do not use the library.
If the library cannot be read when an issue task or follow-up resolves it (for
example after a restore with mismatched revision identity), that run launches
without extensions and a warning is logged; automation runs and explicitly added
items still refuse.

### Opt-out labels

Labels on the issue (issue tasks) or on the pull request (follow-ups), read when
the run starts, remove auto-applied items from that run:

| Label | Effect |
| --- | --- |
| `disable-mcps` | No library MCP servers |
| `disable-skills` | No library skill bundles |
| `disable-extensions` | Neither |

The labels only remove items; they never add one, and they do not affect
automation runs. New Task's **Run without extensions** switch adds
`disable-extensions` to the issue it creates.

### New Task

New Task shows, read-only, which library items will apply for the chosen
repository and agent (`GET /api/task-submission-extensions`, names only). When a
write server would apply, the form offers **Allow write servers for this task's
first run**. The opt-in is sealed into the submission and is valid only for that
submission's initial task; label-started tasks, retries, replacement attempts and
pull request follow-ups receive read servers and skills only. The API accepts
`extensionAllowWrite: true` only with the `X-ProPR-Extensions: 1` preflight
header, and not together with `disableExtensions`. Extension profiles can no
longer be selected; queued New Task submissions recorded before the upgrade keep
their extensions for their initial task (see
[Upgrading](#upgrading-from-earlier-versions)).

### What a run records

Each run that requests extensions records one `extensions.resolved` task event:
the library revision, `runKind`, `provenance` (`source: auto`, `additional` or
`mixed`, and the revision's audit actor), the applied server names and skill
names, which were auto-applied (`autoApplied`) and which were added explicitly
(`added`), items left out by the per-run limit (`omitted`), skipped additional
items with their reasons (`skipped`), and, when they applied, `labelOptOut` (the
labels and the items they removed) and `autoApplySkipped` (the Codex reason
below). The event never contains secrets, URLs, credentials or tool output. The
existing `network.extensions` telemetry event is unchanged. The run grant records
the same `source` with the revision's audit actor.

The authority for a launch is the library revision itself, which only an
administrator can save; no selecting administrator is needed at launch, and the
revision's audit actor is recorded as provenance. Core rechecks capability policy,
endpoint policy, catalog digests and the resolved items at the physical launch
boundary, immediately before container creation and again after capacity
admission before start. A conditional database write fences launch against
disabling, removal, limit changes and secret rotation of the items the run uses:
such an edit that wins before this boundary refuses the old launch, while edits to
other items or newly added items do not. An edit after the boundary does not
mutate the running revision. Completion revokes the gateway grant and removes the
temporary skill directory, including when execution fails.

## MCP policy

V1 supports stateless HTTPS MCP endpoints with JSON responses. Each server has a
stable name, an explicit list of allowed tool names, a read/write capability and
optional write-only bearer authentication. A write server also requires the run's
explicit write authorization. Runs without that authorization, including automation report phases, launch with write servers excluded. Automation action phases expose them under their explicit phase policy, and so does the initial task of a New Task submission with the write opt-in. Label-started tasks, retries, replacement attempts and pull request follow-ups never receive write servers. Omission is false. `initialize`, `ping`, the initialized
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
be reachable under that policy; library items do not open internal
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
and named configurations. Runs with extensions use ProPR’s explicit runtime launch
settings. Runs with extensions refuse `.codex/config.toml` in the task container
workspace or its ancestry after repository setup because the qualified CLI has no
project-config ignore switch. These limitations are displayed in the editor.

Auto-apply never breaks a Codex run that works without extensions. Before launch
the worker checks both conditions: the operator `config.toml` defines a custom
model provider (`model_provider` other than a built-in one, or a
`[model_providers.*]` table) or a profile (`profile` or `[profiles.*]`), or the
workspace contains `.codex/config.toml`. When either holds, the run launches
**without** its auto-applied items and the `extensions.resolved` event records
`autoApplySkipped` with the reason (`codex_operator_config` or
`codex_workspace_config`). This applies to issue tasks, follow-ups and the
auto-applied items of automation runs. Items an automation adds explicitly keep
the strict behaviour: such a run still ignores the operator configuration and
refuses a workspace `.codex/config.toml`.

## Operator-installed catalog

An operator supplies a bounded JSON array through `PROPR_EXTENSION_CATALOG_FILE` on Core and workers. Install it outside task/repository mounts, owned by the operator with no group/other write permissions. The file contains configuration and secret **references**, never secret values. No API accepts catalog installation or command configuration. Restart/update the operator service configuration through its existing secret-management mechanism; never put credentials in library/UI input.

A stdio entry contains `id`, `kind: "stdio"`, an absolute `executable` under `/usr/local/bin`, `/usr/bin` or `/opt/propr` already installed in the qualified task image, a fixed `args` array, `secretEnv` mapping child environment field names to operator-managed service environment references, and allowed `tools` and required `capability`. There is no shell interpolation, customer argument substitution, host path/socket access or additional bind mount. Both Claude and Codex launch the installed `/opt/propr/extension-stdio-bridge.mjs` adapter in the existing isolated task container. It enforces the selected tools and bounded JSON protocol, drops child stderr and redacts configured secrets and encodings. Secret values travel through inherited environment names only, stay out of launch args/config JSON, and the launcher does not write them to the repository or provider home. Stdio catalog credentials are disclosed to the task container, including the agent CLI, shell tools and repository setup hooks. Those processes can read, persist or transmit them; output redaction does not prevent that access. Use only credentials appropriate for that trust boundary. Deployments must rebuild the qualified task image to include the adapter; no runtime package installation is attempted.

An HTTPS catalog entry instead contains `kind: "https"`, one credential-free fixed `url`, explicit pinned IP `addresses`, optional operator `bearerSecretRef`, and allowed `tools` and required `capability`. TLS identity and every resolved address must match; redirects remain refused. Restricted runs additionally need the hostname in their effective allowlist and private IP literals in the instance-owned address allowlist. Merely installing an internal catalog entry grants no network exception to a run.

The public catalog returns only `id`, canonical SHA-256 `digest`, allowed `tools`, declared `capability`, and opaque secret status `{count, configured}` (no environment names or secret references). The selected capability must match the operator entry; a write entry cannot be relabeled read to avoid a run write grant. Library servers reference `{kind: "catalog", name, catalogId, digest, enabled, tools, capability}` plus the item limits. The digest covers the entire private entry, including fixed arguments and secret reference names, using recursively sorted object keys and JSON encoding; secret values are excluded. Resolve and digest-check the entry at save, launch preparation, physical container creation/start, and each HTTPS gateway call. Catalog edits/removal fail existing mismatched selections closed. Choose the newly installed digest in a new library revision. Customer `command`, `argv`, `args`, `env`, endpoint overrides, host paths, sockets and mounts are always rejected. Settings validation does not execute local catalog tools; their qualification and connectivity are exercised only in an authorized task run that uses them.

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

Only the run's resolved bundles are copied into a unique temporary directory under
`PROPR_EGRESS_SOCKET_DIR/extensions/<instance-id>`, verified against the saved digest and mounted read-only
at `/opt/propr/extensions`. The launch prompt identifies their `SKILL.md` paths.
Every staging ancestor must be a real directory. Writes use no-follow directory handles under a private operator staging root. Launch rechecks directory/file identities, rejects links, replacement races and unexpected files, and recomputes the saved content digest immediately before the read-only mount. Cleanup uses a retained parent handle so substituted ancestors cannot redirect it. The worker sweeps staging at startup and periodically, reclaiming run directories when their recorded PID namespace matches and their owner process is dead. New staging names also record the host boot identity, and the owning worker refreshes a lease every minute. Directories from foreign PID namespaces on the same host and boot are reclaimed after 48 hours without a refresh. Live owners in the current namespace, other host/boot identities, and legacy foreign directories are retained; legacy directories without owner evidence require manual cleanup after stopping tasks. No bundle is installed into a provider or executor home. Docker-outside-Docker
deployments use the existing `HOST_PROPR_EGRESS_SOCKET_DIR` mapping; a
missing/unusable bind namespace fails the launch. Skill-bearing runs require
Docker Engine **25 or newer** (API **1.44 or newer**) for
`bind-recursive=disabled`; older engines reject the mount option. Other task mounts, sandbox
settings and repository isolation remain in force.

## Backup, restore and reset

Library revisions, immutable bundle contents and AES-256-GCM encrypted credential
custody live in the customer database. Encryption uses the existing private
credential trust root (`PROPR_CREDENTIAL_ENCRYPTION_KEY`, then
`SYSTEM_TASK_SECRET`, then `SESSION_SECRET`) with domain separation and
instance/library-revision authenticated binding. Configure the same root on API
and workers. Never store the root in library input.

Normal read/history/config projections contain only authentication field names and presence markers. Native database exports retain the public library revisions and bundle contents, erase encrypted extension credentials and sealed submission authority, and remove run grants. After a native export restore, Bearer servers show their secret as not configured and are skipped at launch until you replace the token. Operator catalog files and secret references/values are never stored in the database or included in exports. Raw operator backups require the matching private encryption root; a different root fails decryption closed. Under a different root you can still enable and disable items, because that never decrypts credentials; restoring the matching root recovers them. Saving the library, replacing a secret, validation and Bearer server calls need the matching root. Revisions and the dedicated `extension_instance_identity` database row
must be restored together; IDs from another installation cannot be substituted.
The native database export removes ephemeral run grants, so an old execution
token cannot regain access after restore. Normal execution revokes grants on
completion; abandoned grants expire after twelve hours. Operator raw database
backups must also discard `extension_run_grants` before restoring service.

A full instance reset removes the database (including the library, bundles,
revision history and encrypted secret material) and its data directory. After stopping tasks, discard temporary extension
staging under `PROPR_EGRESS_SOCKET_DIR/extensions/<instance-id>` as well. A queue reset alone is not a full instance reset. Removing
or disabling an item stops new launches from using it while running tasks keep
their immutable snapshot. Do not delete staging from an active task.

## Upgrading from earlier versions

Earlier versions grouped servers and skills into separately scoped bundles that
automations and New Task selected one at a time. At the first API or worker start
after the upgrade, Core copies them into the library once (it is idempotent and
safe to re-run, and never blocks startup):

- Every server and skill becomes a library item whose `repositories` and `agents`
  come from its former scope. All migrated items have `autoApply: false`, so no
  run's behaviour changes until you turn it on.
- Identical servers (same kind, URL or catalog id and digest, tools, capability,
  authentication and credential) merge into one item whose limits are the union
  of their sources; if any source had no limit, the merged item has none.
  Different servers that share a name get a deterministic `-2`, `-3`, … suffix,
  and the rename is logged.
- Each automation that selected one of them adds the corresponding (possibly
  renamed) items explicitly, so it launches with the same servers and skills.
- Queued New Task submissions that carried such a selection keep it for their
  initial task through a small legacy mapping to the migrated item names.
  Re-sending such a submission with its original idempotency key still returns
  its receipt.
- The copy uses each bundle's current revision. A selection of an older revision
  (an automation, a queued automation run, or a queued submission saved before
  the bundle was last edited) never receives the current revision's items, since
  they were never authorized for it. An automation or run adds no items, and a
  warning is logged. A submission's task is refused, as it was before the upgrade.
- Bearer tokens are re-sealed to the library. A token that cannot be decrypted
  (for example under a different encryption root) leaves the item with its secret
  marked not configured and logs a warning; replace it in Settings.

The library holds at most 32 servers and 32 skill bundles, and an item at most
64 repositories and 64 agents. If the previous configuration does not fit (for
example five bundles of eight distinct servers each), nothing is dropped: the
copy is not committed, the startup log lists the items that do not fit, and
it retries at the next start. Until it completes, automations that selected a
bundle are not launched (their trigger returns 409). Remove library items you no
longer need in Settings, or retire unused bundles (set `deleted` on their
`extension_profiles` row), then restart.

The previous tables are kept unchanged. Migrated items show *Imported from
profile X; not applied automatically* in Settings. Review them, then enable
**Apply automatically** where an item should reach every matching run.

## Validation

API composition tests set `PROPR_API_DISABLE_AUTOSTART=1` before importing the server. Production startup is automatic for direct, symlinked and importing supervisor entries.

Deterministic Core and API tests cover durable local administrator success,
non-administrator and stale-session denial, CSRF preflight, tenant/revision
substitution, capability and item-limit checks, rotation, disabling/removal, URL and
DNS rejection, archive attacks, encrypted custody, sentinel redaction and temporary
mount cleanup. A synthetic TLS MCP fixture proves a selected gateway grant can
call the approved tool, a grant without that server cannot, redirects are refused and
oversized responses fail. Qualified pinned Claude/Codex CLI tests check exclusive
MCP catalogs and environment authentication. The browser test renders the actual
settings lists and forms and checks the enabled checkbox round trip, limits, provenance, history and write-only controls.

Skill-bearing runs require a Linux worker with `/proc/self/fd` available for secure directory-handle staging. Non-Linux workers reject skill staging with an explicit error; Runs with only MCP servers do not require these staging primitives.

## Next steps

- [MCP Connections and Operator Tools](/docs/features/mcp)
- [Agents and Models](/docs/features/agents-and-models)
