#!/usr/bin/env tsx
/**
 * Generates the plugin documentation that must not drift from the code:
 *
 *   - the manifest reference, the event payload table and the SDK surface in
 *     docs/docs/plugins/authoring.md (between `BEGIN GENERATED` / `END
 *     GENERATED` markers), from the zod manifest schema and the plugin
 *     contract of @propr/shared;
 *   - the plugin catalog page docs/docs/plugins/catalog.md, from the
 *     manifests of the official plugins;
 *   - the manifest JSON Schema, docs/static/schemas/plugin-manifest.v<N>.schema.json;
 *   - the docs sidebar's plugin pages, docs/plugin-pages.json.
 *
 * `npm run plugins:docs` writes them. `npm run plugins:docs:check` (run in CI
 * on every pull request) fails when any of them is out of date, when an
 * official plugin has no page `docs/docs/plugins/<id>.md`, or when a manifest
 * field has no description in scripts/plugin-manifest-descriptions.mjs.
 * `--root <dir>` and `--docs <dir>` point at another registry and docs
 * folder, for the scripts' own tests.
 *
 * Runs under tsx: it imports the TypeScript sources so no build is needed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGINS_ROOT, checkPlugins } from './check-plugins.mjs';
import { MANIFEST_FIELD_DESCRIPTIONS } from './plugin-manifest-descriptions.mjs';
import {
  PLUGIN_EVENT_ENVELOPE_FIELDS, PLUGIN_EVENT_PAYLOAD_FIELDS, PLUGIN_SDK_CONTEXT_MEMBERS, PLUGIN_SDK_INPUT_FIELDS, PLUGIN_SDK_LOG_LEVELS, PLUGIN_SDK_STATE_METHODS,
  PLUGIN_SUPPORTED_MANIFEST_VERSIONS, jsonSchemaTypeName, pluginManifestJsonSchema, walkPluginManifestSchema,
} from '../packages/shared/src/pluginContract.js';
import { PLUGIN_CATEGORIES, PLUGIN_LIMITS, PLUGIN_MANIFEST_VERSION, PLUGIN_PERMISSION_DESCRIPTIONS } from '../packages/shared/src/plugins.js';
import {
  PLUGIN_HANDLER_TIMEOUT_MS, PLUGIN_HTTP_LIMITS, PLUGIN_LOG_LIMITS, PLUGIN_PROPR_LIMITS, PLUGIN_PROPR_OPERATIONS, PLUGIN_RETRY_AFTER_LIMITS_MS, PLUGIN_SDK_ERROR_CODES,
  PLUGIN_SETTING_OPTIONS_LIMITS, PLUGIN_STATE_LIMITS, PLUGIN_WEBHOOK_LIMITS,
} from '../packages/shared/src/pluginSdk.js';
import * as pluginSdk from '../packages/shared/src/pluginSdk.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOCS_ROOT = path.join(repositoryRoot, 'docs');
export const AUTHORING_PAGE = 'docs/plugins/authoring.md';
export const CATALOG_PAGE = 'docs/plugins/catalog.md';
export const SIDEBAR_FILE = 'plugin-pages.json';
export const SCHEMA_FILE = `static/schemas/plugin-manifest.v${PLUGIN_MANIFEST_VERSION}.schema.json`;
const REGENERATE = 'npm run plugins:docs';

export const CATEGORY_LABELS = {
  messaging: 'Messaging', 'issue-tracking': 'Issue tracking', observability: 'Observability', deployment: 'Deployment', context: 'Context', other: 'Other',
};

const code = value => `\`${value}\``;
/** A table cell: one line, with pipes escaped (GFM unescapes them inside code spans too). */
const cell = value => String(value ?? '').replace(/\s*\n\s*/g, ' ').replaceAll('|', '\\|');
const row = cells => `| ${cells.map(cell).join(' | ')} |`;
const table = (headers, rows) => [row(headers), row(headers.map(() => '---')), ...rows.map(row)].join('\n');

