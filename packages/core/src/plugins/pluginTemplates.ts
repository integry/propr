import type { Knex } from 'knex';
import { AUTOMATION_TEMPLATE_CATALOG, type AutomationTemplate, type AutomationTemplateCatalog, type PluginManifest } from '@propr/shared';
import logger from '../utils/logger.js';
import { officialPluginAssets, type PluginAssetSource } from './pluginAssets.js';
import { officialPluginCatalog, type PluginCatalogSource } from './pluginCatalog.js';

/**
 * Catalog ids of plugin automation templates, by plugin and template id. A
 * template keeps its own id unless a shipped template or a template of
 * another plugin in the registry uses it; then it is prefixed with its plugin
 * id, and a prefixed id that is itself a shipped or plugin template id, or
 * an id already allocated, gets a `-2`, `-3`, … suffix. Allocated ids are
 * unique across the shipped templates and every plugin template. The rule
 * depends on the registry (and its order) only, so an id stays stable
 * whichever plugins are enabled.
 */
export function pluginTemplateIds(manifests: readonly PluginManifest[]): Map<string, Map<string, string>> {
  const counts = new Map<string, number>();
  for (const template of AUTOMATION_TEMPLATE_CATALOG.templates) counts.set(template.id, 2);
  for (const manifest of manifests) for (const template of manifest.contributes.automationTemplates) counts.set(template.id, (counts.get(template.id) ?? 0) + 1);
  // Every original id is reserved: a generated id never equals a shipped or plugin template's own id.
  const taken = new Set(counts.keys());
  const allocate = (base: string) => {
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
    taken.add(candidate);
    return candidate;
  };
  return new Map(manifests.map(manifest => [manifest.id, new Map(manifest.contributes.automationTemplates.map(t => [t.id, counts.get(t.id) === 1 ? t.id : allocate(`${manifest.id}-${t.id}`)]))]));
}

/** Ids of the installed plugins that are enabled. */
export async function enabledPluginIds(database: Knex): Promise<Set<string>> {
  if (!await database.schema.hasTable('plugin_installations')) return new Set();
  const rows = await database('plugin_installations').where({ enabled: true }).select('plugin_id');
  return new Set(rows.map(row => row.plugin_id as string));
}

/**
 * The automation template catalog: the shipped templates, then those of
 * enabled plugins, marked with the plugin's id and name. A disabled or
 * uninstalled plugin's templates are left out; automations created from them
 * are ordinary automations and stay. A template that cannot be read is left
 * out with a warning; the catalog itself never fails because of a plugin.
 */
export async function automationTemplateCatalog(database: Knex, catalog: PluginCatalogSource = officialPluginCatalog, assets: PluginAssetSource = officialPluginAssets): Promise<AutomationTemplateCatalog> {
  const templates: AutomationTemplate[] = [...AUTOMATION_TEMPLATE_CATALOG.templates];
  let enabled: Set<string>;
  try { enabled = await enabledPluginIds(database); } catch { return { ...AUTOMATION_TEMPLATE_CATALOG, templates }; }
  if (!enabled.size) return { ...AUTOMATION_TEMPLATE_CATALOG, templates };
  const manifests = await catalog();
  const ids = pluginTemplateIds(manifests);
  for (const manifest of manifests.filter(m => enabled.has(m.id))) {
    for (const entry of manifest.contributes.automationTemplates) {
      try {
        const template = await assets.automationTemplate(manifest, entry.path);
        templates.push({ ...template, id: ids.get(manifest.id)?.get(entry.id) ?? entry.id, plugin: { id: manifest.id, name: manifest.name } });
      } catch {
        logger.warn({ pluginId: manifest.id, template: entry.id }, '[plugins] Automation template unavailable; left out of the catalog');
      }
    }
  }
  return { ...AUTOMATION_TEMPLATE_CATALOG, templates };
}
