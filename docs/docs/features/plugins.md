---
sidebar_label: "Plugins"
title: "Plugins: the manifest format"
description: "What a ProPR plugin is, where official plugins live, and the manifest that describes their permissions, connections, settings and contributions."
---
# Plugins

A **plugin** packages an integration with another service (a chat tool, an
issue tracker, an observability or deployment platform) as one unit that an
administrator can review and install. Official plugins are trusted code shipped
with ProPR. Nothing is downloaded when a plugin is installed, except the pinned
npm package of a local MCP server, which goes through the same package cache and
integrity check as the [extension library's local package servers](./agent-extensions.md#local-package-servers).

:::note Work in progress
This page describes the plugin **manifest**, the official plugin registry, the
[Plugins page](#the-plugins-page) and the installation API. A plugin's
generated settings form, handlers, webhooks and commands are added by later
releases.
:::

## Where plugins live

Each official plugin is a folder `packages/plugins/<id>/` in the ProPR
repository:

| File | Purpose |
| --- | --- |
| `manifest.json` | Everything ProPR shows about the plugin, as pure data. ProPR can list a plugin, its permissions and its contributions without loading any of its code. |
| `README.md` | What the plugin does and how to set it up. Required. |
| icon | An `.svg` or `.png` file named by the manifest's `icon`. |
| skill folders | Skill bundle sources, each with a `SKILL.md`, named by `contributes.skills`. |
| automation template folders | Templates in the shipped automation template format (`template.json` and `prompt.md`), named by `contributes.automationTemplates`. |

`packages/plugins/registry.json` lists the plugins in catalog order. The
`@propr/plugins` workspace package exports that list with each manifest and the
resolved paths of its assets.

Development plugins are marked `"development": true` in `registry.json` and are
left out of the list unless `PROPR_PLUGINS_DEVELOPMENT=1` is set. The
`example-pack` plugin is one: it contributes one remote MCP server, one local
package server, one skill and one automation template, and is used by ProPR's
own tests and as a reference for plugin authors.

## The manifest

The schema is defined in `@propr/shared` (`packages/shared/src/plugins.ts`).

| Field | Description |
| --- | --- |
| `manifestVersion` | Currently `1`. |
| `id` | Lowercase slug such as `acme-chat`, unique among plugins and equal to the folder name. |
| `name`, `description` | Shown in the catalog. |
| `version` | Semantic version of the plugin, such as `1.2.0`. |
| `category` | One of `messaging`, `issue-tracking`, `observability`, `deployment`, `context`, `other`. |
| `homepage` | An `https://` URL. |
| `icon` | Path of an `.svg` or `.png` file inside the plugin folder. |
| `permissions` | What the plugin's handlers may do, from a closed list (below). Plugins that only contribute servers, skills and templates usually need none. |
| `connections` | Named credentials the plugin needs (below). |
| `settings` | The plugin's settings, in a JSON Schema subset (below). |
| `outboundHosts` | Hostnames, such as `api.example.com`, that the plugin's handlers may call. No scheme, port, path, wildcard or IP address. |
| `contributes` | What the plugin adds to ProPR (below). |

Unknown fields are refused everywhere, so a misspelled field is an error rather
than silently ignored.

### Permissions

`events.read`, `tasks.read`, `tasks.create`, `issues.read`, `issues.create`,
`issues.comment`, `pull_requests.read`, `pull_requests.comment`,
`repositories.read` and `notifications.send`. A command can only use
permissions the plugin requests, and event subscriptions need `events.read`.

### Connections

Each connection has a `name`, a `type`, a `label`, `help` text and a `helpUrl`
pointing to where the credential is obtained.

| Type | What the administrator provides |
| --- | --- |
| `oauth` | A sign-in, using the same flow as [OAuth library servers](./agent-extensions.md#oauth-servers). `registrations` limits the client registration methods (`metadata_document`, `dynamic`, `preregistered`; all three by default) and `scopes` lists the scopes to request. |
| `token` | A secret pasted by the administrator, such as an API token. |
| `signing_secret` | The shared secret that verifies inbound webhooks. |

### Settings

`settings` is an object schema: `{ "type": "object", "properties": { ... }, "required": [ ... ] }`.
Every property has a `label`, optional `help` and an optional `default`, and is
one of:

| Shape | Meaning |
| --- | --- |
| `{ "type": "string" }` | Text, with optional `maxLength`. With `enum`, one of a fixed list of values. |
| `{ "type": "number" }` | A number, with optional `minimum`, `maximum` and `integer`. |
| `{ "type": "boolean" }` | A switch. |
| `{ "type": "array", "items": { "type": "string" } }` | A list of strings, with optional `maxItems`. |
| `{ "type": "object", "format": "repository-map", "additionalProperties": { "type": "string" } }` | A value per repository, keyed by `owner/repo`. |

Defaults must satisfy their own constraints, and every `required` key must be
defined.

### Contributions

| Field | Contents |
| --- | --- |
| `mcpServers` | MCP servers, in the [extension library](./agent-extensions.md)'s item shapes (below). |
| `skills` | `{ "name", "path" }`: a skill bundle folder inside the plugin folder. Its `SKILL.md` front matter must use the same `name`. |
| `automationTemplates` | `{ "id", "path" }`: a template folder in the automation template format. It must pass the same checks as the shipped templates. |
| `commands` | `{ "name", "description", "permissions" }`. Accepted and validated; not used yet. |
| `subscriptions` | `{ "event" }`, a dotted event name such as `task.completed`. Accepted and validated; not used yet. |
| `webhooks` | `{ "name", "description", "connection" }`, where the connection is a `signing_secret`. Accepted and validated; not used yet. |

Names are unique within each list, and command names are unique across all
plugins.

#### Remote servers

```json
{
  "kind": "https", "name": "acme", "url": "https://mcp.acme.example.com/mcp",
  "tools": ["search"], "capability": "read",
  "authentication": "oauth", "connection": "workspace"
}
```

`authentication` is `none`, `bearer` or `oauth`. A `bearer` server names a
`token` connection, an `oauth` server names an `oauth` connection, and a `none`
server names no connection. The endpoint must be `https://`.

#### Local package servers

```json
{
  "kind": "package", "name": "acme-local",
  "ecosystem": "npm", "package": "@acme/mcp-server", "version": "2.0.1",
  "integrity": "sha512-…",
  "bin": "acme-mcp", "args": ["--read-only"],
  "env": [{ "name": "ACME_REGION", "value": "eu" }],
  "secretEnv": [{ "name": "ACME_TOKEN", "connection": "api-token" }],
  "tools": ["post"], "capability": "write"
}
```

The rules are those of the extension library's local package servers: an npm
package with an exact `version` (no ranges such as `^2.0.0` and no tags such as
`latest`), and no paths, images or free-form commands. Unlike a library item,
the manifest records the `integrity` value of the pinned version itself, and
each `secretEnv` variable names one of the plugin's `token` connections instead
of holding a value.

## Checking manifests

```bash
npm run plugins:check
```

validates every plugin in `packages/plugins`: the manifest schema and its
cross-references, that `registry.json` lists each plugin folder exactly once,
that ids match their folders, that command names are unique, and that the
README, icon, skill folders and automation templates exist and are valid. CI
runs it on every pull request.

```bash
npm run plugins:check -- --online [--registry https://registry.npmjs.org]
```

also asks the npm registry for each package server's version and compares the
recorded `integrity` value. It needs network access and is not run in CI.

## The Plugins page

**Plugins** (`/plugins`) is where an administrator installs a plugin and makes
it work without knowing what it contributes internally. It is in the sidebar
(on mobile, under **More**) and linked from **Settings → Agent Extensions &
Packages → Skills & MCP servers**, and only durable administrators with
`instance.manage_settings` see it. Everything on the page is drawn by ProPR
from the manifest: manifest text is shown as plain text, links appear only for
`https` URLs, and no code, image or markup supplied by the plugin runs in the
browser.

### Catalog

The catalog shows one card per plugin: an icon for its category, its name,
one-line description, category and a state badge. Filter by **Category** or
type in **Search by name**.

| Badge | Meaning |
| --- | --- |
| Not installed | Available in this ProPR, not installed. |
| Off | Installed, every connection set, not enabled. |
| Needs connection | Installed and not enabled, with a connection still to set or sign in. |
| Enabled | Enabled, every connection set. |
| Needs approval | An upgrade asks for permissions or a secret acknowledgement not yet approved. |
| Degraded | Enabled while a connection is missing or needs a new sign-in, or no longer in this ProPR's registry. |

### Walkthrough

Open a card to see the plugin's steps, always in this order, each marked
**Done** or **To do**:

1. **Install.** The step says what the plugin adds in plain words, for example
   "Adds 1 MCP server the agent can read from", "Runs 1 local server inside
   the task container" or "Adds the /deploy command", and lists the
   permissions it asks for, each with a one-line explanation. When a local
   package server receives secret variables, the step shows the package, its
   exact version and the variable names, with a required checkbox confirming
   that those secrets are readable inside the task container. **Install**
   stays unavailable until it is ticked. After an upgrade that needs approval,
   the step lists what is new and offers **Approve**.
2. **Connect.** One row per connection with its state, the manifest's help text
   and a **How to get it** link. An OAuth connection has **Connect**,
   **Reconnect** and **Disconnect**, the same controls as an OAuth server in
   Skills & MCP servers; sign-in opens in a new tab and the page refreshes when
   you come back. A `token` or `signing_secret` connection has a write-only
   field: once saved, the page only says who stored it and when, and offers
   **Replace** and **Clear**. A required connection cannot be cleared while
   the plugin is enabled.
3. **Configure.** **Limit to repositories** picks the repositories the plugin
   applies in; leave every box unchecked for all repositories. The form for
   the plugin's own settings is added by a later release.
4. **Enable.** A single **Enabled** checkbox. While a required connection,
   required setting or secret acknowledgement is missing it cannot be ticked,
   and the step lists what is missing, for example "Connection Example API
   token (example-token) is not set". Untick it to disable the plugin; its
   settings and connections are kept.

Below the steps, **What it added** lists the plugin's managed MCP servers and
skills, with a link to Skills & MCP servers where they are listed, and its
automation templates, each with whether it applies now.

**Uninstall** is a separate action. Its confirmation lists what is removed:
the settings and repository limit, each connection and stored credential, the
managed library items and the templates. The audit trail is kept. When an
automation still adds one of the plugin's managed items, the API refuses the
uninstall and the page shows its message, which names the automation; remove
the item from that automation and try again.

## Installing a plugin

A plugin is **available** when it is in this ProPR's registry, **installed**
once an administrator installed it on the instance, and then **enabled** or
disabled. Disabling keeps its settings and connections; uninstalling deletes
them. What an enabled plugin adds to runs is described in
[What an enabled plugin adds](#what-an-enabled-plugin-adds).

Only durable instance administrators with `instance.manage_settings` can read
or change plugin state, and every change (install, settings, repository limit,
connection set or cleared, OAuth client configured or cleared, enable,
disable, approve, uninstall) is recorded in
the plugin audit trail with who and when. The audit trail stays after an
uninstall. Changes need `Content-Type: application/json` and the header
`X-ProPR-Plugins: 1`.

| Step | Request |
| --- | --- |
| List plugins and their state | `GET /api/instance/plugins/v1` |
| Read one plugin | `GET /api/instance/plugins/v1/<id>`: the manifest, settings, repository limit, connection states, permissions and acknowledgements awaiting approval, why enabling is refused, and the newest 50 audit events. |
| Install | `POST /api/instance/plugins/v1/<id>/install` with `{ "acknowledgements": ["<package server>", …] }` |
| Change settings | `PUT /api/instance/plugins/v1/<id>/settings` with `{ "settings": { … } }`, the complete settings object |
| Limit to repositories | `PUT /api/instance/plugins/v1/<id>/repositories` with `{ "repositories": ["owner/repo"] }`; `null` or `[]` for all repositories |
| Set or clear a connection | `PUT /api/instance/plugins/v1/<id>/connections/<name>` with `{ "value": "…" }` or `{ "value": null }` |
| Enable or disable | `PUT /api/instance/plugins/v1/<id>/enabled` with `{ "enabled": true }` |
| Approve after an upgrade | `POST /api/instance/plugins/v1/<id>/approve` with `{ "acknowledgements": [ … ] }` when needed |
| Uninstall | `POST /api/instance/plugins/v1/<id>/uninstall` with `{ "confirm": "<id>" }` |
| Configure a pre-registered OAuth client | `PUT /api/instance/plugins/v1/<id>/connections/<name>/oauth/client` with `{ "client": { "clientId": "…", "clientSecret": "…" } }` (`clientSecret` optional) or `{ "client": null }` |
| Start an OAuth sign-in | `POST /api/instance/plugins/v1/<id>/connections/<name>/oauth/start` with `{}`: returns `authorizationUrl` |
| Complete it | `POST /api/instance/plugins/v1/<id>/connections/<name>/oauth/complete` with the `state` and `code` the provider returned (the extension OAuth callback completes it too) |
| Disconnect it | `POST /api/instance/plugins/v1/<id>/connections/<name>/oauth/disconnect` with `{}` |

The [API reference](../operations/api-reference.md) has the request and response schemas. MCP
clients can read the same state with the read-only `list_plugins` and
`get_plugin` tools.

### Install flow

1. Installing records the manifest version, the manifest's permissions as the
   granted set, the settings defaults, who installed it and when. The plugin
   starts disabled and applies to all repositories.
2. If the plugin contributes a [local package server](#local-package-servers)
   with `secretEnv`, installing needs the same acknowledgement the extension
   library asks for: the secret is readable by the agent CLI, its shell tools
   and repository setup scripts inside the task container. Name each such
   server in `acknowledgements`; the acknowledgement is recorded on the
   installation with who and when.
3. Settings are validated against the manifest's settings schema on save:
   unknown keys, wrong types, values outside `enum`, `minimum`/`maximum`,
   `maxLength` or `maxItems`, and malformed repository maps are refused.
4. Set the connections the plugin needs, then enable it.

Enabling is refused with HTTP 409 and the reasons (also listed as
`enableBlockers` when the plugin is read) while:

- a `required` setting has no value,
- a required `token` connection is not set (a `token` connection is required
  when a contributed MCP server uses it, as a `bearer` server's connection or a
  package server's secret variable), or
- a package server's secret acknowledgement is missing.

While a plugin is enabled, its required settings and required connections
cannot be removed; disable it first.

### Connections

`token` and `signing_secret` connections are write-only secrets. They are
sealed with the same private-secret mechanism as the extension library's
credentials, bound to the instance, plugin and connection, and never returned
by the API, MCP tools or logs; a read reports only `connected` or
`not_connected`, who set it and when. Native database exports erase them, so a
restored instance has its plugins installed with the same settings but every
connection not connected.

An `oauth` connection is signed in through the
[extension OAuth sign-in](./agent-extensions.md#oauth-servers): start it, open
the returned `authorizationUrl` in the same browser session, and sign in at the
provider. ProPR identifies itself as it does for library servers (Client ID
Metadata Document, then dynamic registration), but only through the methods the
connection's `registrations` permit, in that order; when the provider supports
none of them, the sign-in is refused with HTTP 409. When `registrations`
permits `preregistered`, an administrator can configure the client registered
with the provider for this instance on the connection (`oauth/client`): the
client id becomes the managed servers' client id and the optional client
secret is sealed like a `token` connection and never returned; a read reports
who configured it in `setBy` and `setAt`. While a client is configured, sign-in
always uses it, wherever `preregistered` appears in `registrations`. Changing or clearing the client,
including replacing only its secret, discards the connection made with the
previous one and any sign-in still in progress. A connection that does not
permit `preregistered` refuses a client with HTTP 409. The managed server carries
the permitted methods in its `managedBy.registrations`, so a sign-in started
from the extension library is limited the same way. The provider redirects to
the extension OAuth callback, which completes the sign-in. The connection
belongs to the plugin's managed server that uses it, so it needs a public HTTPS
base URL for the instance and is available once the plugin is installed. A read
reports `connected` once every managed server using the connection is signed
in, `needs_sign_in` after a failed token refresh, and otherwise
`not_connected`. Disconnecting revokes the tokens where the provider supports it
and deletes them. Tokens are never returned.

### Permissions and upgrades

The granted permissions are a set recorded at install. When a ProPR upgrade
ships a newer manifest that asks for a permission that was not granted, the
plugin keeps running with its old grant and is flagged **Needs approval**
(`needsApproval`, with the new permissions in `pendingPermissions`) until an
administrator approves the new set. Approving grants the current manifest's
permissions and records its version as the installed version.

A package server's acknowledgement is tied to its package, version and secret
variable names. When an upgrade changes any of them, the plugin also needs
approval (`pendingAcknowledgements`): it cannot be enabled until the approval
names that server in `acknowledgements` again.

An upgrade that changes neither permissions nor acknowledged packages needs no
approval; the installed version follows the new manifest on the next change.
A plugin that an upgrade removed from the registry stays listed as installed
but unavailable; it can only be disabled or uninstalled.

## What an enabled plugin adds

### Managed library items

A plugin's MCP servers and skills become **managed items** of the
[extension library](./agent-extensions.md#managed-items), tagged with the plugin
id (`managedBy`). They are created when the plugin is installed, inactive, so
that its OAuth connection can be signed in before enabling, and they apply to
runs only while the plugin is enabled. Runs resolve them like every other
library item: the same limits, opt-out labels, run limits, write authorization
and launch checks.

- **Definition:** read-only; it comes from the manifest. The administrator can
  still use the item's enabled checkbox, its repository and agent limits, and
  its automatic-apply switch. Every other change through the library API,
  removing the item and replacing its credential are refused.
- **Defaults:** automatic apply on, enabled, limited to the plugin's repository
  limit (all repositories when it has none). Changing the plugin's repository
  limit sets the managed items' repository limit to it again.
- **Names:** a managed server keeps its manifest name unless the library
  already has a server of that name; it is then named `<plugin id>-<name>`.
- **Disabling** the plugin deactivates its managed items: they stay in the
  library as they are, with their settings and connections, and apply to no
  run. A disable never applies an upgraded manifest, reads skill folders or
  decrypts credentials (the library's sealed credentials carry over unchanged),
  so it succeeds even when the next plugin change would be refused, including
  after a restore under another encryption root. Re-enabling
  restores them, applying any upgrade.
- **Uninstalling** removes the managed items and their OAuth connections. It is
  refused, naming the automations, while an automation adds one of them
  explicitly; remove it from those automations first. An upgrade that drops an
  item, or changes the files of a skill an automation adds by its bundle id, is
  refused the same way when the plugin is next changed (other than disabling
  it).
- The plugin read (`GET /api/instance/plugins/v1/<id>`) lists its contributions
  in `contributions`, each with the library item it became (`managed`, with its
  library name or bundle id, its own enabled switch and whether the plugin keeps
  it `active`).

### Remote servers

A managed remote server's credential is the plugin connection it names. A
`bearer` server sends the `token` connection; an `oauth` server is left out of
runs, with the reason `oauth_not_connected`, until its `oauth` connection is
connected, exactly like any other OAuth library server, and disconnecting
removes it from later runs.

### Local servers contributed by plugins

A managed package server is installed and launched through the extension
library's [local package server](./agent-extensions.md#local-package-servers)
path, with nothing relaxed:

- the pinned version and the integrity value recorded in the manifest (ProPR
  does not ask the registry for another one);
- installed once per integrity value without lifecycle scripts, verified
  again at launch, mounted read-only and run through the stdio bridge in the
  task container;
- a write-capability server needs explicit write authorization for the run.

Its `secretEnv` values come from the plugin's `token` connections. When a
value is missing, the server is skipped for that run with the reason
`secret_not_configured` and the run proceeds. The acknowledgement recorded at
install (or the latest approval) satisfies the library's acknowledgement
requirement; while an upgrade waits for a new acknowledgement the server is
inactive and is never installed or launched.

### Skills and automation templates

A plugin skill becomes a skill bundle whose source is the plugin, its version
and the folder. When an upgrade changes the skill's files, the next plugin
change stores a new bundle for it and keeps the item's settings. Automations
add skills by bundle id, so that change is refused while an automation adds the
old bundle explicitly; remove the skill from the automation, apply the change,
then add the new bundle.

An enabled plugin's automation templates appear in the template catalog
(`GET /api/automation-definitions/templates` and the `list_automation_templates`
MCP tool) after the shipped templates, with `plugin` naming the plugin's id and
name. A template keeps its id unless a shipped template or another plugin uses
it; it is then `<plugin id>-<id>` (`catalogId` in the plugin read). When that
id is itself another template's id or was already given to another template,
it gets a `-2`, `-3`, … suffix, so catalog ids are always unique. Ids depend
only on the registry, not on which plugins are enabled. Disabling or
uninstalling the plugin hides its templates; automations created from them are
ordinary automations and are not changed.
