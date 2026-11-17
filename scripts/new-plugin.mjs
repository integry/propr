#!/usr/bin/env tsx
/**
 * Scaffolds a new official plugin:
 *
 *   npm run plugins:new -- <id> [--name "Acme Chat"] [--category messaging] [--description "…"]
 *
 * creates `packages/plugins/<id>/` with a manifest, a README template (setup,
 * permissions, smoke-test checklist, documentation links), an icon and an
 * example handler; a test of that handler with the plugin test kit in
 * `packages/plugins/test/<id>.test.ts`; a docs page `docs/docs/plugins/<id>.md`;
 * registers the plugin in `packages/plugins/registry.json` (after the other
 * official plugins, before the development ones); and regenerates the plugin
 * docs (catalog, sidebar) so `npm run plugins:docs:check` passes.
 *
 * The result passes `npm run plugins:check`, `npm run lint -w @propr/plugins`
 * and its own test without edits. `--root <dir>`, `--tests <dir>` and
 * `--docs <dir>` write elsewhere, for the script's own tests; docs are
 * regenerated only when the docs folder has the authoring guide.
 *
 * Runs under tsx: it imports the TypeScript sources so no build is needed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_CATEGORIES, PLUGIN_MANIFEST_VERSION, PLUGIN_SHARED_FOLDER, pluginIdSchema } from '../packages/shared/src/plugins.js';
import { PLUGINS_ROOT } from './check-plugins.mjs';
import { AUTHORING_PAGE, DOCS_ROOT, generatePluginDocs, writePluginDocs } from './gen-plugin-docs.mjs';

export const EXAMPLE_HANDLER = 'onPullRequestMerged';

/** `acme-chat` → `Acme Chat`. */
export const titleCase = id => id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

/** registry.json in its checked-in layout: one plugin per line. */
export function serializeRegistry(document) {
  const entries = document.plugins.map(entry => `    ${JSON.stringify(entry).replaceAll('":', '": ').replaceAll(',"', ', "').replace(/^\{/, '{ ').replace(/\}$/, ' }')}`);
  return `{\n  "version": ${document.version},\n  "plugins": [\n${entries.join(',\n')}\n  ]\n}\n`;
}

/** The registry with `id` added after the last official plugin, before the development ones. */
export function registerPlugin(document, id) {
  const plugins = [...document.plugins];
  const firstDevelopment = plugins.findIndex(entry => entry.development === true);
  plugins.splice(firstDevelopment < 0 ? plugins.length : firstDevelopment, 0, { id });
  return { ...document, plugins };
}

export function manifestFor({ id, name, category, description }) {
  return {
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    id,
    name,
    description: description ?? `Logs each pull request merged in the repositories it is enabled for. Replace this description: its first sentence is the one-line summary in the plugin catalog.`,
    version: '0.1.0',
    category,
    homepage: `https://github.com/integry/propr/tree/main/packages/plugins/${id}`,
    icon: 'icon.svg',
    permissions: ['events.read'],
    connections: [],
    settings: {
      type: 'object',
      properties: {
        prefix: { type: 'string', label: 'Log prefix', help: 'Text the handler starts each log line with.', default: 'Merged', maxLength: 40 },
      },
      required: [],
    },
    outboundHosts: [],
    contributes: {
      subscriptions: [{ on: 'pull_request.merged', handler: EXAMPLE_HANDLER }],
    },
  };
}