/** The first sentence of a description: the catalog's one-line summary. */
export function firstSentence(text) {
  const match = /^.*?[.!?](?=\s+[A-Z(]|$)/s.exec(text.trim());
  return (match ? match[0] : text).replace(/\s+/g, ' ').trim();
}

// --- Manifest reference -----------------------------------------------------

const SECTIONS = [
  { title: 'Top-level fields', match: p => !/[.[]/.test(p) },
  { title: 'Connections', match: p => p.startsWith('connections[') },
  { title: 'Settings', match: p => p.startsWith('settings.') },
  { title: 'MCP servers', match: p => p.startsWith('contributes.mcpServers') },
  { title: 'Skills and automation templates', match: p => p.startsWith('contributes.skills') || p.startsWith('contributes.automationTemplates') },
  { title: 'Commands', match: p => p.startsWith('contributes.commands') },
  { title: 'Event subscriptions', match: p => p.startsWith('contributes.subscriptions') },
  { title: 'Webhooks', match: p => p.startsWith('contributes.webhooks') },
];

/** The description key matching `path`: the exact path, or the path with each union variant replaced by `*`. */
function descriptionFor(path) {
  if (Object.hasOwn(MANIFEST_FIELD_DESCRIPTIONS, path)) return { key: path, text: MANIFEST_FIELD_DESCRIPTIONS[path] };
  const wildcard = path.replace(/\{([a-z]+)=[^}]*\}/g, '{$1=*}');
  if (Object.hasOwn(MANIFEST_FIELD_DESCRIPTIONS, wildcard)) return { key: wildcard, text: MANIFEST_FIELD_DESCRIPTIONS[wildcard] };
  return null;
}

const SHORT_PATTERN = 48;
function rules(node) {
  const parts = [];
  const limits = (n, prefix = '') => {
    if (n.minLength === 1) parts.push(`${prefix}not empty`);
    else if (n.minLength !== undefined && n.minLength > 1) parts.push(`${prefix}at least ${n.minLength} characters`);
    if (n.maxLength !== undefined) parts.push(`${prefix}at most ${n.maxLength} characters`);
    if (n.minimum !== undefined) parts.push(`${prefix}at least ${n.minimum}`);
    if (n.maximum !== undefined) parts.push(`${prefix}at most ${n.maximum}`);
    if (n.format === 'uri') parts.push(`${prefix}an https:// URL`);
    const patterns = [n.pattern, ...(n.allOf ?? []).map(p => p.pattern)].filter(Boolean);
    for (const pattern of patterns) if (pattern.length <= SHORT_PATTERN) parts.push(`${prefix}matches ${code(pattern)}`);
    const values = n.enum;
    if (values) parts.push(`${prefix}one of ${values.map(v => code(v)).join(', ')}`);
  };
  if (node.type === 'array') {
    if (node.minItems !== undefined && node.minItems > 0) parts.push(`at least ${node.minItems} ${node.minItems === 1 ? 'entry' : 'entries'}`);
    if (node.maxItems !== undefined) parts.push(`at most ${node.maxItems} entries`);
    if (node.items) limits(node.items, 'each ');
  } else limits(node);
  return parts.join('; ');
}

/** The manifest reference rows, or the problems that stop the reference being generated. */
export function manifestReference() {
  const problems = [];
  const fields = walkPluginManifestSchema();
  const used = new Set();
  const sections = SECTIONS.map(section => ({ ...section, rows: [] }));
  for (const { path: fieldPath, node, required } of fields) {
    const description = descriptionFor(fieldPath);
    if (!description) problems.push(`manifest field ${fieldPath} has no description in scripts/plugin-manifest-descriptions.mjs`);
    else used.add(description.key);
    const section = sections.find(s => s.match(fieldPath));
    if (!section) { problems.push(`manifest field ${fieldPath} belongs to no section of the reference`); continue; }
    const notes = [code(jsonSchemaTypeName(node)), required ? '**required**' : '', node.default === undefined ? '' : `default ${code(JSON.stringify(node.default))}`, rules(node)].filter(Boolean).join('; ');
    section.rows.push([code(fieldPath), notes, description?.text ?? '']);
  }
  for (const key of Object.keys(MANIFEST_FIELD_DESCRIPTIONS)) if (!used.has(key)) problems.push(`scripts/plugin-manifest-descriptions.mjs describes ${key}, which the manifest schema does not have`);
  const blocks = sections.map(section => `### ${section.title}\n\n${table(['Field', 'Type and rules', 'Description'], section.rows)}`);
  const permissions = table(['Permission', 'What it allows'], Object.entries(PLUGIN_PERMISSION_DESCRIPTIONS).map(([name, text]) => [code(name), text]));
  const limits = table(['Limit', 'Value'], Object.entries(PLUGIN_LIMITS).map(([name, value]) => [code(name), value]));
  const text = [
    `The manifest schema is \`pluginManifestSchema\` in \`packages/shared/src/plugins.ts\`. This reference is generated from it (\`${REGENERATE}\`), and CI fails when it is out of date. Paths use \`.\` between properties, \`[]\` for list entries, \`<key>\` for map values and \`{type=token}\` for one variant of a union. Unknown fields are refused everywhere. The same schema is published as JSON Schema at [\`/schemas/plugin-manifest.v${PLUGIN_MANIFEST_VERSION}.schema.json\`](pathname:///schemas/plugin-manifest.v${PLUGIN_MANIFEST_VERSION}.schema.json) for editor validation; it describes the field shapes, not the cross-checks (connection references, command rules) that \`npm run plugins:check\` adds.`,
    `Current \`manifestVersion\`: \`${PLUGIN_MANIFEST_VERSION}\`. Versions ProPR reads: ${PLUGIN_SUPPORTED_MANIFEST_VERSIONS.map(code).join(', ')}.`,
    ...blocks,
    `### Permissions\n\n${permissions}`,
    `### Manifest limits\n\nMost entries per list (\`PLUGIN_LIMITS\`); \`text\` is the longest free text such as a \`help\`.\n\n${limits}`,
  ].join('\n\n');
  return { text, problems };
}

// --- Events and SDK -----------------------------------------------------------

const fieldList = fields => Object.entries(fields).map(([key, type]) => code(`${key}: ${type}`)).join(', ');

export function eventPayloadReference() {
  const envelope = table(['Field', 'Type'], Object.entries(PLUGIN_EVENT_ENVELOPE_FIELDS).map(([key, type]) => [code(key), code(type)]));
  const payloads = table(['`on`', 'Payload fields'], Object.entries(PLUGIN_EVENT_PAYLOAD_FIELDS).map(([name, fields]) => [code(name), Object.keys(fields).length ? fieldList(fields) : 'none']));
  return [
    `Generated from \`PLUGIN_EVENT_PAYLOAD_FIELDS\` and \`PLUGIN_EVENT_ENVELOPE_FIELDS\` in \`packages/shared/src/pluginContract.ts\`. A key ending in \`?\` may be absent. The contract test fails when a key is removed or retyped.`,
    `\`input.event\`, the journal event:\n\n${envelope}`,
    `\`input.event.payload\`, by event:\n\n${payloads}`,
  ].join('\n\n');
}

const ms = value => (value % 3_600_000 === 0 ? `${value / 3_600_000} h` : value % 1000 === 0 ? `${value / 1000} s` : `${value} ms`);
const bytes = value => (value % 1024 === 0 ? `${value / 1024} KiB` : `${value} bytes`);

export function sdkReference() {
  const propr = table(['Operation', 'Permission'], Object.entries(PLUGIN_PROPR_OPERATIONS).map(([name, permission]) => [code(`ctx.propr.${name}`), code(permission)]));
  const inputs = table(['`kind`', 'Fields'], Object.entries(PLUGIN_SDK_INPUT_FIELDS).map(([kind, fields]) => [code(kind), fields.map(code).join(', ')]));
  const exports = Object.keys(pluginSdk).sort().map(code).join(', ');
  const limits = table(['Limit', 'Value'], [
    ['Handler run time', ms(PLUGIN_HANDLER_TIMEOUT_MS)],
    ['`ctx.state`', `${PLUGIN_STATE_LIMITS.keys} keys of at most ${PLUGIN_STATE_LIMITS.keyLength} characters; ${bytes(PLUGIN_STATE_LIMITS.valueBytes)} per value; ${bytes(PLUGIN_STATE_LIMITS.totalBytes)} in all`],
    ['`ctx.http`', `requests ${bytes(PLUGIN_HTTP_LIMITS.requestBytes)}, responses ${bytes(PLUGIN_HTTP_LIMITS.responseBytes)}, ${ms(PLUGIN_HTTP_LIMITS.timeoutMs)}, ${PLUGIN_HTTP_LIMITS.headers} headers`],
    ['`ctx.log`', `${PLUGIN_LOG_LIMITS.lines} lines per run, ${PLUGIN_LOG_LIMITS.messageChars} characters per message, ${bytes(PLUGIN_LOG_LIMITS.fieldsBytes)} of fields`],
    ['`ctx.propr` text', `titles ${PLUGIN_PROPR_LIMITS.titleChars} characters, bodies ${PLUGIN_PROPR_LIMITS.bodyChars}, ${PLUGIN_PROPR_LIMITS.labels} labels of ${PLUGIN_PROPR_LIMITS.labelChars}, ${PLUGIN_PROPR_LIMITS.events} events per \`listEvents\``],
    ['Inbound webhooks', `bodies ${bytes(PLUGIN_WEBHOOK_LIMITS.bodyBytes)}, \`respond\` answers ${bytes(PLUGIN_WEBHOOK_LIMITS.responseBytes)}, delivery ids ${PLUGIN_WEBHOOK_LIMITS.deliveryIdChars} characters, Slack timestamps within ${ms(PLUGIN_WEBHOOK_LIMITS.timestampToleranceSeconds * 1000)}`],
    ['`optionsFrom` choices', `${PLUGIN_SETTING_OPTIONS_LIMITS.options} options, values ${PLUGIN_SETTING_OPTIONS_LIMITS.valueChars} characters, labels ${PLUGIN_SETTING_OPTIONS_LIMITS.labelChars}`],
    ['`PluginDeliveryError` `retryAfterMs`', `${ms(PLUGIN_RETRY_AFTER_LIMITS_MS.min)} to ${ms(PLUGIN_RETRY_AFTER_LIMITS_MS.max)}`],
  ]);
  return [
    'Generated from `packages/shared/src/pluginSdk.ts` and `pluginContract.ts`. Every item is part of the compatibility contract: it is only ever added to.',
    `\`ctx\` members: ${PLUGIN_SDK_CONTEXT_MEMBERS.map(code).join(', ')}. \`ctx.state\` methods: ${PLUGIN_SDK_STATE_METHODS.map(code).join(', ')}. \`ctx.log\` levels: ${PLUGIN_SDK_LOG_LEVELS.map(code).join(', ')}.`,
    propr,
    `Handler inputs (a \`?\` marks an optional field):\n\n${inputs}`,
    `\`PluginSdkError\` codes: ${PLUGIN_SDK_ERROR_CODES.map(code).join(', ')}.`,
    `Runtime exports of the SDK module: ${exports}.`,
    `Limits:\n\n${limits}`,
  ].join('\n\n');
}

// --- Catalog --------------------------------------------------------------------

/** The catalog page: every official plugin (not development plugins), grouped by category. */
export function catalogPage(plugins) {
  const official = plugins.filter(plugin => !plugin.development);
  const groups = PLUGIN_CATEGORIES.map(category => ({ category, plugins: official.filter(plugin => plugin.manifest.category === category) })).filter(group => group.plugins.length);
  const all = table(['Plugin', 'Category', 'Description'], official.map(({ id, manifest }) => [`[${manifest.name}](./${id}.md) (${code(id)})`, CATEGORY_LABELS[manifest.category], firstSentence(manifest.description)]));
  return `---
sidebar_label: "Catalog"
title: "Official plugin catalog"
description: "Every official ProPR plugin with its category and what it does, generated from the plugin manifests."
---
{/* Generated by ${REGENERATE} from the manifests in packages/plugins. Do not edit: CI fails when this page is out of date. */}
# Official plugins

ProPR ships ${official.length} official plugins. Each one is a folder
\`packages/plugins/<id>/\` in the ProPR repository, reviewed and released with
ProPR itself: installing one downloads nothing (except the pinned npm package
of a local MCP server). An administrator installs, configures and enables them
on the **Plugins** page; see [Plugins](../features/plugins.md) for how that
works and [Writing a plugin](./authoring.md) to add one.

${all}

## By category

${groups.map(group => `### ${CATEGORY_LABELS[group.category]}\n\n${group.plugins.map(({ id, manifest }) => `- [${manifest.name}](./${id}.md): ${firstSentence(manifest.description)}`).join('\n')}`).join('\n\n')}
`;
}

// --- Assembly ---------------------------------------------------------------------

const marker = (name, edge) => `{/* ${edge} GENERATED ${name}: ${REGENERATE} */}`;

/** Replace the generated block `name` of a page; throws when its markers are missing. */
export function replaceGeneratedBlock(page, name, content) {
  const begin = marker(name, 'BEGIN');
  const end = marker(name, 'END');
  const start = page.indexOf(begin);
  const stop = page.indexOf(end);
  if (start < 0 || stop < start) throw new Error(`the ${name} block (${begin} … ${end}) is missing`);
  return `${page.slice(0, start + begin.length)}\n\n${content}\n\n${page.slice(stop)}`;
}

/**
 * Every generated file with its expected content, and the problems that are
 * not about stale files (missing plugin pages, undocumented manifest fields).
 */
export function generatePluginDocs({ root = PLUGINS_ROOT, docs = DOCS_ROOT } = {}) {
  const problems = [];
  const { errors, plugins } = checkPlugins({ root });
  if (errors.length) problems.push(...errors.map(error => `plugins:check: ${error}`));
  const files = new Map();
  const reference = manifestReference();
  problems.push(...reference.problems);

  const authoringFile = path.join(docs, AUTHORING_PAGE);
  if (!existsSync(authoringFile)) problems.push(`${AUTHORING_PAGE} does not exist`);
  else {
    try {
      let page = readFileSync(authoringFile, 'utf8');
      page = replaceGeneratedBlock(page, 'manifest-reference', reference.text);
      page = replaceGeneratedBlock(page, 'event-payloads', eventPayloadReference());
      page = replaceGeneratedBlock(page, 'sdk-surface', sdkReference());
      files.set(authoringFile, page);
    } catch (error) { problems.push(`${AUTHORING_PAGE}: ${error.message}`); }
  }
  files.set(path.join(docs, CATALOG_PAGE), catalogPage(plugins));
  const official = plugins.filter(plugin => !plugin.development);
  files.set(path.join(docs, SIDEBAR_FILE), `${JSON.stringify(official.map(plugin => `plugins/${plugin.id}`), null, 2)}\n`);
  const schema = { title: `ProPR plugin manifest, version ${PLUGIN_MANIFEST_VERSION}`, ...pluginManifestJsonSchema() };
  files.set(path.join(docs, SCHEMA_FILE), `${JSON.stringify(schema, null, 2)}\n`);
  for (const plugin of official) {
    if (!existsSync(path.join(docs, 'docs/plugins', `${plugin.id}.md`))) problems.push(`${plugin.id}: the official plugin has no docs page docs/docs/plugins/${plugin.id}.md (npm run plugins:new creates one)`);
  }
  return { files, problems };
}

/** Files whose content differs from what they should be. */
export function staleFiles(files) {
  return [...files].filter(([file, content]) => !existsSync(file) || readFileSync(file, 'utf8') !== content).map(([file]) => file);
}

export function writePluginDocs(files) {
  const written = [];
  for (const file of staleFiles(files)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, files.get(file));
    written.push(file);
  }
  return written;
}

export function parseArguments(argv) {
  const options = { root: PLUGINS_ROOT, docs: DOCS_ROOT, check: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      return next;
    };
    if (argument === '--check') options.check = true;
    else if (argument === '--root') options.root = path.resolve(value());
    else if (argument === '--docs') options.docs = path.resolve(value());
    else throw new Error(`Unknown option ${argument}`);
  }
  return options;
}

function main(argv) {
  const options = parseArguments(argv);
  const { files, problems } = generatePluginDocs(options);
  const relative = file => path.relative(process.cwd(), file) || file;
  if (problems.length) {
    console.error(`Plugin docs cannot be generated (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  if (options.check) {
    const stale = staleFiles(files);
    if (stale.length) {
      console.error(`Plugin docs are out of date; run ${REGENERATE}:`);
      for (const file of stale) console.error(`  - ${relative(file)}`);
      return 1;
    }
    console.log(`Plugin docs are current (${files.size} files)`);
    return 0;
  }
  const written = writePluginDocs(files);
  for (const file of written) console.log(`Wrote ${relative(file)}`);
  if (!written.length) console.log('Plugin docs were already current');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
