import {
  DEFAULT_AUTOMATION_AUTONOMY_MODE,
  DEFAULT_AUTOMATION_CAPABILITIES,
  automationTemplateInput,
  type AutomationAutonomyMode,
  type AutomationTemplate,
  type AutomationCapability,
  type AutomationDefinitionInput,
  type AutomationExtensions,
} from '@propr/shared';
import type { AutomationDefinitionRecord } from '../../api/automationDefinitionsApi';

/** The editor's working copy of a definition, shaped for its inputs. */
export interface AgentEditorForm {
  /**
   * Library items the automation adds, set only once the user changes them so
   * an edit by someone who cannot manage extensions never sends the field.
   * Undefined keeps the definition's saved items.
   */
  extensions?: AutomationExtensions;
  name: string;
  description: string;
  repositories: string[];
  prompt: string;
  previousReportCount: number;
  agentId: string | null;
  model: string | null;
  capabilities: AutomationCapability[];
  /** Kept while the schedule is off, so turning it back on restores the expression. */
  schedule: string;
  scheduleEnabled: boolean;
  /** Turn the schedule off when the owner is told about repeated runs that produced nothing. */
  pauseWhenUnproductive: boolean;
  autonomy: AutomationAutonomyMode;
}

export type AgentEditorFormPatch = Partial<AgentEditorForm>;

export const emptyAgentForm = (): AgentEditorForm => ({
  name: '',
  description: '',
  repositories: [],
  prompt: '',
  previousReportCount: 0,
  agentId: null,
  model: null,
  capabilities: [...DEFAULT_AUTOMATION_CAPABILITIES],
  schedule: '',
  scheduleEnabled: false,
  pauseWhenUnproductive: false,
  autonomy: DEFAULT_AUTOMATION_AUTONOMY_MODE,
});

/**
 * A template's fields laid over a form. Repositories, the coding agent and the
 * extension profile the user already chose are kept; everything the template
 * suggests replaces what was there. Autonomy is always the template's dry run.
 */
export const formFromTemplate = (template: AutomationTemplate, current: AgentEditorForm = emptyAgentForm()): AgentEditorForm => {
  const input = automationTemplateInput(template);
  return {
    ...current,
    name: input.name,
    description: input.description ?? '',
    prompt: input.prompt,
    capabilities: [...(input.capabilities ?? DEFAULT_AUTOMATION_CAPABILITIES)],
    schedule: input.schedule ?? '',
    scheduleEnabled: Boolean(input.schedule),
    autonomy: input.autonomy ?? DEFAULT_AUTOMATION_AUTONOMY_MODE,
    previousReportCount: input.previousReportCount ?? 0,
  };
};

export const formFromDefinition = (definition: AutomationDefinitionRecord): AgentEditorForm => ({
  name: definition.name,
  description: definition.description ?? '',
  repositories: [...definition.repositories],
  prompt: definition.prompt,
  previousReportCount: definition.includePreviousReports ? definition.previousReportsLimit : 0,
  agentId: definition.agentAlias,
  model: definition.modelName,
  capabilities: [...definition.capabilities],
  schedule: definition.scheduleCron ?? '',
  scheduleEnabled: definition.scheduleEnabled && Boolean(definition.scheduleCron),
  pauseWhenUnproductive: definition.pauseWhenUnproductive ?? false,
  autonomy: definition.autonomyMode,
});

/** The request body for a create or a full-form update, in the shared input contract. */
export const formToInput = (form: AgentEditorForm): AutomationDefinitionInput => ({
  ...(form.extensions !== undefined ? { extensions: form.extensions } : {}),
  name: form.name.trim(),
  description: form.description.trim() || null,
  prompt: form.prompt,
  repositories: form.repositories,
  capabilities: form.capabilities,
  autonomy: form.autonomy,
  schedule: form.scheduleEnabled ? form.schedule.trim() : null,
  agentId: form.agentId,
  model: form.agentId ? form.model : null,
  previousReportCount: form.previousReportCount,
  pauseWhenUnproductive: form.pauseWhenUnproductive,
});
