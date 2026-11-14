#!/usr/bin/env tsx
/**
 * Validates the official plugin registry in packages/plugins:
 *
 *   - registry.json lists every plugin folder exactly once, and only those;
 *   - every manifest.json passes the plugin manifest schema of @propr/shared
 *     (which also checks connection references and exact package pins) and
 *     its id matches its folder;
 *   - command names are unique across all plugins;
 *   - the README, the icon, every skill folder (with a SKILL.md naming the
 *     skill) and every automation template folder exist, and the templates
 *     pass the automation template contract.
 *
 * `npm run plugins:check` runs it; CI runs it on every pull request.
 * `--online` (never run in CI) also compares each package server's recorded
 * integrity value with the npm registry (`--registry <url>` or
 * `npm_config_registry`, default https://registry.npmjs.org). `--root <dir>`
 * checks another registry folder, for the script's own tests.
 *
 * Runs under tsx: it imports the TypeScript sources so no build is needed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_PLUGIN_IDS, parsePluginManifest, pluginIdSchema } from '../packages/shared/src/plugins.js';
import { validateAutomationTemplate } from '../packages/shared/src/automationTemplateContract.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGINS_ROOT = path.join(repositoryRoot, 'packages/plugins');
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

const isFile = file => existsSync(file) && statSync(file).isFile();
const isDirectory = file => existsSync(file) && statSync(file).isDirectory();
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const asset = (directory, relative) => path.join(directory, ...relative.split('/'));

/** Entries of registry.json, or the errors that make it unusable. */
function readIndex(root, errors) {
  const file = path.join(root, 'registry.json');
  if (!isFile(file)) { errors.push('registry.json is missing'); return []; }
  let document;
  try { document = readJson(file); } catch (error) { errors.push(`registry.json is not valid JSON: ${error.message}`); return []; }
  if (document?.version !== 1) errors.push('registry.json: version must be 1');
  if (!Array.isArray(document?.plugins)) { errors.push('registry.json: plugins must be a list'); return []; }
  const entries = [];
  document.plugins.forEach((entry, index) => {
    const keys = entry && typeof entry === 'object' ? Object.keys(entry) : null;
    if (!keys || keys.some(key => key !== 'id' && key !== 'development') || !pluginIdSchema.safeParse(entry.id).success
      || (entry.development !== undefined && typeof entry.development !== 'boolean')) {
      errors.push(`registry.json: plugins.${index} must be { "id": "<plugin id>", "development"?: true | false }`);
      return;
    }
    if (entries.some(e => e.id === entry.id)) errors.push(`registry.json: plugin ${entry.id} is listed more than once`);
    else entries.push({ id: entry.id, development: entry.development === true });
  });
  return entries;
}

/** The `name:` of a SKILL.md front matter, or null without one. */
function skillName(markdown) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!front) return null;
  const name = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(front[1]);
  return name && /^description:\s*\S/m.test(front[1]) ? name[1] : null;
}

function checkAssets(id, directory, manifest, errors) {
  if (!isFile(asset(directory, manifest.icon))) errors.push(`${id}: icon ${manifest.icon} does not exist in the plugin folder`);
  for (const skill of manifest.contributes.skills) {
    const folder = asset(directory, skill.path);
    if (!isDirectory(folder)) { errors.push(`${id}: skill ${skill.name}: folder ${skill.path} does not exist`); continue; }
    const file = path.join(folder, 'SKILL.md');
    if (!isFile(file)) { errors.push(`${id}: skill ${skill.name}: ${skill.path}/SKILL.md does not exist`); continue; }
    const name = skillName(readFileSync(file, 'utf8'));
    if (name === null) errors.push(`${id}: skill ${skill.name}: ${skill.path}/SKILL.md needs front matter with name and description`);
    else if (name !== skill.name) errors.push(`${id}: skill ${skill.name}: SKILL.md is named ${name}`);
  }
  for (const template of manifest.contributes.automationTemplates) {
    const folder = asset(directory, template.path);
    const metadataFile = path.join(folder, 'template.json');
    const promptFile = path.join(folder, 'prompt.md');
    if (!isFile(metadataFile) || !isFile(promptFile)) { errors.push(`${id}: automation template ${template.id}: ${template.path} needs template.json and prompt.md`); continue; }
    let metadata;
    try { metadata = readJson(metadataFile); } catch (error) { errors.push(`${id}: automation template ${template.id}: template.json is not valid JSON: ${error.message}`); continue; }
    if (metadata && typeof metadata === 'object' && 'prompt' in metadata) { errors.push(`${id}: automation template ${template.id}: the prompt belongs in prompt.md`); continue; }
    if (metadata?.id !== template.id) errors.push(`${id}: automation template ${template.id}: template.json id must be ${template.id}`);
    const error = validateAutomationTemplate({ ...metadata, prompt: readFileSync(promptFile, 'utf8').trim() });
    if (error) errors.push(`${id}: automation template ${template.id}: ${error}`);
  }
}

