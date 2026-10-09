import React from 'react';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { AGENT_DESCRIPTION_MAX_LENGTH, AGENT_NAME_MAX_LENGTH } from '@propr/shared';
import { AgentModelSelector } from '../TaskPlanner/AgentModelSelector';
import { AGENT_INPUT_CLASSES, AgentFormRow } from './AgentFormRow';
import { AgentScopeSection } from './AgentScopeSection';
import { AgentPromptSection } from './AgentPromptSection';
import { AgentCapabilitiesSection } from './AgentCapabilitiesSection';
import { AgentScheduleSection } from './AgentScheduleSection';
import { AgentAutonomySection } from './AgentAutonomySection';
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

/** The agent's settings: scope, prompt and files, model, capabilities, schedule and autonomy. */
export const AgentSettingsForm: React.FC<AgentSettingsFormProps> = ({ editor, isNew, readOnly, isDemoMode, hidden, onDelete }) => {
  const { definition, form, update } = editor;
  const runner = defaultRunner(editor.agents, editor.defaultAgentAlias);
  return (
  <form
    id="agent-editor-form"
    noValidate
    onSubmit={event => { event.preventDefault(); if (!readOnly && !editor.conflict) void editor.save(); }}
    hidden={hidden}
    className={`min-h-0 flex-1 flex-col ${hidden ? '' : 'flex'}`}
  >
    <div className="min-h-0 flex-1 overflow-y-auto">
      <fieldset disabled={readOnly} className="min-w-0">
        <AgentFormRow label="Name" htmlFor="agent-name" hint="Shown in the list and in run notifications.">
          <input
            id="agent-name"
            value={form.name}
            maxLength={AGENT_NAME_MAX_LENGTH}
            onChange={event => update({ name: event.target.value })}
            placeholder="Weekly dependency review"
            className={AGENT_INPUT_CLASSES}
          />
        </AgentFormRow>
        <AgentFormRow label="Description" htmlFor="agent-description" hint="Optional. What this automation is for.">
          <input
            id="agent-description"
            value={form.description}
            maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
            onChange={event => update({ description: event.target.value })}
            className={AGENT_INPUT_CLASSES}
          />
        </AgentFormRow>

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
        />

        <AgentFormRow label="Coding agent" hint="The coding agent and model that write the report. Left on the default, the instance default agent runs it with its default model.">
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
          />
        </AgentFormRow>

        <AgentCapabilitiesSection
          capabilities={form.capabilities}
          onChange={capabilities => update({ capabilities })}
          proprMcpSupport={editor.proprMcpSupport}
          agentType={editor.agentType}
          disabled={readOnly}
        />

        <AgentScheduleSection
          enabled={form.scheduleEnabled}
          expression={form.schedule}
          onChange={update}
          disabled={readOnly}
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
  </form>
  );
};

export default AgentSettingsForm;
