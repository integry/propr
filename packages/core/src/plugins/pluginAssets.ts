import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { EXTENSION_LIMITS, validateAutomationTemplate, type AutomationTemplate, type PluginManifest } from '@propr/shared';
import type { SkillFile } from '../extensions/skillBundles.js';

/**
 * Files an official plugin ships next to its manifest: skill folders and
 * automation templates. Read from the plugin folder of the registry package;
 * nothing in them is executed.
 */
export interface PluginAssetSource {
  /** The files of a skill folder (`path` from the manifest), base64-encoded, relative to the folder. */
  skillFiles(manifest: PluginManifest, skillPath: string): Promise<SkillFile[]>;
  /** One automation template in the shipped format (`template.json` + `prompt.md`), validated. */
  automationTemplate(manifest: PluginManifest, templatePath: string): Promise<AutomationTemplate>;
}

interface PluginRegistryModule { officialPlugins(options?: { includeDevelopment?: boolean }): { manifest: PluginManifest; directory: string }[] }
const REGISTRY_MODULE = '@propr/plugins';

/** A file or folder inside `directory`; manifest paths are already relative without `..`, checked again here. */
function inside(directory: string, relative: string): string {
  const target = path.resolve(directory, ...relative.split('/'));
  if (target !== directory && !target.startsWith(directory + path.sep)) throw new Error('Plugin asset outside its folder');
  return target;
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Links are never followed: a skill is the regular files of its folder.
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    if (files.length > EXTENSION_LIMITS.files) throw new Error('Plugin skill folder has too many files');
  }
  return files;
}

/** Assets of plugin folders found by `directoryOf`. */
export function pluginFolderAssets(directoryOf: (manifest: PluginManifest) => Promise<string>): PluginAssetSource {
  return {
    async skillFiles(manifest, skillPath) {
      const folder = inside(await directoryOf(manifest), skillPath);
      if (!(await lstat(folder)).isDirectory()) throw new Error('Plugin skill folder unavailable');
      const files: SkillFile[] = [];
      for (const relative of await listFiles(folder)) files.push({ path: relative, content: (await readFile(path.join(folder, ...relative.split('/')))).toString('base64') });
      return files;
    },
    async automationTemplate(manifest, templatePath) {
      const folder = inside(await directoryOf(manifest), templatePath);
      const metadata = JSON.parse(await readFile(path.join(folder, 'template.json'), 'utf8')) as Record<string, unknown>;
      const template = { ...metadata, prompt: (await readFile(path.join(folder, 'prompt.md'), 'utf8')).trim() };
      const error = 'prompt' in metadata ? 'the prompt belongs in prompt.md' : validateAutomationTemplate(template);
      if (error) throw new Error(`Plugin automation template invalid: ${error}`);
      return template as AutomationTemplate;
    },
  };
}

/** Assets of the official registry (`@propr/plugins`): the folder of the registry plugin with the manifest's id. */
export const officialPluginAssets: PluginAssetSource = pluginFolderAssets(async manifest => {
  const registry = await import(REGISTRY_MODULE) as PluginRegistryModule;
  // Assets are read only for plugins the catalog offered; the development filter applied there.
  const plugin = registry.officialPlugins({ includeDevelopment: true }).find(p => p.manifest.id === manifest.id);
  if (!plugin) throw new Error('Plugin folder unavailable');
  return plugin.directory;
});
