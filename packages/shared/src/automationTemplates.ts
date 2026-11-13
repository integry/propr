/**
 * Shipped automation templates: prefilled starting points for the
 * new-automation form. The catalog is data, generated from
 * `packages/shared/automation-templates/<id>/` by
 * `scripts/generate-automation-templates.ts` and checked in CI against the
 * automation definition contract. A template creates nothing by itself: it
 * only fills the form, and the user saves the automation.
 */
import catalog from './automationTemplates.catalog.json' with { type: 'json' };
import { validateAutomationTemplateCatalog, type AutomationTemplate, type AutomationTemplateCatalog } from './automationTemplateContract.js';

export * from './automationTemplateContract.js';

function loadCatalog(document: unknown): AutomationTemplateCatalog {
  const error = validateAutomationTemplateCatalog(document);
  if (error) throw new Error(`Invalid automation template catalog: ${error}`);
  return document as AutomationTemplateCatalog;
}

export const AUTOMATION_TEMPLATE_CATALOG: Readonly<AutomationTemplateCatalog> = loadCatalog(catalog);
export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = AUTOMATION_TEMPLATE_CATALOG.templates;
export const AUTOMATION_TEMPLATES_BY_ID: ReadonlyMap<string, AutomationTemplate> = new Map(AUTOMATION_TEMPLATES.map(template => [template.id, template]));

export function getAutomationTemplate(id: unknown): AutomationTemplate | undefined {
  return typeof id === 'string' ? AUTOMATION_TEMPLATES_BY_ID.get(id) : undefined;
}
