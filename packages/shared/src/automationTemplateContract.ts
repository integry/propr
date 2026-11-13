/**
 * The automation template contract: shape and validation of a shipped
 * template, checked against the automation definition contract. Kept apart
 * from the catalog loader so the generator can validate a catalog that is not
 * committed yet.
 */
import {
  AUTOMATION_DESCRIPTION_MAX_LENGTH,
  DEFAULT_AUTOMATION_AUTONOMY_MODE,
  validateAutomationDefinitionInput,
  type AutomationAutonomyMode,
  type AutomationCapability,
  type AutomationDefinitionInput,
} from './automationDefinitions.js';

/** Version of the catalog document. Bump only on breaking shape changes. */
export const AUTOMATION_TEMPLATE_CATALOG_VERSION = 1;

export const AUTOMATION_TEMPLATE_CATEGORIES = ['triage', 'maintenance', 'reporting', 'research'] as const;
export type AutomationTemplateCategory = typeof AUTOMATION_TEMPLATE_CATEGORIES[number];

/** Form fields a user must look at before saving an automation started from a template. */
export const AUTOMATION_TEMPLATE_REVIEW_FIELDS = ['repositories', 'schedule', 'autonomy', 'agent', 'capabilities'] as const;
export type AutomationTemplateReviewField = typeof AUTOMATION_TEMPLATE_REVIEW_FIELDS[number];
/** Every template must ask for these to be reviewed. */
export const REQUIRED_AUTOMATION_TEMPLATE_REVIEW_FIELDS: readonly AutomationTemplateReviewField[] = ['repositories', 'schedule', 'autonomy'];

/** Templates always start report-only; acting needs the user to raise the mode. */
export const AUTOMATION_TEMPLATE_AUTONOMY_MODE: AutomationAutonomyMode = DEFAULT_AUTOMATION_AUTONOMY_MODE;

export const AUTOMATION_TEMPLATE_SHORT_DESCRIPTION_MAX_LENGTH = 200;
export const AUTOMATION_TEMPLATE_REVIEW_NOTE_MAX_LENGTH = 300;
const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface AutomationTemplateReviewItem {
  field: AutomationTemplateReviewField;
  note: string;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  /** Short description, shown in pickers and saved as the automation's description. */
  description: string;
  category: AutomationTemplateCategory;
  prompt: string;
  capabilities: AutomationCapability[];
  /** Suggested 5-field cron expression or macro, evaluated in UTC. */
  schedule: string;
  /** Always `dry_run`. */
  autonomy: AutomationAutonomyMode;
  previousReportCount: number;
  /** What the user must review before saving. */
  reviewBeforeSaving: AutomationTemplateReviewItem[];
}

export interface AutomationTemplateCatalog {
  version: number;
  templates: AutomationTemplate[];
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** The definition input a template prefills; repositories are always left for the user to choose. */
export function automationTemplateInput(template: AutomationTemplate): AutomationDefinitionInput {
  return {
    name: template.name,
    description: template.description,
    prompt: template.prompt,
    repositories: [],
    capabilities: [...template.capabilities],
    autonomy: AUTOMATION_TEMPLATE_AUTONOMY_MODE,
    schedule: template.schedule,
    previousReportCount: template.previousReportCount,
  };
}

/**
 * Validate one template: its own shape, and that the definition it prefills
 * satisfies the automation definition contract. Returns an error or null.
 */
export function validateAutomationTemplate(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'template must be an object';
  const template = value as Record<string, unknown>;
  const label = isString(template.id) ? template.id : '(no id)';
  const allowed = new Set(['id', 'name', 'description', 'category', 'prompt', 'capabilities', 'schedule', 'autonomy', 'previousReportCount', 'reviewBeforeSaving']);
  const unknown = Object.keys(template).find(key => !allowed.has(key));
  if (unknown) return `${label}: unknown field ${unknown}`;
  if (!isString(template.id) || !TEMPLATE_ID_PATTERN.test(template.id)) return `${label}: id must be kebab-case`;
  if (!isString(template.description) || !template.description.trim()) return `${label}: description is required`;
  if (template.description.length > Math.min(AUTOMATION_TEMPLATE_SHORT_DESCRIPTION_MAX_LENGTH, AUTOMATION_DESCRIPTION_MAX_LENGTH)) {
    return `${label}: description must be at most ${AUTOMATION_TEMPLATE_SHORT_DESCRIPTION_MAX_LENGTH} characters`;
  }
  if (!AUTOMATION_TEMPLATE_CATEGORIES.includes(template.category as AutomationTemplateCategory)) {
    return `${label}: category must be one of: ${AUTOMATION_TEMPLATE_CATEGORIES.join(', ')}`;
  }
  if (template.autonomy !== AUTOMATION_TEMPLATE_AUTONOMY_MODE) return `${label}: autonomy must be ${AUTOMATION_TEMPLATE_AUTONOMY_MODE}`;
  if (!isString(template.schedule) || !template.schedule.trim()) return `${label}: a suggested schedule is required`;
  if (!Array.isArray(template.capabilities) || template.capabilities.length === 0) return `${label}: capabilities must be a non-empty array`;
  if (!Number.isSafeInteger(template.previousReportCount)) return `${label}: previousReportCount must be an integer`;

  const review = template.reviewBeforeSaving;
  if (!Array.isArray(review)) return `${label}: reviewBeforeSaving must be an array`;
  const fields = new Set<string>();
  for (const item of review) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => key !== 'field' && key !== 'note')) {
      return `${label}: reviewBeforeSaving entries must be { field, note }`;
    }
    const { field, note } = item as Record<string, unknown>;
    if (!AUTOMATION_TEMPLATE_REVIEW_FIELDS.includes(field as AutomationTemplateReviewField)) {
      return `${label}: review field must be one of: ${AUTOMATION_TEMPLATE_REVIEW_FIELDS.join(', ')}`;
    }
    if (fields.has(field as string)) return `${label}: duplicate review field ${String(field)}`;
    fields.add(field as string);
    if (!isString(note) || !note.trim() || note.length > AUTOMATION_TEMPLATE_REVIEW_NOTE_MAX_LENGTH) {
      return `${label}: review note for ${String(field)} must be 1 to ${AUTOMATION_TEMPLATE_REVIEW_NOTE_MAX_LENGTH} characters`;
    }
  }
  const missing = REQUIRED_AUTOMATION_TEMPLATE_REVIEW_FIELDS.find(field => !fields.has(field));
  if (missing) return `${label}: reviewBeforeSaving must include ${missing}`;

  const contractError = validateAutomationDefinitionInput(automationTemplateInput(value as AutomationTemplate));
  return contractError ? `${label}: ${contractError}` : null;
}

/** Validate a whole catalog document: version, templates and unique ids and names. */
export function validateAutomationTemplateCatalog(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'catalog must be an object';
  const document = value as Record<string, unknown>;
  if (document.version !== AUTOMATION_TEMPLATE_CATALOG_VERSION) return `catalog version must be ${AUTOMATION_TEMPLATE_CATALOG_VERSION}`;
  if (!Array.isArray(document.templates) || document.templates.length === 0) return 'catalog must list at least one template';
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const template of document.templates) {
    const error = validateAutomationTemplate(template);
    if (error) return error;
    const { id, name } = template as AutomationTemplate;
    if (ids.has(id)) return `duplicate template id ${id}`;
    if (names.has(name.toLowerCase())) return `duplicate template name ${name}`;
    ids.add(id);
    names.add(name.toLowerCase());
  }
  return null;
}
