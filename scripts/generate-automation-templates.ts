#!/usr/bin/env tsx
/**
 * Builds packages/shared/src/automationTemplates.catalog.json from the
 * template sources in packages/shared/automation-templates/<id>/:
 *
 *   template.json  every field except the prompt
 *   prompt.md      the prompt, verbatim
 *
 * Every template is validated against the automation definition contract.
 * `npm run automation-templates:generate` writes the catalog;
 * `npm run automation-templates:check` writes nothing and fails when the
 * committed catalog is stale or a template is invalid.
 */
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTOMATION_TEMPLATE_CATALOG_VERSION,
  validateAutomationTemplateCatalog,
  type AutomationTemplateCatalog,
} from '../packages/shared/src/automationTemplateContract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_SOURCE_DIR = path.join(root, 'packages/shared/automation-templates');
export const TEMPLATE_CATALOG_PATH = path.join(root, 'packages/shared/src/automationTemplates.catalog.json');
/** Catalog order: editorial, so the first entry is the one offered first. */
export const TEMPLATE_ORDER = ['daily-issue-triage', 'instruction-learning-loop'];

export async function generateAutomationTemplates(sourceDir = TEMPLATE_SOURCE_DIR, order = TEMPLATE_ORDER): Promise<AutomationTemplateCatalog> {
  const entries = (await readdir(sourceDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const unordered = entries.filter(id => !order.includes(id));
  if (unordered.length) throw new Error(`Templates missing from TEMPLATE_ORDER: ${unordered.join(', ')}`);
  const missing = order.filter(id => !entries.includes(id));
  if (missing.length) throw new Error(`TEMPLATE_ORDER names templates without a source directory: ${missing.join(', ')}`);
  const templates = [];
  for (const id of order) {
    const metadata = JSON.parse(await readFile(path.join(sourceDir, id, 'template.json'), 'utf8')) as Record<string, unknown>;
    if ('prompt' in metadata) throw new Error(`${id}: the prompt belongs in prompt.md, not template.json`);
    if (metadata.id !== id) throw new Error(`${id}: template.json id must match its directory`);
    const prompt = (await readFile(path.join(sourceDir, id, 'prompt.md'), 'utf8')).trim();
    const { reviewBeforeSaving, ...rest } = metadata;
    templates.push({ ...rest, prompt, reviewBeforeSaving });
  }
  const catalog = { version: AUTOMATION_TEMPLATE_CATALOG_VERSION, templates };
  const error = validateAutomationTemplateCatalog(catalog);
  if (error) throw new Error(`Invalid automation template: ${error}`);
  return catalog as AutomationTemplateCatalog;
}

export const renderCatalog = (catalog: AutomationTemplateCatalog) => `${JSON.stringify(catalog, null, 2)}\n`;

async function main(args: string[]): Promise<void> {
  const output = renderCatalog(await generateAutomationTemplates());
  if (args.includes('--check')) {
    const committed = await readFile(TEMPLATE_CATALOG_PATH, 'utf8').catch(() => null);
    if (committed !== output) {
      console.error('automationTemplates.catalog.json is out of date; run npm run automation-templates:generate');
      process.exitCode = 1;
      return;
    }
    console.log('Automation template catalog is up to date');
    return;
  }
  await writeFile(`${TEMPLATE_CATALOG_PATH}.tmp`, output);
  await rename(`${TEMPLATE_CATALOG_PATH}.tmp`, TEMPLATE_CATALOG_PATH);
  console.log(`Generated ${JSON.parse(output).templates.length} automation templates`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
