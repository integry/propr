import { AdditionalExtensionsSelector } from '../Extensions/AdditionalExtensionsSelector';
import React, { useEffect } from 'react';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { AUTOMATION_DESCRIPTION_MAX_LENGTH, AUTOMATION_NAME_MAX_LENGTH, EMPTY_AUTOMATION_EXTENSIONS, type AutomationExtensions, type AutomationTemplate } from '@propr/shared';
import { AgentModelSelector } from '../TaskPlanner/AgentModelSelector';
import { AGENT_INPUT_CLASSES, AGENT_INVALID_INPUT_CLASSES, AgentFormRow } from './AgentFormRow';
import { agentFieldErrorId, focusAgentField, type AgentFormField } from './agentFormValidation';
import { useUnproductiveRunThreshold } from './useUnproductiveRunThreshold';
import { useDiscardConfirmation } from '../ui/useDiscardConfirmation';
import { AgentScopeSection } from './AgentScopeSection';
import { AgentPromptSection } from './AgentPromptSection';
import { AgentCapabilitiesSection } from './AgentCapabilitiesSection';
import { AgentScheduleSection } from './AgentScheduleSection';
import { AgentEventTriggerSection } from './AgentEventTriggerSection';
import { AgentAutonomySection } from './AgentAutonomySection';
import { AgentTemplatePicker, AgentTemplateReview } from './AgentTemplates';
import { BUTTON_CLASSES } from './AgentEditorHeader';
import { agentDisplayName, defaultRunner } from './agentPresentation';
import type { useAgentEditor } from './useAgentEditor';

interface AgentSettingsFormProps {
  editor: ReturnType<typeof useAgentEditor>;
  /** A new automation is created rather than saved. */
  isNew: boolean;
  /** Demo mode or a save in flight. */
  readOnly: boolean;
  isDemoMode: boolean;
  /** Hidden rather than unmounted while another tab shows, so unsaved edits survive. */
  hidden: boolean;
  onDelete: () => void;
}

/** Create automation or Save changes, at the bottom of the form like the task and goal forms. */
const AgentSaveFooter: React.FC<{ isNew: boolean; saving: boolean; disabled: boolean }> = ({ isNew, saving, disabled }) => {
  const icon = isNew ? <Plus className="h-4 w-4" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />;
  return (
    <div className="flex flex-none justify-end gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3" data-testid="agent-editor-footer">
      <button type="submit" disabled={disabled} className={`${BUTTON_CLASSES} bg-teal-600 text-white hover:bg-teal-700`}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : icon}
        {isNew ? 'Create automation' : 'Save changes'}
      </button>
    </div>
  );
};

const sameExtensions = (left: AutomationExtensions, right: AutomationExtensions | undefined) => {
  const key = (value: AutomationExtensions | undefined) => JSON.stringify([[...(value?.servers ?? [])].sort(), [...(value?.skills ?? [])].sort()]);
  return key(left) === key(right);
};

/** The repositories and agent an automation runs with, for the additional-extensions limits. */
const extensionTarget = (editor: ReturnType<typeof useAgentEditor>) => {
  const agentAlias = editor.form.agentId ?? editor.defaultAgentAlias;
  return { repositories: editor.form.repositories, agentAlias, agentType: editor.agents.find(agent => agent.alias === agentAlias)?.type ?? null };
};

/** The agent's settings: scope, prompt and files, model, capabilities, schedule and autonomy. */
/** A field's error props: the message for the row, and what its control needs to point at it. */
const invalidProps = (error: string | undefined, field: AgentFormField) => ({
  'aria-invalid': error ? true : undefined,
  'aria-describedby': error ? agentFieldErrorId(field) : undefined,
});

