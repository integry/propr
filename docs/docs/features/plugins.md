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

:::tip Writing a plugin
The [official plugin catalog](../plugins/catalog.md) lists the plugins that
ship with ProPR. To add one, start with `npm run plugins:new -- <id>` and
[Writing an official plugin](../plugins/authoring.md), which has the generated
manifest reference, the event payloads, the SDK surface and the compatibility
rules.
:::

:::note Work in progress
This page describes the plugin **manifest**, the official plugin registry, the
[Plugins page](#the-plugins-page), the installation API and the
[handler interface](#handlers), [event subscriptions](#event-subscriptions),
[inbound webhooks](#inbound-webhooks) and [commands](#commands).
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

Code several plugins share (for example the event selection of the plugins
that forward ProPR events) lives in `packages/plugins/_shared/`. It is not a
plugin, and it uses SDK types only.

`packages/plugins/registry.json` lists the plugins in catalog order. The
`@propr/plugins` workspace package exports that list with each manifest and the
resolved paths of its assets.

Development plugins are marked `"development": true` in `registry.json` and are
left out of the list unless `PROPR_PLUGINS_DEVELOPMENT=1` is set. The
`example-pack` plugin is one: it contributes one remote MCP server, one local
package server, one skill and one automation template, and is used by ProPR's
own tests and as a reference for plugin authors.

### Official plugins

| Plugin | What it does |
| --- | --- |
| [Outbound webhooks](../plugins/webhooks.md) (`webhooks`) | Sends ProPR events as signed JSON to any HTTPS endpoint, with a documented, versioned envelope. |
| [Slack](../plugins/slack.md) (`slack`) | Posts short notifications to Slack channels through incoming webhooks, or with your own Slack app in one thread per pull request; in app mode, mentioning the bot creates an issue that starts a task. |
| [Discord](../plugins/discord.md) (`discord`) | Posts short notifications to Discord channels as embeds through channel webhooks. |
| [Microsoft Teams](../plugins/teams.md) (`teams`) | Posts short notifications to Teams channels or chats as Adaptive Cards through a Workflows webhook. |
| [Linear](../plugins/linear.md) (`linear`) | Adding a label to a Linear ticket creates a GitHub issue that starts a task; ProPR then comments on the ticket and moves it through its workflow as the work progresses. |
| [Jira Cloud](../plugins/jira.md) (`jira`) | The same hand-off for Jira Cloud: a label on a ticket of a mapped project creates a GitHub issue that starts a task; ProPR comments on the ticket and transitions it as the work progresses. |
| [Sentry](../plugins/sentry.md) (`sentry`) | An error reported by Sentry for a mapped project creates one GitHub issue with the stack trace attached. Starting a task is off by default, and limited by event count, environment and a daily cap when switched on. ProPR comments on the Sentry issue when the pull request merges. |
| [Notion](../plugins/notion.md) (`notion`) | Lets the agent read the Notion pages an issue or pull request links to, such as specifications, through Notion's hosted MCP server with read and search tools only. No handlers or commands: a manifest and a skill. |

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
| `outboundHostsFromSettings` | Keys of URL settings (`format: "https-url"`) whose host the handlers may also call, for endpoints an administrator enters. See [Outbound HTTP and secrets](#outbound-http-and-secrets). |
| `contributes` | What the plugin adds to ProPR (below). |

Unknown fields are refused everywhere, so a misspelled field is an error rather
than silently ignored.

### Permissions

`events.read`, `tasks.read`, `tasks.create`, `issues.read`, `issues.create`,
`issues.comment`, `pull_requests.read`, `pull_requests.comment`,
`labels.write`, `repositories.read` and `notifications.send`. A command can only
use permissions the plugin requests, and event subscriptions need `events.read`.
[Handlers](#what-ctxpropr-can-do) show which `ctx.propr` operation needs which
permission.

### Connections

Each connection has a `name`, a `type`, a `label`, `help` text and a `helpUrl`
pointing to where the credential is obtained.

| Type | What the administrator provides |
| --- | --- |
| `oauth` | A sign-in, using the same flow as [OAuth library servers](./agent-extensions.md#oauth-servers). `registrations` limits the client registration methods (`metadata_document`, `dynamic`, `preregistered`; all three by default) and `scopes` lists the scopes to request. |
| `token` | A secret pasted by the administrator, such as an API token. With `secretUrl`, the secret is a URL instead (see [Webhook URL connections](#webhook-url-connections)). `ctx.http` sends it as `Authorization: Bearer <token>`; with `"authorization": "raw"` it sends `Authorization: <token>`, for services whose API keys take no scheme, such as Linear's; with `"authorization": "basic"` the administrator enters `<user>:<secret>` (a value without that shape is refused) and it sends `Authorization: Basic <base64>`, for services that take an account and an API token as HTTP Basic credentials, such as Jira Cloud. An MCP server using the connection always gets it as Bearer. |
| `signing_secret` | A shared secret: it verifies inbound webhooks, and `ctx.http` signs outbound requests with it. |

#### Webhook URL connections

A chat service's incoming webhook URL is itself the credential: anyone who has
it can post to the channel. A `token` connection with `secretUrl` stores such a
URL. ProPR seals it like any other secret and never shows it again:

```json
{
  "type": "token", "name": "default-webhook", "label": "Default webhook URL",
  "help": "Paste a Slack incoming webhook URL.", "helpUrl": "https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks",
  "secretUrl": { "hosts": ["hooks.slack.com"], "pathPrefixes": ["/services/"] }
}
```

When the URL is saved, it must be an `https://` URL on one of `hosts`, under one
of `pathPrefixes` when they are given. A host may be `*.` and a name, which
matches any name ending in `.<name>`, such as `*.logic.azure.com`. The refusal
names the host but never repeats the URL. Such a connection cannot authenticate
an MCP server or a package server's variable.

A handler sends to the stored URL with
`ctx.http('default-webhook')(PLUGIN_CONNECTION_URL, { method: 'POST', json })`.
Any other URL is refused, no `Authorization` header is added, and the URL (and
its path and query, together or apart, and each token or signature in them) is
redacted from the response, logs and errors. The host
does not need to be in `outboundHosts`. The stored URL is checked against
`hosts` and `pathPrefixes` again on every request, and its addresses must be
public, as for any other host.

### Settings

`settings` is an object schema: `{ "type": "object", "properties": { ... }, "required": [ ... ] }`.
Every property has a `label`, optional `help` and an optional `default`, and is
one of:

| Shape | Meaning |
| --- | --- |
| `{ "type": "string" }` | Text, with optional `maxLength`. With `enum`, one of a fixed list of values. With `"format": "https-url"`, an `https://` URL on a public host (see below), and with `hosts` (such as `["*.atlassian.net"]`) only on those hosts. |
| `{ "type": "number" }` | A number, with optional `minimum`, `maximum` and `integer`. |
| `{ "type": "boolean" }` | A switch. |
| `{ "type": "array", "items": { "type": "string" } }` | A list of strings, with optional `maxItems`. With `"items": { "type": "string", "enum": [ ... ] }`, a multiple choice: every entry is one of the listed values, shown as checkboxes. |
| `{ "type": "object", "format": "repository-map", "additionalProperties": { "type": "string" } }` | A value per repository, keyed by `owner/repo`. |

Defaults must satisfy their own constraints, and every `required` key must be
defined.

#### Choices loaded from the service

A `string` setting, or a repository map's values, can offer choices the plugin
loads from its service, such as a tracker's teams or workflow states. Name an
exported handler in `optionsFrom` (it cannot be combined with `enum` or
`format`):

```json
"openedState": { "type": "string", "label": "Move the ticket to", "optionsFrom": "stateOptions" }
```

The handler receives `{ kind: 'setting_options', setting }` and returns
`{ options: [{ value, label }] }` (at most 250, each value once, values up to
500 and labels up to 200 characters; a result within these limits is never too
large). It runs when
the Plugins page shows the form, through
`GET /api/instance/plugins/v1/<id>/settings/<key>/options`, which only an
administrator may call. It runs whether the plugin is enabled or not, with
`ctx.http` and `ctx.state` but no `ctx.propr` permission. If it fails, for
example because the API key is not set yet, the form shows its message next to
the field and keeps a text box. Saved values are plain strings, validated like
any other.

An `https-url` value must be `https://`, on the default port, without a user
name, password or `#fragment`, and name a host: never an IP address, and not a
local name such as `localhost`, `*.local` or `*.internal`. A plain HTTP or
private-address URL is therefore refused when the settings are saved. When a
plugin names the setting in `outboundHostsFromSettings`, its host must also
resolve to public addresses only when a new or changed value is saved.

A URL setting may list `hosts`: host names, or `*.` and a domain for any name
under it (`*.atlassian.net` takes `acme.atlassian.net`, not `atlassian.net` or
`atlassian.net.example.com`). A URL on another host is refused when the
settings are saved, with a message such as `siteUrl must be on *.atlassian.net,
not jira.example.com`, and gives the handlers no outbound host even if it was
saved before the list was declared.

### Contributions

| Field | Contents |
| --- | --- |
| `mcpServers` | MCP servers, in the [extension library](./agent-extensions.md)'s item shapes (below). |
| `skills` | `{ "name", "path" }`: a skill bundle folder inside the plugin folder. Its `SKILL.md` front matter must use the same `name`. |
| `automationTemplates` | `{ "id", "path" }`: a template folder in the automation template format. It must pass the same checks as the shipped templates. |
| `commands` | `{ "name", "description", "where", "kind", "prompt"?, "handler"?, "skills"?, "servers"?, "needsWrite"?, "shared"?, "specific"? }`: a slash command for issue and pull request comments. See [Commands](#commands). |
| `subscriptions` | `{ "on", "handler", "filter"? }`: deliver a repository event (`<domain>.<type>`, such as `pull_request.merged`) to an exported handler. See [Event subscriptions](#event-subscriptions). Needs the `events.read` permission. |
| `webhooks` | `{ "name", "description", "handler", "verification", "deliveryIdHeader"?, "respond"? }`: an inbound webhook URL whose verified requests run `handler`. `verification` is a built-in scheme with a `signing_secret` connection. See [Inbound webhooks](#inbound-webhooks). |

Names are unique within each list, and command names are unique across all
plugins, except a name every plugin offering it marks `shared`.

#### Commands

```json
{
  "name": "example-notes",
  "description": "Write release notes for the work so far",
  "where": ["pull_request", "issue"],
  "kind": "prompt",
  "prompt": "Write short release notes for the changes in this repository's current work and add them to NOTES.md.",
  "skills": ["example-notes"],
  "servers": ["example-remote"]
}
```

A command is used as `/<name>` on the first line of a comment, on pull requests,
issues or both (`where`). The name is lower-case letters, digits and `-`,
starting with a letter, and can never be a built-in ProPR command (`review`,
`fix`, `merge`, `switch`, `use`, `ultrafix`); the built-in list is shared with
the comment parser, so the manifest check and enabling both refuse a name that
shadows one.

A `prompt` command queues an ordinary one-shot task: a follow-up on a pull
request, an implementation task on an issue. Its instruction is `prompt`. The
rest of the comment's command line is appended as the person's argument,
delimited and marked as untrusted text, so it can never become part of the
instruction. `skills` and `servers` name this plugin's own skill and server
contributions to add to that run explicitly; they must be contributed by the
same manifest, and a server with `capability: "write"` needs `needsWrite`.

A command with `needsWrite: true` runs only when an administrator switched on
**Allow this command to use write access** for it on the Plugins page (off at
install) and the commenter has write permission on the repository; otherwise
it is refused with a reply that says what is missing. When it runs, ProPR
records an explicit write authorization for that one run, through the
extension library's write-authorization path: the run may use the plugin's
write servers that the command names, and no other write server. The
authorization is single use, so a retry of the run and later follow-ups get
read servers only.

```json
{
  "name": "example-status",
  "description": "Log who asked for the status, and where",
  "where": ["pull_request", "issue"],
  "kind": "handler",
  "handler": "reportCommand"
}
```

A `handler` command names an exported function of the plugin's `handlers.ts`
instead of a prompt, and adds no skills or servers. It starts no task: the
handler receives the comment context as a delivery of kind `command` (see
[Command deliveries](#command-deliveries)).

```json
{ "name": "deploy", "description": "Deploy this branch", "where": ["pull_request"], "kind": "handler", "handler": "deploy", "shared": true, "specific": ["vercel-deploy"] },
{ "name": "vercel-deploy", "description": "Deploy this branch to Vercel", "where": ["pull_request"], "kind": "handler", "handler": "deploy" }
```

A `shared` command is a name several plugins may offer, such as `/deploy`
offered by several deployment plugins. Each plugin that marks a command shared
must also name, in `specific`, its own commands that perform the same
operation under a name of their own: each one not shared, of the same kind,
usable wherever the shared one is and, for a handler command, calling the same
handler. Another command of the plugin is never taken as an alternative unless
the shared command names it (`npm run plugins:check` and the manifest schema
refuse a shared command without a valid specific command). When more than one
enabled plugin offers the shared name for a repository, the plain name runs
the plugin chosen in the instance setting on the Plugins page; without a
choice, the only enabled one runs it, and with several the command replies
naming their specific commands.

Commands apply only while the plugin is enabled and inside its repository limit,
and follow the same author rules as the built-in commands. Enabling a plugin is
refused while another enabled plugin contributes a command of the same name
that is not shared by both; the refusal names that plugin, and the Enable step
shows it beforehand. See
[Plugin Commands](./pr-commands.md#plugin-commands) for how they behave in a
comment.

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
that ids match their folders, that command names are unique across plugins and
never shadow a built-in command, and that the
README, icon, skill folders and automation templates exist and are valid. CI
runs it on every pull request.

```bash
npm run plugins:check -- --online [--registry https://registry.npmjs.org]
```

also asks the npm registry for each package server's version and compares the
recorded `integrity` value. It needs network access and is not run in CI.

```bash
npm run plugins:docs:check
```

fails when the generated plugin docs are out of date: the manifest reference,
event payload table and SDK surface in [Writing an official plugin](../plugins/authoring.md),
the [catalog](../plugins/catalog.md), the published manifest JSON Schema and
the sidebar's plugin pages. CI runs it on every pull request;
`npm run plugins:docs` regenerates them. The plugin interface's
[compatibility rules](../plugins/authoring.md#compatibility-rules) are enforced
by the contract test in `packages/shared/test/pluginContract.test.ts`.

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
   the task container" or "Adds the /example-notes command", and lists the
   permissions it asks for, each with a one-line explanation. When a local
   package server receives secret variables, the step shows the package, its
   exact version and the variable names, with a required checkbox confirming
   that those secrets are readable inside the task container. **Install**
   stays unavailable until it is ticked. After an upgrade that needs approval,
   the step shows what changed (see [Needs approval](#needs-approval)) and
   offers **Approve**.
2. **Connect.** One row per connection with its state, the manifest's help text
   and a **How to get it** link. An OAuth connection has **Connect**,
   **Reconnect** and **Disconnect**, the same controls as an OAuth server in
   Skills & MCP servers; sign-in opens in a new tab and the page refreshes when
   you come back. A `token` or `signing_secret` connection has a write-only
   field: once saved, the page only says who stored it and when, and offers
   **Replace** and **Clear**. A required connection cannot be cleared while
   the plugin is enabled.
3. **Configure.** A settings form ProPR generates from the manifest's
   [settings schema](#settings), then **Limit to repositories**, which picks
   the repositories the plugin applies in (leave every box unchecked for all
   repositories). The step is done once every required setting has a value.
   See [Settings form](#settings-form).
4. **Enable.** A single **Enabled** checkbox. While a required connection,
   required setting or secret acknowledgement is missing it cannot be ticked,
   and the step lists what is missing, for example "Connection Example API
   token (example-token) is not set". Untick it to disable the plugin; its
   settings and connections are kept.

Below the steps, **What it added** lists the plugin's managed MCP servers and
skills, with a link to Skills & MCP servers where they are listed, its
commands (for example "Command /example-notes · Write release notes for the
work so far · in pull request and issue comments · Active") and its automation
templates, each with whether it applies now. **Activity** follows
once the plugin is installed: each event delivered to the plugin's handlers and
its result, with **Retry** on a failed delivery (see [Activity](#activity)). A
plugin whose deliveries keep failing shows **Degraded** next to its state, and
**Paused** with **Resume deliveries** once deliveries stopped (see
[Health, Degraded and Resume](#health-degraded-and-resume)).

**Uninstall** is a separate action. Its confirmation lists what is removed:
the settings and repository limit, each connection and stored credential, the
managed library items and the templates. The audit trail is kept. When an
automation still adds one of the plugin's managed items, the API refuses the
uninstall and the page shows its message, which names the automation; remove
the item from that automation and try again.

### Settings form

Each setting becomes one field, labelled with its `label` and described by its
`help`:

| Setting | Field |
| --- | --- |
| `string` | A text box (limited to `maxLength`). |
| `string` with `enum` | A list to pick one value from, or **Not set**. |
| `number` | A number box, with the range and whether it must be a whole number shown under it. |
| `boolean` | A list with **Not set**, **Yes** and **No**, so an explicit **No** (`false`) is saved and kept apart from an unset setting. |
| `array` of `string` | One box per entry, with **Add entry** and **Remove**. Each entry is saved exactly as typed, including spaces, empty entries and line breaks. |
| `object` with `format: repository-map` | One row per repository: the repository (`owner/name`, with this instance's repositories suggested) and its value, with **Add repository** and **Remove**. |
| `string` or repository map with `optionsFrom` | The choices the plugin loads from its service, in a list with **Not set** (for a map, one list per repository), and **Reload choices**. A saved value the service no longer offers stays listed as "not offered by the service". If the choices cannot be loaded, the plugin's message is shown (for example "Linear is not connected yet…") and the field is a text box. |

The form starts from the saved settings; a fresh installation starts from the
manifest's defaults. **Save settings** sends every setting at once
(`PUT /api/instance/plugins/v1/<id>/settings`). A field you did not change
sends its saved value unchanged. An emptied text or number field removes that
setting, and so does choosing **Not set** for a true/false setting. A list or map whose last entry is removed is saved as empty;
**Clear** removes the setting. The page checks the values with the same rules as the
API before sending them, and when the API refuses a value its message (for
example "maxItems must be at most 50") is shown under that field. A required
setting is marked **Required to enable**: it may stay empty while the plugin is
disabled, but **Enable** then lists it as missing (for example "Required setting
Verbosity (verbosity) is missing"), and while the plugin is enabled it cannot
be emptied.

### Needs approval

When a newer manifest asks for more than was approved, the plugin is badged
**Needs approval** and keeps running with what it was granted. The Install step
then shows:

- **New permissions it asks for**, each with its explanation.
- **Changed package servers**: for each package server with secret variables
  whose package, exact version or secret variables changed since they were
  acknowledged, what changed, for example "Version changes from 1.0.0 to 1.1.0"
  or "Secret variables added: FIXTURE_REGION", or that the server is new.
- The secret-variable acknowledgement for each of those servers, naming the
  package, exact version and variables.

**Approve** stays unavailable until every acknowledgement is ticked. Approving
records the new permissions and acknowledgements and clears the badge.

### Managed items in Skills & MCP servers

In **Settings → Agent Extensions & Packages → Skills & MCP servers**, each
server or skill a plugin contributes carries a **From plugin:** *plugin name* badge
that opens the plugin's page. It has no **Remove** (uninstall the plugin
instead), and **Edit limits** opens a form that shows its definition read-only:
for a remote server the endpoint, authentication and tools; for a package
server also the registry, package, exact version, command, arguments, variables
and secret variable names. Only the enabled checkbox, the repository and agent
limits and **Apply automatically** can be changed.

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

### Commands

An enabled plugin's commands work in the comments of the repositories inside
its repository limit; the plugin page lists each under **What it added** with
its description, where it can be used (pull request comments, issue comments
or both), whether it calls a handler and whether it is active. A command of a
disabled or uninstalled plugin is an unknown command again. See
[Plugin Commands](./pr-commands.md#plugin-commands).

Once the plugin is installed, the **Commands** section of its page holds the
instance settings of its commands, editable by administrators only (like the
whole page) and recorded in the plugin's audit trail:

- **Allow this command to use write access**, for each command with
  `needsWrite`: off until switched on (audit action `set_command_write`). The
  Install step already says which commands can use write access and that they
  stay off until allowed.
- **Plugin that /&lt;name&gt; runs when several plugins offer it**, for each
  `shared` command: one of the installed plugins that offer the name, or none
  (audit action `set_shared_command_owner`, recorded on this plugin and on the
  previous and new owners). The setting belongs to the instance, so every
  plugin offering the name shows the same choice.

The routes are `PUT /api/instance/plugins/v1/<id>/commands/<name>/write` with
`{ "allowed": true | false }` and
`PUT /api/instance/plugins/v1/<id>/commands/<name>/owner` with
`{ "owner": "<plugin id>" | null }`. The plugin read lists the settings in
`commands`. Uninstalling deletes the plugin's command settings and clears the
shared names it owned.

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

## Handlers

A plugin folder may contain a `handlers.ts` that exports named async functions.
Each handler receives `(input, ctx)` and returns nothing or a small JSON result
(at most 16 KiB; an `optionsFrom` handler's choices may be larger, up to the
options limits). `ctx` is the only way a handler touches anything. Handlers of
official plugins run in-process, but only through this interface, so the same
plugin could later run out of process. How ProPR runs them is described in
[Plugin runtime](../architecture/plugin-runtime.md).

```ts
// packages/plugins/my-plugin/handlers.ts
import { definePluginHandler, type PluginEventInput } from '@propr/shared';

export const onTaskEvent = definePluginHandler<PluginEventInput>(async (input, ctx) => {
  const { event } = input;
  const thread = await ctx.state.get<string>(`thread:${event.entityId}`);
  const response = await ctx.http('chat-token')('https://api.chat.example/messages', {
    method: 'POST', json: { thread, text: `Task ${event.entityId} is ${event.type}` },
  });
  if (!response.ok) ctx.log.warn('chat refused the message', { status: response.status });
});
```

| `ctx` member | What it is |
| --- | --- |
| `ctx.settings` | The installation's settings, validated against the manifest, with its defaults. Read-only. |
| `ctx.repositories` | The repository limit (`owner/repo` list), or `null` for all repositories. |
| `ctx.propr` | ProPR, limited to the granted permissions and the repository limit (below). |
| `ctx.http(connection?)` | `fetch`-like outbound HTTPS to the manifest's `outboundHosts` (and the hosts of its `outboundHostsFromSettings` URLs) only. With a `token` connection name, its credential is injected. With a `signing_secret` connection name, ProPR signs each request. |
| `ctx.state` | A small JSON key-value store for this installation: `get`, `set`, `delete`, `keys(prefix?)`, and `update(key, change)`, an atomic read-and-replace. |
| `ctx.log` | `debug`, `info`, `warn`, `error(message, fields?)`: structured lines returned with the run, redacted. |
| `ctx.signal` | Aborted when the handler runs past its 30 second limit. |

The input is one of the envelopes in `@propr/shared`: `{ kind: 'event', event }`
(a [repository journal event](../architecture/repository-event-journal.md)),
`{ kind: 'webhook', webhook, headers, body, receivedAt }`,
`{ kind: 'command', command, args, repository, number, target, actor, commentId }` or
`{ kind: 'invoke', payload }`. Events are delivered by
[event subscriptions](#event-subscriptions), with a stable `deliveryId`, the
`attempt` number and, on the attempt of a manual **Retry**, `manual: true`. Webhook requests are delivered by
[inbound webhooks](#inbound-webhooks), also with a `deliveryId` and `attempt`.
`handler` commands are delivered as [command deliveries](#command-deliveries);
`prompt` commands need no handler (see [Commands](#commands)).

A call `ctx` refuses throws a `PluginSdkError` with a `code` such as
`permission_denied`, `repository_not_allowed`, `host_not_allowed`,
`insecure_url`, `private_address`, `connection_unavailable` or `state_limit`.

### What `ctx.propr` can do

| Operation | Permission |
| --- | --- |
| `getPullRequest(repository, number)` | `pull_requests.read` |
| `getIssue(repository, number)` | `issues.read` |
| `getTask(taskId)` | `tasks.read` |
| `listEvents({ repository, afterSeq?, domains?, limit? })` | `events.read` |
| `createIssue(repository, { title, body?, labels? })` | `issues.create` |
| `createTask(repository, issueNumber)`: an ordinary one-shot task | `tasks.create` |
| `commentOnPullRequest(repository, number, body)` | `pull_requests.comment` |
| `commentOnIssue(repository, number, body)` | `issues.comment` |
| `addLabel(repository, number, label)`, `removeLabel(…)` | `labels.write` |

A permission counts only when the administrator granted it and the current
manifest still asks for it. Each call must also stay inside the plugin's
repository limit. These are checked again, as an administrator last set them,
right before each call is dispatched: a handler that is still running when its
plugin is disabled, restricted to other repositories or uninstalled cannot act
under the authority it started with.

Every call, allowed or refused, is recorded in the plugin's audit trail. The
actor is `plugin:<id>` and the action is `handler_call` or `handler_refused`.
A call that changes something (an issue, comment, label or task) is also
recorded as `handler_attempt` before it is sent. If that record cannot be
written, the call is refused and nothing is sent.
Issues and comments a plugin writes end with `<!-- propr-plugin:<id> -->`. A
task it creates records `requestedBy: plugin:<id>` in its first task event.

Handlers observe and create new work: they never interact with a running task.

### Outbound HTTP and secrets

`ctx.http` reaches only the hostnames in `outboundHosts`, and the hosts of the
URL settings named in `outboundHostsFromSettings` as they are saved, over HTTPS,
on the default port, and only when every address the name resolves to is
public. A host that is not one of them is refused (`host_not_allowed`), even
when it is the host of another setting.
Private, loopback and link-local addresses and local names are refused, and
redirects are not followed. Requests are limited to 256 KiB and 10 seconds, and
responses to 1 MiB.

Handlers never receive raw secrets. `ctx.http('my-token')` opens the stored
`token` connection only to send the request, as `Authorization: Bearer …` (or
the bare token with `"authorization": "raw"`, or HTTP Basic credentials with
`"authorization": "basic"`), and
removes the credential from the response before the handler reads it. Log lines,
error messages and results pass the secret redaction.

`ctx.http('my-webhook-url')` with a [webhook URL connection](#webhook-url-connections)
sends to the stored URL: pass `PLUGIN_CONNECTION_URL` from `@propr/shared` as the
URL. The handler never learns the URL.

`ctx.http('my-signing-secret')` uses a `signing_secret` connection to sign
instead. Every request needs a `signature`, and ProPR sets its header:

```ts
await ctx.http('target-secret')(url, {
  method: 'POST', body, headers: { 'x-timestamp': String(Math.floor(Date.now() / 1000)) },
  // x-signature: sha256=<hex HMAC-SHA256 of "<x-timestamp>.<body>">
  signature: { header: 'x-signature', prefix: 'sha256=', timestampHeader: 'x-timestamp' },
});
```

The signature is the lower-case hex HMAC-SHA256, keyed with the secret, of the
body bytes as sent, preceded by the timestamp header's value and `.` when
`timestampHeader` is given.

### State

`ctx.state` holds up to 256 keys and 256 KiB per installation, each value at
most 16 KiB of JSON. It is meant for cursors and mappings, for example "this
pull request maps to that chat thread". Handlers can run at the same time, in
several ProPR processes: a `get` followed by a `set` can overwrite what another
handler wrote in between. `update(key, current => next)` reads and replaces a
key atomically; `change` must not await, and returns `undefined` to leave the
value unchanged. It is kept when the plugin is disabled
and deleted when it is uninstalled.

### Imports

Handler code may import `@propr/shared` (the SDK types live there), Node
built-ins and files of its own package, but nothing else from ProPR. A lint rule
for `packages/plugins/**` enforces this. Run it with
`npm run lint -w @propr/plugins`.

### Testing handlers

`packages/plugins/testing` provides `createTestPluginContext()`: a fake `ctx`
with recorded `ctx.propr` calls, scripted `ctx.http` responses, in-memory state
and captured logs. It applies the same permission, repository, host and state
checks as the real one. `outboundHostsFromSettings` and `secrets` (signing
secrets by connection name) let it derive hosts from settings and sign requests
as the real `ctx.http` does. `packages/plugins/test/testing.test.ts` uses it on the
example plugin's `recordEvent` handler.

## Event subscriptions

A plugin with the `events.read` permission can subscribe its handlers to
[repository journal events](../architecture/repository-event-journal.md):

```json
"contributes": {
  "subscriptions": [
    { "on": "pull_request.merged", "handler": "onMerged" },
    { "on": "task.completed", "handler": "onTask", "filter": { "payload.kind": ["implementation", "review"] } }
  ]
}
```

```ts
// handlers.ts
export const onMerged = definePluginHandler<PluginEventInput>(async ({ event, deliveryId }, ctx) => {
  if (await ctx.state.get(`posted:${deliveryId}`)) return; // delivered before: do nothing twice
  await ctx.http('chat-token')('https://api.chat.example/messages', { method: 'POST', json: { text: `#${event.prNumber} merged` } });
  await ctx.state.set(`posted:${deliveryId}`, true);
});
```

`on` is `<domain>.<type>` of a journal event. `handler` is an exported function
of the plugin's `handlers.ts`. One event can go to several handlers, and one
handler can take several events. A pair of `on` and `handler` may appear only
once.

`filter` is optional. Every key must match. A key is an event field
(`repository`, `entityId`, `prNumber`, `issueNumber`, `planId`, `headSha`) or a
payload field (`payload.<key>`). A value is a string, number, boolean or `null`,
or a list of them, which matches any entry. `repository` is compared without
letter case. Filters only narrow what a subscription receives: the plugin's
repository limit always applies.

### Events and payloads

Each handler receives `{ kind: 'event', event, deliveryId, attempt }`. `event`
is the journal event: `seq`, `repository`, `domain`, `type`, `entityId`,
`prNumber`, `issueNumber`, `planId`, `headSha`, `payload` and `occurredAt`.
Payloads carry identifiers and short coded values only, never pull request
bodies, comments, prompts, logs or diffs.

| `on` | When | `payload` |
| --- | --- | --- |
| `pull_request.opened` | A pull request was opened | `baseRef`, `draft` |
| `pull_request.head_changed` | New commits were pushed (`headSha` is the new head) | `previousHeadSha` |
| `pull_request.review_scored` | A review was scored | `score`, `goal`, `goalReached`, `source`, `cycle`, `reviewerModel` |
| `pull_request.ultrafix_started` | An Ultrafix loop started | `goal`, `maxCycles`, `workEpoch` |
| `pull_request.ultrafix_ended` | An Ultrafix loop ended | `outcome`, `finalScore`, `reason`, `workEpoch` |
| `pull_request.auto_merge_decision` | Auto-merge decided on a head | The auto-merge decision fields |
| `pull_request.merged` | The pull request was merged | none |
| `pull_request.closed` | The pull request was closed unmerged | none |
| `epic_queue.started` | An epic queue started | `issues`, `advanceOn`, `parallel` |
| `epic_queue.advanced` | The queue moved to the next issue | `fromIssue`, `toIssue`, `cursor` |
| `epic_queue.blocked` | The queue head is blocked | `headIssue`, `blockedReason` |
| `epic_queue.completed` | The queue finished | `fromIssue`, `cursor` |
| `plan_issue.status_changed` | A plan issue changed status | `from`, `to` |
| `task.queued`, `task.started` | A task was queued, or started running | `taskId`, `kind`, `issueNumber`, `prNumber`, `agent`, `model`, `attempts` |
| `task.completed`, `task.failed`, `task.cancelled` | A task finished | The `task.queued` fields and `status`, `terminalReason`, `durationMs`, `pullRequest`, `failureCategory` |

The [journal page](../architecture/repository-event-journal.md#event-types)
describes each field.

### Delivery guarantees and limits

- **At least once.** A delivery can repeat, for example when a worker stops
  while a handler runs. `deliveryId` (`evt-<seq>-<handler>`) is the same on
  every attempt, after a restart too, so a handler with side effects should
  record the ids it has handled (`ctx.state` is meant for this).
- **In order per repository.** One plugin receives the events of one
  repository one at a time, in journal order. The next event waits until the
  current one has succeeded or finally failed. Other repositories go on
  meanwhile.
- **30 seconds** per attempt. A handler still running then has failed.
- **Retries.** A failed attempt is retried after 1 minute, 5 minutes,
  30 minutes and 2 hours. After the fifth attempt the delivery is marked
  failed and the next event follows. A handler can throw a
  `PluginDeliveryError` to change this for one attempt:
  `new PluginDeliveryError(message, { retryAfterMs })` waits that long instead
  (between 1 second and 6 hours, for a service's `Retry-After`, which
  `parsePluginRetryAfter` reads), and `{ permanent: true }` marks the delivery
  failed at once, for an error that retrying cannot fix.
- **No history.** Installing a plugin, or enabling it again, starts its
  subscriptions at that moment. Earlier events, and events journaled while it
  was disabled, are not delivered.
- **Repository limit.** Events of repositories outside the plugin's limit are
  not delivered. A change to the limit, disabling the plugin or revoking
  `events.read` applies from the next delivery, even within a batch.
- **Retention gaps.** The journal keeps 30 days of events. If events leave the
  journal before they were delivered (for example while deliveries were
  paused for a long time), they are skipped and the Activity list records the
  gap.
- **Never in the way.** Delivery runs after the event is journaled, in the
  daemon. A handler that fails, times out or crashes never fails or delays the
  task, review, merge or queue step that produced the event.
- **One deliverer.** When several daemons run, only one delivers to a given
  plugin at a time.

### Health, Degraded and Resume

After 3 failed attempts in a row the plugin is shown as **Degraded** on its
page, with the last error, and every administrator gets one Inbox
notification. A successful delivery clears it.

After 10 failed attempts in a row (set `PROPR_PLUGIN_PAUSE_AFTER_FAILURES` to
change this; it is never below 3) deliveries pause: nothing is delivered to the
plugin, and new events wait in the journal. **Resume deliveries** on the plugin
page starts them again; the failure count starts over and waiting retries run
at once.

### Activity

Each delivery is recorded on the plugin page under **Activity**, newest
first: the time, the event type and `seq`, the handler, the outcome, the
duration, the attempt, the error message and the handler's log lines (all
redacted). Event payloads, handler results and credentials are never stored.
Records are kept for 14 days (longer while their event still waits on another
handler or on Resume) and are deleted when the plugin is uninstalled.

**Retry** on a failed delivery gives it one more attempt, with the same
`deliveryId`, outside the repository's order, and with `manual: true` in the
event input, so a handler can try again what it gave up on (for example a
destination that refused it) while skipping what already succeeded. While
deliveries are paused, the
retry waits for Resume. A retried delivery of a repository now outside the
plugin's limit is not delivered; it is marked failed again.

The same records are available to administrators through the API:

| Route | What it does |
| --- | --- |
| `GET /api/instance/plugins/v1/:pluginId/activity` | Delivery health and the newest 100 records. |
| `POST /api/instance/plugins/v1/:pluginId/activity/:id/retry` | Retry a failed delivery (409 otherwise). |
| `POST /api/instance/plugins/v1/:pluginId/resume` | Resume paused deliveries (409 when not paused). |

Mutations need the same `X-ProPR-Plugins: 1` JSON contract as the other plugin
routes, and Retry and Resume are recorded in the plugin's audit trail.

## Inbound webhooks

A plugin can receive requests from an external service: a chat mention, an
issue tracker update, an error alert. Each webhook in `contributes.webhooks`
gets its own URL. ProPR verifies every request with the webhook's scheme before
any plugin code runs, then runs the webhook's `handler` from the delivery queue.

```json
"webhooks": [
  {
    "name": "events",
    "description": "Issue tracker updates",
    "handler": "onTrackerEvent",
    "verification": { "scheme": "hmac-sha256", "header": "X-Hub-Signature-256", "prefix": "sha256=", "connection": "tracker-signing" },
    "deliveryIdHeader": "X-GitHub-Delivery"
  },
  {
    "name": "slack",
    "description": "Slack Events API",
    "handler": "onSlackEvent",
    "respond": "slackChallenge",
    "verification": { "scheme": "slack-v0", "connection": "slack-signing" }
  }
]
```

### The webhook URL

```text
POST https://<your ProPR>/api/plugins/<installation key>/hooks/<name>
```

The installation key is 43 random characters, created for each installation.
Copy the URLs from the plugin's **Connect** step on the Plugins page, under
**Webhook URLs**. Each one has a Copy button. When the instance has no public
base URL, only the path is shown. Prefix it with the address services use to
reach ProPR.

Treat the URL as a secret, although it is not the only check. **Regenerate**
replaces the key in every URL at once: the old URLs answer 404 straight away,
so give each service its new URL afterwards. Regenerating is recorded in the
plugin's audit trail. Uninstalling deletes the key, and a reinstall gets a new
one.

Requests for a disabled or uninstalled plugin, or for a webhook name the
manifest does not declare, get 404 and run nothing. Enabling the plugin again
brings back the same URLs.

### Verification schemes

Each scheme checks the request against the value of a `signing_secret`
connection, set in the Connect step. Header names are matched without regard to
letter case.

| Scheme | Fields | What ProPR checks |
| --- | --- | --- |
| `hmac-sha256` | `header`, `prefix`?, `encoding`? (`hex`, the default, or `base64`), `connection` | `header` equals `prefix` followed by the HMAC-SHA256 of the raw body, keyed with the secret. GitHub's `X-Hub-Signature-256: sha256=…` is this scheme with `prefix: "sha256="`. |
| `slack-v0` | `connection` | Slack's [signed requests](https://api.slack.com/authentication/verifying-requests-from-slack): `X-Slack-Signature` equals `v0=` followed by the hex HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<raw body>`. The timestamp must be within 5 minutes of ProPR's clock, in either direction. |
| `token-header` | `header`, `prefix`?, `connection` | `header` equals `prefix` followed by the secret itself, as GitLab's `X-Gitlab-Token` does. Use `"header": "authorization", "prefix": "Bearer "` for a bearer token. |

Signatures and tokens are compared in constant time. A request that fails
verification gets **401** and runs nothing. This also covers a missing or wrong
signature, a stale Slack timestamp, and a webhook whose signing secret is not
set. ProPR counts each one on the installation, and the Webhook URLs section
shows the count, the time of the last one and its reason. The rejection is
logged with the plugin, the webhook and the reason only.

The tests use the published test vectors: GitHub's
([validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)),
RFC 4231 test case 2 for plain HMAC-SHA256, and Slack's documented request.
They are in `packages/core/test/pluginWebhooks.test.ts`.

### Delivery

After a request is verified, ProPR answers **202** at once with
`{ "accepted": true, "deliveryId" }`. The handler then runs from the queue as a
delivery of kind `webhook`, with the same 30 second limit and the same retry
schedule as event deliveries: 1 minute, 5 minutes, 30 minutes and 2 hours, then
failed. The handler receives:

```ts
{ kind: 'webhook', webhook, headers, body, receivedAt, deliveryId, attempt }
```

- `body` is the raw body as text, whatever its content type (JSON,
  form-encoded or plain text). A body sent with `Content-Encoding: gzip`,
  `deflate` or `br` is verified over the compressed bytes as sent, as the
  service signed them, and the handler gets it decoded.
- `headers` are the request's headers with lower-case names. ProPR removes the
  verification headers, `Authorization`, `Cookie`, `Content-Encoding` and the
  hop-by-hop headers first.
- `deliveryId` is the same on every attempt. When the webhook declares
  `deliveryIdHeader` and the service sends it, it is `whk-<webhook>:<id>` with
  that value as `<id>`. Otherwise ProPR assigns one: `whk-<webhook>/<uuid>`.
  The delivery id is shown in Activity, so `deliveryIdHeader` cannot be
  `Authorization` or `Proxy-Authorization` (nor a verification header); the
  manifest is refused. Verifying with `Authorization` is still allowed.

Other limits and refusals:

| Situation | Answer |
| --- | --- |
| Body larger than 256 KiB, as sent or once decoded | **413**. Nothing runs. |
| A verified body with a `Content-Encoding` other than `gzip`, `deflate` or `br` (or more than one) | **415**. Nothing runs. A compressed body that cannot be decoded gets **400**. |
| A `deliveryIdHeader` value already received, whose delivery succeeded or is still under way | **409** (a replay). Nothing runs, not even the `respond` function. Delivery ids are remembered for as long as Activity records are kept (14 days). A delivery that *failed* is not a replay: sending it again with the same delivery id delivers it (see below). |
| A `deliveryIdHeader` value that is not 1 to 200 printable characters | **400**. |
| Event deliveries of the plugin are [paused](#health-degraded-and-resume) | **503** with `Retry-After`. |
| 1,000 webhook deliveries already waiting | **503** with `Retry-After`. |
| More requests than the webhook rate limit allows | **429**. This is the limiter `POST /webhook` uses: `PROPR_WEBHOOK_RATE_LIMIT_MAX` requests per `PROPR_WEBHOOK_RATE_LIMIT_WINDOW_MS`, 300 per minute by default. |

Each webhook delivery appears in the plugin's [Activity](#activity) as
`webhook.<name>`, with its handler, outcome and attempts. ProPR never stores
or logs request bodies, signature headers or tokens. Because a handler could
log or throw part of the request, a webhook delivery keeps only the level and
time of each log line, not its message or fields, and its error says only that
the handler failed or timed out. The
request is held in the API process's memory only until its delivery is final.
Two things follow from that:

- A failed webhook delivery has no **Retry** button. The service has to send it
  again, and it may reuse the delivery id: a request whose delivery id belongs
  to a failed delivery is accepted (**202**) and replaces that delivery's
  Activity record with a new one. With GitHub, for example, use **Redeliver**
  on the webhook's Recent Deliveries. A delivery id whose delivery succeeded,
  or is still waiting or running, is still refused with 409.
- A delivery still waiting when its API process stops is marked failed with
  *ProPR stopped before the delivery finished*, by the next API process to
  start or by another one running (within about two minutes). Starting an API
  process never fails the deliveries of another one still running. Most
  services redeliver on their own.

Webhook failures do not count towards the plugin's Degraded and paused
[health](#health-degraded-and-resume), which tracks event deliveries.

### Challenge responses

Some services check a new URL by sending a challenge that must be echoed in the
response, such as Slack's `url_verification`. `respond` names another exported
function of `handlers.ts`. It runs after verification and the replay check, and
before the request is queued, and it receives only the frozen request
`{ webhook, headers, body, receivedAt }`. It gets no `ctx`, so it cannot read
state, call ProPR or send HTTP requests. It must return synchronously:

```ts
import { definePluginWebhookResponder } from '@propr/shared';

export const slackChallenge = definePluginWebhookResponder(request => {
  const body = JSON.parse(request.body) as { type?: string; challenge?: string };
  return body.type === 'url_verification' && body.challenge
    ? { contentType: 'text/plain', body: body.challenge }
    : null;
});
```

When it returns a response (a 2xx `status`, 200 by default, a `text/plain` or
`application/json` `contentType` and a `body` of at most 4 KiB), ProPR sends
that response and the handler does not run; the delivery id stays taken, so a
replayed challenge gets 409. When it returns `null`, the request
is queued as usual. If it throws, returns a promise or returns an invalid
response, ProPR answers **500** and runs nothing.

### Webhook URL routes

| Route | What it does |
| --- | --- |
| `GET /api/instance/plugins/v1/:pluginId/webhooks` | The webhook URLs of an installed plugin and its count of rejected requests (409 when not installed). |
| `POST /api/instance/plugins/v1/:pluginId/webhooks/regenerate` | Replace the installation key. The old URLs stop working at once. |
| `POST /api/plugins/:installationKey/hooks/:webhookName` | The public webhook endpoint described above. |

The first two need a durable instance administrator, like the other plugin
routes, and Regenerate needs the `X-ProPR-Plugins: 1` JSON contract.

## Command deliveries

A `handler` [command](#commands) calls its handler with the comment that ran
it, as a delivery of kind `command`:

```ts
import { definePluginHandler, type PluginCommandInput } from '@propr/shared';

export const deploy = definePluginHandler<PluginCommandInput>(async (input, ctx) => {
  // input.repository: 'acme/app', input.number: 42, input.target: 'pull_request',
  // input.actor: the commenter's login, input.args: the rest of the command line (untrusted).
  await ctx.propr.commentOnPullRequest(input.repository, input.number, `Deploying for @${input.actor}…`);
  const response = await ctx.http('deploy-token')('https://api.example.com/deploy', { method: 'POST' });
  ctx.log.info('deploy requested', { status: response.status });
});
```

- **When:** the comment intake records the delivery as soon as the command is
  accepted, after the same author rules and assignment gate as the built-in
  commands. A daemon attempts it within a few seconds. Nothing waits for the
  handler; it posts its own replies.
- **Input:** `{ kind: 'command', command, args, repository, number, target, actor, commentId, deliveryId, attempt }`.
  `args` is untrusted text: treat it as data. The record keeps this comment
  context (so a delivery can be attempted again after a restart), never a
  credential or the handler's result.
- **Delivery id:** `cmd-issue-<comment id>` for an issue comment (on an issue
  or a pull request's conversation), `cmd-review-<comment id>` for a pull
  request review comment, the same on every attempt. GitHub numbers the two
  kinds separately, so each is its own command; a redelivered comment is
  recorded once.
- **`ctx`:** the plugin's full handler context: `ctx.propr` with the granted
  permissions (`pull_requests.comment` or `issues.comment` to comment back),
  `ctx.http`, `ctx.state` and `ctx.log`.
- **Retries:** a failed attempt is tried again after 1 min, 5 min, 30 min and
  2 h, then marked failed. While the plugin's deliveries are paused the
  command waits for Resume; disabling the plugin fails its unfinished command
  deliveries.
- **Activity:** each delivery appears under **Activity** with the type
  `command.<name>`, the repository and the issue or pull request number, the
  handler, outcome, duration, attempt, redacted error and log lines.