export function handlersFor() {
  return `import { definePluginHandler, type PluginEventInput, type PluginJsonValue } from '@propr/shared';

/**
 * Handlers of this plugin: every exported function of this module is a
 * handler, so export nothing else. A handler reaches ProPR, the network and
 * its state only through \`ctx\`, and imports nothing from ProPR but
 * \`@propr/shared\`.
 */

interface MergeCounter { [key: string]: PluginJsonValue; seq: number; count: number }
const isCounter = (value: PluginJsonValue | undefined): value is MergeCounter =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.seq === 'number' && typeof value.count === 'number';

/**
 * Example handler, subscribed to \`pull_request.merged\`: counts merged pull
 * requests per repository in \`ctx.state\` and logs each merge. Delivery is
 * at least once and in order per repository, so the event's \`seq\` tells a
 * repeated delivery from a new one; the counter is read and written in one
 * atomic \`ctx.state.update\`.
 */
export const ${EXAMPLE_HANDLER} = definePluginHandler<PluginEventInput, { repository: string; merged: number; duplicate: boolean }>(async (input, ctx) => {
  const { event } = input;
  let duplicate = false;
  const stored = await ctx.state.update(\`merged:\${event.repository.toLowerCase()}\`, current => {
    const previous = isCounter(current) ? current : { seq: 0, count: 0 };
    if (event.seq <= previous.seq) {
      duplicate = true;
      return undefined;
    }
    return { seq: event.seq, count: previous.count + 1 };
  });
  const merged = isCounter(stored) ? stored.count : 0;
  if (!duplicate) {
    const prefix = typeof ctx.settings.prefix === 'string' && ctx.settings.prefix ? ctx.settings.prefix : 'Merged';
    ctx.log.info(\`\${prefix} #\${event.prNumber ?? event.entityId} in \${event.repository}\`, { merged, attempt: input.attempt });
  }
  return { repository: event.repository, merged, duplicate };
});
`;
}

export function testFor({ id }) {
  return `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parsePluginManifest, type PluginEventInput, type PluginManifest, type RepositoryEvent } from '@propr/shared';
import { createTestPluginContext } from '../testing/index.js';
import * as handlers from '../${id}/handlers.js';

const parsed = parsePluginManifest(JSON.parse(readFileSync(new URL('../${id}/manifest.json', import.meta.url), 'utf8')));
if (!parsed.ok) throw new Error(parsed.errors.join('\\n'));
const manifest: PluginManifest = parsed.manifest;

const merged = (seq: number, overrides: Partial<RepositoryEvent> = {}): PluginEventInput => ({
  kind: 'event',
  event: {
    seq, repository: 'owner/repo', domain: 'pull_request', type: 'merged', entityId: String(seq), prNumber: seq, issueNumber: null, planId: null,
    headSha: null, payload: {}, occurredAt: '2026-01-01T00:00:00.000Z', ...overrides,
  },
  deliveryId: \`evt-\${seq}-${EXAMPLE_HANDLER}\`, attempt: 1,
});

/** A test context with the manifest's own permissions and outbound hosts, so the handler fails the way it would in ProPR. */
const kit = (settings = {}) => createTestPluginContext({
  pluginId: manifest.id, settings, grantedPermissions: manifest.permissions, outboundHosts: manifest.outboundHosts, settingDefinitions: manifest.settings.properties,
});

test('every subscription, command and webhook names an exported handler', () => {
  const named = [
    ...manifest.contributes.subscriptions.map(s => s.handler),
    ...manifest.contributes.commands.flatMap(c => (c.handler ? [c.handler] : [])),
    ...manifest.contributes.webhooks.flatMap(w => [w.handler, ...(w.respond ? [w.respond] : [])]),
  ];
  for (const name of named) assert.equal(typeof (handlers as Record<string, unknown>)[name], 'function', name);
});

test('${EXAMPLE_HANDLER} counts merges per repository and logs each one', async () => {
  const { ctx, logs, state, calls, requests } = kit({ prefix: 'Shipped' });
  assert.deepEqual(await handlers.${EXAMPLE_HANDLER}(merged(3), ctx), { repository: 'owner/repo', merged: 1, duplicate: false });
  assert.deepEqual(await handlers.${EXAMPLE_HANDLER}(merged(7), ctx), { repository: 'owner/repo', merged: 2, duplicate: false });
  assert.deepEqual(await handlers.${EXAMPLE_HANDLER}(merged(9, { repository: 'owner/other' }), ctx), { repository: 'owner/other', merged: 1, duplicate: false });
  assert.deepEqual(logs.map(line => line.message), ['Shipped #3 in owner/repo', 'Shipped #7 in owner/repo', 'Shipped #9 in owner/other']);
  assert.deepEqual(state.get('merged:owner/repo'), { seq: 7, count: 2 });
  assert.deepEqual(calls, []);
  assert.deepEqual(requests, []);
});

test('${EXAMPLE_HANDLER} does nothing twice when a delivery repeats', async () => {
  const { ctx, logs } = kit();
  await handlers.${EXAMPLE_HANDLER}(merged(5), ctx);
  assert.deepEqual(await handlers.${EXAMPLE_HANDLER}({ ...merged(5), attempt: 2 }, ctx), { repository: 'owner/repo', merged: 1, duplicate: true });
  assert.deepEqual(logs.map(line => line.message), ['Merged #5 in owner/repo']);
});
`;
}

