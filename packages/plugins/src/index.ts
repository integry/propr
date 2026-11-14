import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPluginManifestIssues, pluginIdSchema, pluginManifestSchema, type PluginManifest } from '@propr/shared';

/**
 * The official plugins shipped with ProPR. Each plugin is a folder
 * `packages/plugins/<id>/` with a `manifest.json`, a `README.md` and the
 * assets its manifest names. `registry.json` lists the plugins in catalog
 * order; development plugins (examples and test fixtures) are left out
 * unless the development flag is set.
 */
export const PLUGIN_REGISTRY_VERSION = 1;
/** Set to `1` or `true` to include development plugins such as `example-pack`. */
export const PLUGIN_DEVELOPMENT_FLAG = 'PROPR_PLUGINS_DEVELOPMENT';
/** The registry package folder: the parent of `src/` and of `dist/`. */
export const PLUGINS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface PluginRegistryEntry {
  id: string;
  /** Hidden from the catalog unless the development flag is set. */
  development: boolean;
}

/** Absolute paths of the files a manifest names. */
export interface PluginAssets {
  manifest: string;
  readme: string;
  icon: string;
  skills: { name: string; path: string }[];
  automationTemplates: { id: string; path: string }[];
}

export interface OfficialPlugin {
  manifest: PluginManifest;
  development: boolean;
  /** The plugin folder. */
  directory: string;
  assets: PluginAssets;
}

/** The ordered plugin list of a registry root. Throws on a malformed `registry.json`. */
export function readPluginRegistryIndex(root = PLUGINS_ROOT): PluginRegistryEntry[] {
  const file = path.join(root, 'registry.json');
  const document = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; plugins?: unknown };
  if (document.version !== PLUGIN_REGISTRY_VERSION) throw new Error(`registry.json: version must be ${PLUGIN_REGISTRY_VERSION}`);
  if (!Array.isArray(document.plugins)) throw new Error('registry.json: plugins must be a list');
  return document.plugins.map((entry: unknown, index) => {
    const value = entry as { id?: unknown; development?: unknown } | null;
    const keys = value && typeof value === 'object' ? Object.keys(value) : [];
    if (!value || keys.some(key => key !== 'id' && key !== 'development')) throw new Error(`registry.json: plugins.${index} must be { id, development? }`);
    const id = pluginIdSchema.safeParse(value.id);
    if (!id.success) throw new Error(`registry.json: plugins.${index}.id is not a plugin id`);
    if (value.development !== undefined && typeof value.development !== 'boolean') throw new Error(`registry.json: plugins.${index}.development must be true or false`);
    return { id: id.data, development: value.development === true };
  });
}

/** Absolute asset paths of a plugin folder; nothing is checked for existence. */
export function resolvePluginAssets(directory: string, manifest: PluginManifest): PluginAssets {
  const at = (relative: string) => path.join(directory, ...relative.split('/'));
  return {
    manifest: path.join(directory, 'manifest.json'),
    readme: path.join(directory, 'README.md'),
    icon: at(manifest.icon),
    skills: manifest.contributes.skills.map(skill => ({ name: skill.name, path: at(skill.path) })),
    automationTemplates: manifest.contributes.automationTemplates.map(template => ({ id: template.id, path: at(template.path) })),
  };
}

/** Read and validate one plugin folder. Throws with every manifest problem. */
export function loadPlugin(root: string, entry: PluginRegistryEntry): OfficialPlugin {
  const directory = path.join(root, entry.id);
  const file = path.join(directory, 'manifest.json');
  if (!existsSync(file)) throw new Error(`${entry.id}: manifest.json is missing`);
  const result = pluginManifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!result.success) throw new Error(`${entry.id}/manifest.json: ${formatPluginManifestIssues(result.error).join('; ')}`);
  if (result.data.id !== entry.id) throw new Error(`${entry.id}/manifest.json: id ${result.data.id} must match the folder name`);
  return { manifest: result.data, development: entry.development, directory, assets: resolvePluginAssets(directory, result.data) };
}

export function pluginDevelopmentEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[PLUGIN_DEVELOPMENT_FLAG]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

export interface OfficialPluginOptions {
  /** Include development plugins; defaults to the development flag in the environment. */
  includeDevelopment?: boolean;
  /** A registry root other than this package, for tests. */
  root?: string;
}

const cache = new Map<string, OfficialPlugin[]>();

/** The official plugins in catalog order. Manifests are read once per root. */
export function officialPlugins(options: OfficialPluginOptions = {}): OfficialPlugin[] {
  const root = options.root ?? PLUGINS_ROOT;
  let plugins = cache.get(root);
  if (!plugins) {
    plugins = readPluginRegistryIndex(root).map(entry => loadPlugin(root, entry));
    cache.set(root, plugins);
  }
  const includeDevelopment = options.includeDevelopment ?? pluginDevelopmentEnabled();
  return plugins.filter(plugin => includeDevelopment || !plugin.development);
}

/** One official plugin by id, subject to the same development filter as the list. */
export function getOfficialPlugin(id: string, options: OfficialPluginOptions = {}): OfficialPlugin | undefined {
  return officialPlugins(options).find(plugin => plugin.manifest.id === id);
}
