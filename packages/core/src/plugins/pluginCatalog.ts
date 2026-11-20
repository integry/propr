import type { PluginManifest } from '@propr/shared';
import logger from '../utils/logger.js';

/** The plugins this ProPR offers, in catalog order. */
export type PluginCatalogSource = () => Promise<readonly PluginManifest[]>;

interface PluginRegistryModule { officialPlugins(): { manifest: PluginManifest }[] }
// Not a literal import: Core stays buildable and runnable where the registry
// package is not part of the image; the catalog is then empty.
const REGISTRY_MODULE = '@propr/plugins';
let warned = false;

/** The official plugin registry (`@propr/plugins`), subject to its development flag. */
export const officialPluginCatalog: PluginCatalogSource = async () => {
  try {
    const registry = await import(REGISTRY_MODULE) as PluginRegistryModule;
    return registry.officialPlugins().map(plugin => plugin.manifest);
  } catch (error) {
    if (!warned) { warned = true; logger.warn({ error: error instanceof Error ? error.message : String(error) }, '[plugins] Official plugin registry unavailable; no plugins are offered'); }
    return [];
  }
};
