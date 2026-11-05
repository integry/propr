import {
  DEFAULT_AUTOMATION_AUTONOMY_MODE,
  DEFAULT_AUTOMATION_CAPABILITIES,
  type AutomationAutonomyMode,
  type AutomationCapability,
  type AutomationDefinitionInput,
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
  autonomy: DEFAULT_AUTOMATION_AUTONOMY_MODE,
});

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
  autonomy: definition.autonomyMode,
});

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
});