export function readmeFor({ id, name }) {
  return `# ${name}

The **${name}** plugin (\`${id}\`) logs each pull request merged in the
repositories it is enabled for. *Replace this paragraph: say what the plugin
does, what it needs and what it never does (for example, never sends code,
logs or prompt text).*

It was created by \`npm run plugins:new -- ${id}\`. Its example handler,
\`${EXAMPLE_HANDLER}\` in \`handlers.ts\`, is tested by
\`../test/${id}.test.ts\` with the plugin test kit.

## Setup

1. In the service, create the credential the plugin needs (an API token, a
   webhook signing secret, an OAuth app) with the narrowest scopes it allows.
2. In ProPR, open **Plugins**, choose **${name}** and install it. Approve the
   permissions listed below.
3. Under **Connections**, enter each credential. ProPR stores it sealed and
   never shows it again.
4. In **Settings**, adjust the settings below and, under **Repositories**,
   limit the plugin to the repositories it should act on.
5. Enable the plugin.

## Permissions

| Permission | Why |
| --- | --- |
| \`events.read\` | Receive \`pull_request.merged\` events. |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| \`prefix\` | \`Merged\` | Text each log line starts with. |

## Smoke-test checklist

Run these against a real account of the service before the plugin ships, and
record the result in the pull request:

- [ ] \`npm run plugins:check\`, \`npm run lint -w @propr/plugins\` and
      \`npx tsx --test packages/plugins/test/${id}.test.ts\` pass.
- [ ] Install, configure and enable the plugin on a test instance; the
      Plugins page shows no enable blockers.
- [ ] Merge a pull request in a repository inside the limit: the delivery
      appears under **Activity** as succeeded, with the expected log line.
- [ ] A repository outside the limit gets no delivery.
- [ ] A wrong or missing credential fails with a message that says what to fix.
- [ ] **Retry** on a failed delivery runs it again without doing anything twice.
- [ ] Disable and uninstall the plugin: nothing is delivered afterwards, and
      its managed items (servers, skills, templates) are gone.

## Documentation

- [${name} plugin page](../../../docs/docs/plugins/${id}.md)
- [Writing an official plugin](../../../docs/docs/plugins/authoring.md)
- [Plugins: the manifest format](../../../docs/docs/features/plugins.md)
- *Add the service's API and webhook documentation here.*
`;
}

export function docsPageFor({ id, name, manifest }) {
  return `---
sidebar_label: "${name}"
title: "${name} plugin"
description: "${manifest.description.split(/(?<=[.!?])\s/)[0].replaceAll('"', '\\"')}"
---
# ${name}

The **${name}** plugin (\`${id}\`) is an official [plugin](../features/plugins.md)
built only on the plugin interface. *Replace this page with what the plugin
does, how to set it up, what it sends and what it never sends.* The folder is
\`packages/plugins/${id}/\`; its README has the setup steps and the
smoke-test checklist.

## Setup

1. In ProPR, open **Plugins**, choose **${name}** and install it. It asks for
   one permission, \`events.read\`.
2. In **Settings**, set **Log prefix** if you want another one.
3. Enable the plugin.

## What it does

Each \`pull_request.merged\` event of a repository inside the plugin's
repository limit runs the \`${EXAMPLE_HANDLER}\` handler, which logs the merge.
Deliveries are shown under **Activity** on the plugin page.
`;
}