/**
 * Check a registry folder. Returns every problem found, so one run reports
 * them all, and the plugins whose manifests parsed.
 */
export function checkPlugins({ root = PLUGINS_ROOT } = {}) {
  const errors = [];
  const entries = readIndex(root, errors);
  const folders = existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !RESERVED_PLUGIN_IDS.includes(entry.name))
    .map(entry => entry.name) : [];
  for (const folder of folders) if (!entries.some(e => e.id === folder)) errors.push(`${folder}: folder is not listed in registry.json`);

  const plugins = [];
  const commands = new Map();
  for (const entry of entries) {
    const directory = path.join(root, entry.id);
    const readme = path.join(directory, 'README.md');
    if (isDirectory(directory) && (!isFile(readme) || !readFileSync(readme, 'utf8').trim())) errors.push(`${entry.id}: README.md is missing or empty`);
    const file = path.join(directory, 'manifest.json');
    if (!isFile(file)) { errors.push(`${entry.id}: manifest.json does not exist`); continue; }
    let value;
    try { value = readJson(file); } catch (error) { errors.push(`${entry.id}/manifest.json is not valid JSON: ${error.message}`); continue; }
    const result = parsePluginManifest(value);
    if (!result.ok) { for (const message of result.errors) errors.push(`${entry.id}/manifest.json: ${message}`); continue; }
    const { manifest } = result;
    if (manifest.id !== entry.id) errors.push(`${entry.id}/manifest.json: id ${manifest.id} must match the folder name ${entry.id}`);
    checkAssets(entry.id, directory, manifest, errors);
    for (const command of manifest.contributes.commands) {
      const owner = commands.get(command.name);
      if (owner && owner !== entry.id) errors.push(`${entry.id}: command ${command.name} is also contributed by ${owner}`);
      else commands.set(command.name, entry.id);
    }
    plugins.push({ ...entry, directory, manifest });
  }
  return { errors, plugins };
}

/** Compare each package server's recorded integrity with the registry's. Returns problems. */
export async function checkPackageIntegrity(plugins, { registry = DEFAULT_NPM_REGISTRY, fetch: fetchImpl = globalThis.fetch } = {}) {
  const errors = [];
  for (const plugin of plugins) {
    for (const server of plugin.manifest.contributes.mcpServers) {
      if (server.kind !== 'package') continue;
      const label = `${plugin.id}: server ${server.name} (${server.package}@${server.version})`;
      const url = `${registry.replace(/\/+$/, '')}/${server.package.replace('/', '%2f')}/${encodeURIComponent(server.version)}`;
      try {
        const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        if (response.status === 404) { errors.push(`${label}: not found on ${registry}`); continue; }
        if (!response.ok) { errors.push(`${label}: registry answered ${response.status}`); continue; }
        const integrity = (await response.json())?.dist?.integrity;
        if (integrity !== server.integrity) errors.push(`${label}: recorded integrity does not match the registry (${integrity ?? 'none'})`);
      } catch (error) {
        errors.push(`${label}: registry request failed: ${error.message}`);
      }
    }
  }
  return errors;
}

export function parseArguments(argv) {
  const options = { root: PLUGINS_ROOT, online: false, registry: process.env.npm_config_registry || DEFAULT_NPM_REGISTRY };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      return next;
    };
    if (argument === '--online') options.online = true;
    else if (argument === '--root') options.root = path.resolve(value());
    else if (argument === '--registry') options.registry = value();
    else throw new Error(`Unknown option ${argument}`);
  }
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  const { errors, plugins } = checkPlugins({ root: options.root });
  if (options.online && !errors.length) errors.push(...await checkPackageIntegrity(plugins, { registry: options.registry }));
  if (errors.length) {
    console.error(`Plugin check failed (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${plugins.length} plugin${plugins.length === 1 ? '' : 's'} checked${options.online ? ' (with registry integrity)' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