export const AgentSettingsForm: React.FC<AgentSettingsFormProps> = ({ editor, isNew, readOnly, isDemoMode, hidden, onDelete }) => {
  const { definition, form, update, fieldErrors, invalidFocus } = editor;
  const runner = defaultRunner(editor.agents, editor.defaultAgentAlias);
  const unproductiveRunThreshold = useUnproductiveRunThreshold();
  const { confirmDiscard, dialog: templateDialog } = useDiscardConfirmation();

  // A refused save brings the first field to fix into view, once its error has rendered.
  useEffect(() => {
    if (invalidFocus) focusAgentField(invalidFocus.field);
  }, [invalidFocus]);

  /** Filling the form from a template over typed input asks first. */
  const chooseTemplate = (template: AutomationTemplate) => {
    if (!editor.templateWouldOverwrite) { editor.applyTemplate(template); return; }
    confirmDiscard({
      title: `Replace what you entered with “${template.name}”?`,
      message: 'The name, prompt, schedule and other settings the template sets are replaced. Repositories and the coding agent stay.',
      confirmLabel: 'Use template',
    }, () => editor.applyTemplate(template));
  };

  return (
  <form
    id="agent-editor-form"
    noValidate
    onSubmit={event => { event.preventDefault(); if (!readOnly && !editor.conflict) void editor.save(); }}
    hidden={hidden}
    className={`min-h-0 flex-1 flex-col ${hidden ? '' : 'flex'}`}
  >
    <div className="min-h-0 flex-1 overflow-y-auto">
      {isNew && editor.template && <AgentTemplateReview template={editor.template} />}
      {isNew && <AgentTemplatePicker selectedId={editor.template?.id ?? null} onSelect={chooseTemplate} disabled={readOnly} />}
      <fieldset disabled={readOnly} className="min-w-0">
        <AgentFormRow label="Name" htmlFor="agent-name" hint="Shown in the list and in run notifications." error={fieldErrors.name} errorId={agentFieldErrorId('name')}>
          <input
            id="agent-name"
            value={form.name}
            maxLength={AUTOMATION_NAME_MAX_LENGTH}
            onChange={event => update({ name: event.target.value })}
            placeholder="Weekly dependency review"
            className={fieldErrors.name ? AGENT_INVALID_INPUT_CLASSES : AGENT_INPUT_CLASSES}
            {...invalidProps(fieldErrors.name, 'name')}
          />
        </AgentFormRow>
        <AgentFormRow label="Description" htmlFor="agent-description" hint="Optional. What this automation is for.">
          <input
            id="agent-description"
            value={form.description}
            maxLength={AUTOMATION_DESCRIPTION_MAX_LENGTH}
            onChange={event => update({ description: event.target.value })}
            className={AGENT_INPUT_CLASSES}
          />
        </AgentFormRow>

        <div className="px-4 py-4 empty:hidden">
          <AdditionalExtensionsSelector
            value={form.extensions ?? definition?.extensions ?? EMPTY_AUTOMATION_EXTENSIONS}
            target={extensionTarget(editor)}
            onChange={extensions => update({ extensions: sameExtensions(extensions, definition?.extensions) ? undefined : extensions })}
            disabled={readOnly}
          />
        </div>
        <AgentScopeSection repositories={form.repositories} onChange={repositories => update({ repositories })} disabled={readOnly} />

        <AgentPromptSection
          prompt={form.prompt}
          onPromptChange={prompt => update({ prompt })}
          previousReportCount={form.previousReportCount}
          onPreviousReportCountChange={previousReportCount => update({ previousReportCount })}
          attachments={definition ? definition.attachments : null}
          onUpload={editor.upload}
          onRemoveAttachment={editor.removeAttachment}
          disabled={readOnly}
          error={fieldErrors.prompt}
        />

        <AgentFormRow label="Coding agent" hint="The agent and model that write the report.">
          <AgentModelSelector
            agents={editor.agents}
            selectedAgent={form.agentId}
            selectedModel={form.model}
            onAgentChange={editor.changeAgent}
            onModelChange={model => update({ model })}
            formatAgentLabel={agent => agentDisplayName(agent.alias, editor.agents)}
            agentPlaceholder={runner?.label ?? 'Default coding agent'}
            agentPlaceholderProvider={runner?.provider}
            agentLabel="Coding agent"
            disabled={readOnly}
            fullWidth
          />
        </AgentFormRow>

        <AgentCapabilitiesSection
          capabilities={form.capabilities}
          onChange={capabilities => update({ capabilities })}
          proprMcpSupport={editor.proprMcpSupport}
          agentType={editor.agentType}
          autonomy={form.autonomy}
          disabled={readOnly}
        />

        <AgentScheduleSection
          enabled={form.scheduleEnabled}
          expression={form.schedule}
          pauseWhenUnproductive={form.pauseWhenUnproductive}
          onChange={update}
          disabled={readOnly}
          unproductiveRunThreshold={unproductiveRunThreshold}
          error={fieldErrors.schedule}
        />

        <AgentEventTriggerSection
          enabled={form.blockedTrigger}
          repositories={form.blockedTriggerRepositories}
          reasonKinds={form.blockedTriggerReasonKinds}
          automationRepositories={form.repositories}
          onChange={update}
          disabled={readOnly}
          error={fieldErrors.eventTrigger}
        />

        <AgentAutonomySection
          autonomy={form.autonomy}
          onChange={autonomy => update({ autonomy })}
          actingAvailable={editor.proprMcpSupport !== 'unsupported'}
          disabled={readOnly}
        />
      </fieldset>

      {definition && !isDemoMode && (
        <div className="flex items-center justify-between gap-3 px-4 py-4">
          <p className="text-xs text-slate-500">Deleting removes the automation, its input files and its run history.</p>
          <button
            type="button"
            onClick={onDelete}
            disabled={editor.saving}
            className={`${BUTTON_CLASSES} border border-red-200 bg-white text-red-700 hover:bg-red-50`}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />Delete
          </button>
        </div>
      )}
    </div>

    <AgentSaveFooter isNew={isNew} saving={editor.saving} disabled={readOnly || editor.conflict || editor.attachmentsPending} />
    {templateDialog}
  </form>
  );
};

export default AgentSettingsForm;
