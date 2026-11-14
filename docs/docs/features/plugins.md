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
This page describes the plugin **manifest** and the official plugin registry.
Installation, the Plugins page, applying contributions to runs, handlers,
webhooks and commands are added by later releases; until then a manifest is
validated but has no effect on ProPR.
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
