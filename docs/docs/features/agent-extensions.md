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
- the name, kind (HTTPS endpoint, **Local** with the package and version, operator catalog entry or skill source) and,
  for servers, a **Read** or **Write** badge;
- where it applies (**All repositories** or the repository list, plus any agent
  limit) and whether it applies automatically;
- for an OAuth server, its connection state (**Not connected**, **Connected** or
  **Needs sign-in**), who connected it and when, the granted scopes, and
  **Connect**, **Reconnect** and **Disconnect** (see [OAuth servers](#oauth-servers));
- notes and warnings: the Codex configuration limitation (below) on items that
  can reach a Codex agent, a missing Bearer token or secret variable, *Imported from profile X; not
  applied automatically* on migrated items, and the automations that add the item
  explicitly (on a switched-off item: that those automations currently run
  without it).

**Add server** opens one form: an HTTPS endpoint (with tool discovery and
authentication by a write-only Bearer token or OAuth sign-in), a
[local package](#local-package-servers) or an operator catalog entry, the allowed tools and
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

An item is an MCP server (`https`, local `package` or operator `catalog`, see below) or a reference
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

### Managed items

An installed [plugin](./plugins.md#what-an-enabled-plugin-adds) adds its MCP
servers and skills to the library as **managed items**, tagged with the plugin
id (`managedBy: { plugin, item, active }`, plus `registrations` on an OAuth
server: the client registration methods its sign-in may use; shown as a Plugin badge in the
settings screen). Their definition comes from the plugin manifest and is
read-only: a save may change only `enabled`, `repositories`, `agents` and
`autoApply`. Saves that change anything else on a managed item (for a package
server, also its package, version, integrity value, arguments and variables),
remove it or add an item with `managedBy` are refused, and so is replacing its
credential: a managed item's credential or secret variables come from the
plugin's connections. The plugin's own state wins over the item's: while the
plugin is disabled, or a package server waits for a new acknowledgement after
an upgrade, the item is inactive (`active: false`) and applies to no run
whatever its enabled switch says. Uninstalling the plugin removes its managed
items.

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
items with their reasons (`skipped`; auto-applied items appear there too when their
credential is missing: `secret_not_configured`, `oauth_not_connected` or
`oauth_needs_sign_in`), and, when they applied, `labelOptOut` (the
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
optional write-only bearer authentication or [OAuth sign-in](#oauth-servers). A write server also requires the run's
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
TLS still verifies the original endpoint hostname. Operator-installed catalog entries can qualify local stdio and fixed internal HTTPS exceptions, and [local package servers](#local-package-servers) run a pinned npm package through the same stdio bridge, as described below. Customer commands, host paths, Docker sockets and bind
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

## OAuth servers

Many hosted MCP servers accept only OAuth: a person signs in in a browser and the
client receives short-lived access tokens and a refresh token. Agent containers
are headless and one-shot, so ProPR signs in **as its own OAuth client** instead.
An administrator connects the server once from Settings, in their own browser.
Core stores the tokens encrypted, refreshes them, and the MCP gateway adds a
current access token to each upstream call, exactly as it adds a Bearer token.
Agent containers never see a token and never take part in a login flow, for
Claude and Codex alike. ProPR always identifies itself as ProPR: it never presents
another product's client id, client metadata, redirect URI or user agent.

### Adding and connecting a server

1. **Add server** with an HTTPS endpoint and **Authentication: OAuth sign-in**.
   Optionally enter **Scopes** to request (empty uses what the server asks for),
   and, for a client registered in the provider's developer console, its
   **Client id** and write-only **Client secret**. **Check** runs discovery and
   shows the authorization server, the scopes and which registration method a
   sign-in will use, without storing anything.
2. Save the server. Its row shows **Not connected**; runs skip it until it is connected.
3. **Connect** opens the provider's sign-in page in a new tab. Sign in and
   approve; the tab shows a short result page you can close. The Settings tab
   refreshes the row when you return to it, and it shows **Connected**, the
   administrator who connected it, when, and the granted scopes.

Only a durable administrator with `instance.manage_settings` can start a sign-in,
and the provider's redirect completes only in the browser session that started it.

:::warning[Shared identity]
Every run the server applies to acts with the access of the account that signed
in. A connection belongs to the library item, not to a person, and is shared by
every issue task, follow-up and automation run it applies to. Sign in with a
dedicated service account and request the narrowest scopes the tools need.
:::

### Discovery and registration

ProPR follows the MCP authorization specification. An unauthenticated request to
the server must return `401` with a `WWW-Authenticate` challenge naming its
protected resource metadata (RFC 9728); without it ProPR tries the well-known
location (`/.well-known/oauth-protected-resource`, path-specific first). That
document names the authorization server, whose metadata is read from
`/.well-known/oauth-authorization-server` (RFC 8414), falling back to OpenID
Connect discovery. The authorization server must support PKCE with `S256`.

ProPR identifies itself in this order:

| Method | When | What is stored |
| --- | --- | --- |
| Pre-registered client | You entered a client id. Explicit configuration always wins. | The client id in the library item; the client secret, if any, sealed like a Bearer token. |
| Client ID Metadata Document | The authorization server advertises `client_id_metadata_document_supported` and the instance has a public base URL. ProPR serves its own metadata at `<public API base URL>/api/instance/extensions/v1/oauth/client-metadata.json` and uses that URL as the client id. | Nothing beyond the connection. |
| Dynamic Client Registration (RFC 7591) | The authorization server advertises a `registration_endpoint`. | The issued client id with the connection; an issued secret sealed with the tokens. Reconnecting a Connected server reuses the registration; reconnecting from Needs sign-in registers again, because the provider may have rejected the client. |

When none is possible, Check and Connect say so: register a client in the
provider's developer console and enter its id, or use a static Bearer token if
the provider offers one.

The redirect URI is always
`<public API base URL>/api/instance/extensions/v1/oauth/callback`; register it
exactly for a pre-registered client (the form shows it). The public base URL is
the HTTPS origin of `MCP_PUBLIC_ORIGIN`, `API_PUBLIC_URL` or
`GH_OAUTH_CALLBACK_URL`, as for ProPR's own MCP server. Without one, **Connect**
is disabled with an explanation.

### The sign-in

Sign-in uses the authorization code flow with PKCE (`S256`). The request carries
the `resource` parameter (RFC 8707) set to the resource identifier the protected
resource metadata declares (the MCP server URL, or a parent path of it on the
same origin), and a `state` that
is random, single-use, expires after 10 minutes and is bound to the
administrator's session, the library item and its endpoint. The callback refuses
an unknown, reused or expired `state`, a `state` from another session or
administrator, and an `iss` parameter (RFC 9207) that does not name the
authorization server (or is missing when the server promises it), then exchanges
the code. A refused exchange, such as a PKCE verifier mismatch, stores nothing.

Every discovery, registration, token and revocation request goes through the
extension endpoint policy: HTTPS on port 443 without credentials, query or
fragment, every DNS answer public (private, loopback, link-local and metadata
addresses are refused), the checked address pinned for the connection, no
redirects, responses bounded to 256 KiB and ten seconds.

### Token custody and refresh

The access token, refresh token, expiry, granted scopes and a dynamically
registered client secret are encrypted with the extension private-credential
root, bound to the instance, the library item, its endpoint and client. They are
write-only: no API, MCP tool, CLI command, log line, task event, telemetry field
or native export contains them. Connecting, refreshing and disconnecting create
no library revision (they are credential state, not configuration); connect,
disconnect, discarded connections and moves to Needs sign-in are recorded with
the actor and time in the OAuth audit trail
(`GET /api/instance/extensions/v1/oauth/audit`).

For each upstream call the gateway asks Core for the current access token rather
than using one captured at launch, because a run can outlive a token. Core
refreshes a token shortly (one minute) before it expires and after the upstream
answers `401`; the gateway then retries the call once. Refresh is single-flight
per item: a second caller waits for the first result, across API processes too,
and a rotated refresh token is stored atomically with the new access token, so
concurrent runs never invalidate each other's token. A refresh carries the same
`resource` as the sign-in. Access tokens are on the gateway's redaction list.

When the authorization server refuses a refresh (`invalid_grant` and similar),
the item moves to **Needs sign-in** and administrators receive one Inbox
notification (category *system*, component `extensions.oauth`), not one per run.
Network failures and server errors are retried and leave the state unchanged.
**Reconnect** signs in again.

### Runs, edits and disconnecting

A server that is not connected, or needs sign-in, is left out of the run. The run
proceeds, and the `extensions.resolved` event records the server as skipped with
reason `oauth_not_connected` or `oauth_needs_sign_in`, for auto-applied items and
for items an automation adds explicitly. Changing the server's URL, switching its
authentication type or changing its client id discards the stored tokens and
requires a new sign-in; renaming or removing it does too. Disabling and
re-enabling the item keeps the connection. **Disconnect** calls the provider's
revocation endpoint (RFC 7009) when one is advertised, then deletes the stored
tokens.

### Out of scope

- Login flows inside agent containers, and reuse of the Claude or Codex
  runtimes' own MCP connectors or stored credentials.
- Presenting any other product's OAuth client identity.
- Per-user connections: a connection belongs to the library item and is shared
  by every run the item applies to.
- OAuth for operator catalog servers and for skills.

## Local package servers

A **local package** server is an MCP server published as an npm package and
started with `npx` elsewhere. An administrator adds it from Settings; it runs
inside the task container, next to the agent. PyPI packages (`uvx`) are not
supported yet: the agent image ships Node but no Python runtime for them.

### Adding one

**Add server**, then **Server type** › **Local package (npm)**. The form asks for:

| Field | Meaning |
| --- | --- |
| Package | The npm package name, for example `@scope/browser-mcp`. Public npm registry only. |
| Exact version | For example `1.4.2`. Ranges and tags (`latest`, `^1.2`, `1.x`) are rejected. |
| Executable | Optional. Needed only when the package declares several executables; otherwise ProPR runs the only one, or the one named after the package. |
| Arguments | A fixed list, one per line. Passed as is, without a shell. |
| Variables | Plain `NAME=value` pairs, saved with the server and shown in Settings. |
| Secret variables | Variable names whose values are write-only, stored like other extension secrets. |

Then the common controls: allowed tools (typed in; the package is never run in
Settings to discover them), capability, **Limit to repositories**, **Apply
automatically** and **Limit to agents**. Variables that change how Node loads
code or where a launch looks for programs (`PATH`, `HOME`, `NODE_OPTIONS`,
`NODE_PATH`, `LD_*`, proxy variables, `PROPR_*`, `NPM_*`) are refused.

**Check** looks the exact version up in the registry and shows the resolved
version, its integrity value and the executable that will run. Nothing is
downloaded or executed. The row shows the server as **Local** with its package
and version.

The library contract is:

```json
{ "kind": "package", "name": "browser", "ecosystem": "npm", "package": "@scope/browser-mcp", "version": "1.4.2",
  "integrity": "sha512-…", "bin": "browser-mcp", "args": ["--headless"], "env": [{ "name": "LOG_LEVEL", "value": "info" }],
  "secretEnv": ["BROWSER_TOKEN"], "enabled": true, "tools": ["navigate"], "capability": "read",
  "repositories": [], "agents": [], "autoApply": true }
```

There is no free-form command, shell, host path, extra mount, Docker socket or
Docker image: `command`, `argv`, endpoint overrides and every other unknown field
are rejected by the API. Secret values are sent separately, as
`secrets: { "<server>/<VARIABLE>": "<value>" }` on save or through
`POST /api/instance/extensions/v1/secrets` with `name: "<server>/<VARIABLE>"`.

### Pinning and integrity

Saving resolves the version in the registry and stores the registry's SHA-512
integrity value with the item; administrators never enter it, and a value sent
by a client is replaced. A later save that keeps the package, version and
executable keeps the stored value without asking the registry again. Updating a
server is an explicit edit of its version, which creates a new library revision;
ProPR never updates a version on its own.

A package that declares install scripts (`preinstall`, `install`,
`postinstall`) or a native build is unsupported: installs never run lifecycle
scripts, so such a package would not work.

### Where it runs

- The package is installed once per pinned package and integrity value, by the
  worker, into a worker-owned cache next to the skill staging area (under
  `PROPR_EGRESS_SOCKET_DIR`), never at task start and never in the task
  workspace. The install uses `npm install --ignore-scripts` with no user or
  global npm configuration and no registry credentials; dependencies are
  installed the same way, and their lifecycle scripts do not run either. The
  installed package must report the stored integrity value, or the install is
  refused.
- The install can reach the registry and nothing else. Every request npm makes,
  including each redirect, goes through a proxy on the worker that admits only
  the registry's host and port. The proxy resolves the name itself and connects
  only to the address it checked. The public registry must resolve to public
  addresses. A dependency that names a tarball URL elsewhere, such as a host on
  the worker's network, is never requested, and the install fails. Git
  dependencies cannot be fetched. A dependency that is not resolved from the
  registry with an integrity value, such as a `file:` path on the worker, also
  refuses the install. A refused install is skipped with `package_unavailable`,
  and nothing from it is recorded or mounted.
- Installed files are made read-only, and their digest is recorded in a manifest
  authenticated with the instance's private credential root. Later runs reuse the
  install.
- At every launch the installed files are checked against that manifest and the
  stored integrity value. A changed file refuses the server: the run proceeds
  without it and the `extensions.resolved` event records it as skipped with
  reason `package_integrity_mismatch`. A package that cannot be installed is
  skipped with `package_unavailable`. To recover from a changed install, remove
  its directory from the cache; the next run installs it again.
- The run mounts the install read-only at `/opt/propr/packages/<n>` and starts
  it with the image's Node through the same stdio bridge
  (`/opt/propr/extension-stdio-bridge.mjs`) as an operator catalog stdio entry,
  for Claude and Codex alike. The bridge enforces the selected tools, bounds the
  JSON protocol, drops the server's stderr and redacts the configured secrets.
- The server process has the run's own network policy and nothing more. It is
  never reachable through Core's HTTPS gateway.

Operators can point installs and **Check** at a mirror of the public registry
with `PROPR_EXTENSION_NPM_REGISTRY` on Core and workers. The mirror is operator
configuration, so it may resolve to a private address. Installs then reach the
mirror's host and port only, and the mirror must serve the package tarballs from
that same host and port. The worker's `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`
settings apply to the install proxy's own connections, not to npm. Private
registries and registry credentials are not supported.

### Credentials: the container trust boundary

A local server runs in the same container as the agent. Any secret variable
value is readable by the agent CLI, its shell commands and the repository's
setup scripts; output redaction does not prevent that. This is unlike HTTPS
servers, whose credential stays in Core behind the gateway. Use a narrowly
scoped credential that is safe for the agent to hold.

The form says this next to the secret fields. Saving a package server that has
any secret variable requires ticking **I understand that these values are
readable inside the task container**; the API refuses the save without
`acknowledgements: ["<server>"]`. The acknowledgement (administrator and time,
with the package, version and variable names it covers) is stored with the
library revision under `acknowledgements`, and carries over while those stay the
same. Changing the version or the secret variables needs a new acknowledgement.
A server with no secret variables shows no warning and needs none.

Secret values reach the server through environment names only, never through
launch arguments or configuration JSON, and are never written to the repository
or the provider home. A server with a missing secret value is skipped with
`secret_not_configured`. Changing the package or renaming the server clears its
stored values.

### Limits and what a run records

The usual rules apply: a `write` server is exposed only when the run carries
write authorization; the labels `disable-mcps` and `disable-extensions` remove
it; disabling the item removes it and re-enabling restores it; and the per-run
limit of 8 servers counts all kinds together. The `extensions.resolved` task
event lists package servers by name and in `packages` with their ecosystem,
package and version; it never includes variable values or secrets.

### Out of scope

- PyPI packages.
- Servers distributed as Docker images or run as sidecar containers.
- Free-form commands, shell snippets, host executables and host paths.
- Private registries and registry credentials.
- OAuth for local servers.
- Automatic version updates.

## Operator-installed catalog

Operator catalog entries remain for operators who want fixed servers baked into
the agent image.


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

Normal read/history/config projections contain only authentication field names and presence markers. Native database exports retain the public library revisions and bundle contents, erase encrypted extension credentials, OAuth connections and pending sign-ins, and sealed submission authority, and remove run grants. After a restore, OAuth servers show **Not connected** until an administrator connects them again. After a native export restore, Bearer servers show their secret as not configured and are skipped at launch until you replace the token. Operator catalog files and secret references/values are never stored in the database or included in exports. Raw operator backups require the matching private encryption root; a different root fails decryption closed. Under a different root you can still enable and disable items, because that never decrypts credentials; restoring the matching root recovers them. Saving the library, replacing a secret, validation and Bearer server calls need the matching root. Revisions and the dedicated `extension_instance_identity` database row
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
A synthetic authorization server and OAuth-protected MCP server fixture
(`test/fixtures/extensionOAuthFixture.ts`) covers OAuth discovery from the `401`
challenge and the well-known fallback, all three registration methods, PKCE,
`state` and `iss` refusals, single-flight refresh with rotation, the
one-refresh-one-retry path, Needs sign-in with its single notification, endpoint
policy refusals and token sentinels; a browser test drives **Connect** through
the provider's page and the callback.

Skill-bearing runs require a Linux worker with `/proc/self/fd` available for secure directory-handle staging. Non-Linux workers reject skill staging with an explicit error; Runs with only MCP servers do not require these staging primitives.

## Next steps

- [MCP Connections and Operator Tools](/docs/features/mcp)
- [Agents and Models](/docs/features/agents-and-models)
- [Plugins](/docs/features/plugins): official integrations that bundle MCP servers, skills and automation templates