export const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>\n';

/** Why `id` cannot be a new plugin in `root`, or null. */
export function newPluginProblem(id, { root, registry }) {
  const parsed = pluginIdSchema.safeParse(id);
  if (!parsed.success) return `${JSON.stringify(id)} is not a plugin id: ${parsed.error.issues[0].message}`;
  if (id === PLUGIN_SHARED_FOLDER) return `${id} is reserved for code shared by several plugins`;
  if (registry.plugins.some(entry => entry.id === id)) return `${id} is already listed in registry.json`;
  if (existsSync(path.join(root, id))) return `packages/plugins/${id} already exists`;
  return null;
}

/** Write the plugin. Returns the files written, absolute. Throws with a message for the person running it. */
export function scaffoldPlugin({ id, name = titleCase(id), category = 'other', description, root = PLUGINS_ROOT, tests = path.join(root, 'test'), docs = DOCS_ROOT }) {
  if (!PLUGIN_CATEGORIES.includes(category)) throw new Error(`--category must be one of ${PLUGIN_CATEGORIES.join(', ')}`);
  const registryFile = path.join(root, 'registry.json');
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  const problem = newPluginProblem(id, { root, registry });
  if (problem) throw new Error(problem);
  const testFile = path.join(tests, `${id}.test.ts`);
  const docsFile = path.join(docs, 'docs/plugins', `${id}.md`);
  for (const file of [testFile, docsFile]) if (existsSync(file)) throw new Error(`${file} already exists`);

  const manifest = manifestFor({ id, name, category, description });
  const directory = path.join(root, id);
  const files = new Map([
    [path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`],
    [path.join(directory, 'README.md'), readmeFor({ id, name })],
    [path.join(directory, 'icon.svg'), ICON],
    [path.join(directory, 'handlers.ts'), handlersFor()],
    [testFile, testFor({ id })],
    [docsFile, docsPageFor({ id, name, manifest })],
    [registryFile, serializeRegistry(registerPlugin(registry, id))],
  ]);
  for (const [file, content] of files) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const written = [...files.keys()];
  if (existsSync(path.join(docs, AUTHORING_PAGE))) {
    const generated = generatePluginDocs({ root, docs });
    if (generated.problems.length) throw new Error(`The plugin was created, but the docs could not be regenerated:\n${generated.problems.join('\n')}`);
    written.push(...writePluginDocs(generated.files));
  }
  return written;
}

export function parseArguments(argv) {
  const options = { root: PLUGINS_ROOT, docs: DOCS_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      return next;
    };
    if (argument === '--name') options.name = value();
    else if (argument === '--category') options.category = value();
    else if (argument === '--description') options.description = value();
    else if (argument === '--root') options.root = path.resolve(value());
    else if (argument === '--tests') options.tests = path.resolve(value());
    else if (argument === '--docs') options.docs = path.resolve(value());
    else if (argument.startsWith('-')) throw new Error(`Unknown option ${argument}`);
    else if (options.id !== undefined) throw new Error(`Give one plugin id, not ${options.id} and ${argument}`);
    else options.id = argument;
  }
  if (options.id === undefined) throw new Error('Usage: npm run plugins:new -- <id> [--name "Acme Chat"] [--category messaging] [--description "…"]');
  return options;
}

function main(argv) {
  let written;
  try {
    written = scaffoldPlugin(parseArguments(argv));
  } catch (error) {
    console.error(`plugins:new: ${error.message}`);
    return 1;
  }
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const file of written) console.log(`wrote ${path.relative(repositoryRoot, file)}`);
  console.log('\nNext: edit the manifest, handlers, test, README and docs page, then run npm run plugins:check, npm run plugins:docs and the plugin test. See docs/docs/plugins/authoring.md.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
