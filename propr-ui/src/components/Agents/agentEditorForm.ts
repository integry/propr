import {
  DEFAULT_AUTOMATION_AUTONOMY_MODE,
  DEFAULT_AUTOMATION_CAPABILITIES,
  automationTemplateInput,
  type AutomationAutonomyMode,
  type AutomationTemplate,
  type AutomationCapability,
  type AutomationDefinitionInput,
  type PlanIssueBlockedReasonKind,
} from '@propr/shared';
import type { AutomationDefinitionRecord } from '../../api/automationDefinitionsApi';

/** The editor's working copy of a definition, shaped for its inputs. */
export interface AgentEditorForm {
  extensionProfile?: import('@propr/shared').ExtensionSelection | null;
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
  /** The `plan.issue_blocked` event trigger and its filters (empty: no filter). */
  blockedTrigger: boolean;
  blockedTriggerRepositories: string[];
  blockedTriggerReasonKinds: PlanIssueBlockedReasonKind[];
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
  blockedTrigger: false,
  blockedTriggerRepositories: [],
  blockedTriggerReasonKinds: [],
});

const blockedTriggerOf = (definition: AutomationDefinitionRecord) =>
  (definition.eventTriggers ?? []).find(trigger => trigger.event === 'plan.issue_blocked');

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
  extensionProfile: definition.extensionProfile,
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
  blockedTrigger: Boolean(blockedTriggerOf(definition)),
  blockedTriggerRepositories: [...(blockedTriggerOf(definition)?.repositories ?? [])],
  blockedTriggerReasonKinds: [...(blockedTriggerOf(definition)?.reasonKinds ?? [])],
});

const withinAutomation = (form: AgentEditorForm) => form.blockedTriggerRepositories.filter(repository =>
  form.repositories.some(candidate => candidate.toLowerCase() === repository.toLowerCase()));

/**
 * The trigger was limited to repositories that were all removed from the automation. An
 * empty filter means every repository of the automation, so dropping the stale entries would
 * silently start runs for repositories the user had excluded: the user has to choose again.
 */
export const eventTriggerFilterLost = (form: AgentEditorForm): boolean =>
  form.blockedTrigger && form.blockedTriggerRepositories.length > 0 && withinAutomation(form).length === 0;

export const EVENT_TRIGGER_FILTER_LOST_MESSAGE =
  'The event trigger was limited to repositories that are no longer in this automation. Choose the repositories it reacts to, or turn it off.';

/** The request body for a create or a full-form update, in the shared input contract. */
export const formToInput = (form: AgentEditorForm): AutomationDefinitionInput => ({
  ...(form.extensionProfile !== undefined ? { extensionProfile: form.extensionProfile } : {}),
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
  // The repository filter never reaches beyond the automation's own repositories. A filter
  // that lost every repository is sent as it was, so it is refused rather than widened to all.
  eventTriggers: form.blockedTrigger ? [{
    event: 'plan.issue_blocked',
    repositories: eventTriggerFilterLost(form) ? form.blockedTriggerRepositories : withinAutomation(form),
    reasonKinds: form.blockedTriggerReasonKinds,
  }] : [],
  pauseWhenUnproductive: form.pauseWhenUnproductive,
});
