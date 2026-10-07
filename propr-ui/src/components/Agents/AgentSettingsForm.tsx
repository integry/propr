import React from 'react';
import { Trash2 } from 'lucide-react';
import { AGENT_DESCRIPTION_MAX_LENGTH, AGENT_NAME_MAX_LENGTH } from '@propr/shared';
import { AgentModelSelector } from '../TaskPlanner/AgentModelSelector';
import { AGENT_INPUT_CLASSES, AgentFormRow } from './AgentFormRow';
import { AgentScopeSection } from './AgentScopeSection';
import { AgentPromptSection } from './AgentPromptSection';
import { AgentCapabilitiesSection } from './AgentCapabilitiesSection';
import { AgentScheduleSection } from './AgentScheduleSection';
import { AgentAutonomySection } from './AgentAutonomySection';
import { BUTTON_CLASSES } from './AgentEditorHeader';
import { agentDisplayName } from './agentPresentation';
import type { useAgentEditor } from './useAgentEditor';
import { useUnattendedNotice } from './useUnattendedNotice';

interface AgentSettingsFormProps {
  editor: ReturnType<typeof useAgentEditor>;
  /** Demo mode or a save in flight. */
  readOnly: boolean;
  isDemoMode: boolean;
  /** Hidden rather than unmounted while another tab shows, so unsaved edits survive. */
  hidden: boolean;
  onDelete: () => void;
}

/** The agent's settings: scope, prompt and files, model, capabilities, schedule and autonomy. */
export const AgentSettingsForm: React.FC<AgentSettingsFormProps> = ({ editor, readOnly, isDemoMode, hidden, onDelete }) => {
  const { definition, form, update } = editor;
  const unattendedNotice = useUnattendedNotice(definition?.id, Boolean(definition?.scheduleEnabled) && form.scheduleEnabled);
  return (
  <form
    id="agent-editor-form"
    noValidate
    onSubmit={event => { event.preventDefault(); if (!readOnly && !editor.conflict) void editor.save(); }}
    hidden={hidden}
    className="min-h-0 flex-1 overflow-y-auto"
  >
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
      <AgentFormRow label="Description" htmlFor="agent-description" hint="Optional. What this agent is for.">
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

      <AgentFormRow label="Model" hint="The coding agent and model that write the report. Without a choice, the instance default agent runs it.">
        <AgentModelSelector
          agents={editor.agents}
          selectedAgent={form.agentId}
          selectedModel={form.model}
          onAgentChange={editor.changeAgent}
          onModelChange={model => update({ model })}
          formatAgentLabel={agent => agentDisplayName(agent.alias, editor.agents)}
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
        unattendedNotice={unattendedNotice}
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
        <p className="text-xs text-slate-500">Deleting removes the agent, its input files and its run history.</p>
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
  </form>
  );
};

export default AgentSettingsForm;
