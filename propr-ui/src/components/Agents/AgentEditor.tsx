import React, { useState } from 'react';
import { AlertTriangle, Loader2, Play, RotateCw, Save, Trash2 } from 'lucide-react';
import { AGENT_DESCRIPTION_MAX_LENGTH, AGENT_NAME_MAX_LENGTH } from '@propr/shared';
import { useDemoMode } from '../../contexts/DemoModeContext';
import { AgentModelSelector } from '../TaskPlanner/AgentModelSelector';
import { ListSkeleton } from '../ui/Skeleton';
import { AGENT_INPUT_CLASSES, AgentFormRow } from './AgentFormRow';
import { AgentScopeSection } from './AgentScopeSection';
import { AgentPromptSection } from './AgentPromptSection';
import { AgentCapabilitiesSection } from './AgentCapabilitiesSection';
import { AgentScheduleSection } from './AgentScheduleSection';
import { AgentAutonomySection } from './AgentAutonomySection';
import { AgentDeleteDialog } from './AgentDeleteDialog';
import { agentDisplayName } from './agentPresentation';
import { CONFLICT_MESSAGE, RUN_NEEDS_SAVE_MESSAGE, useAgentEditor, type AgentEditorCallbacks } from './useAgentEditor';

interface AgentEditorProps extends AgentEditorCallbacks {
  /** The agent to edit, or null to create one. */
  definitionId: string | null;
  /** Navigation docked in the header: "Back to list" on narrow screens, pane controls in the split. */
  headerControls?: React.ReactNode;
}

const BUTTON_CLASSES = 'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-50';

interface AgentEditorHeaderProps {
  title: string;
  headerControls?: React.ReactNode;
  notice: string | null;
  canRun: boolean;
  running: boolean;
  runDisabled: boolean;
  /** Why Run now is unavailable, when the reason is something the user can fix. */
  runHint: string | null;
  onRun: () => void;
  saveLabel: string;
  saving: boolean;
  saveDisabled: boolean;
}

/** Title with the pane's navigation on the left, Run now and Save pinned to the right. */
const AgentEditorHeader: React.FC<AgentEditorHeaderProps> = ({
  title, headerControls, notice, canRun, running, runDisabled, runHint, onRun, saveLabel, saving, saveDisabled,
}) => (
  <header className="flex flex-none items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
    <div className="flex min-w-0 items-center gap-2">
      {headerControls}
      <h1 className="truncate text-base font-semibold text-slate-900">{title}</h1>
    </div>
    <div className="flex flex-none items-center gap-2">
      {notice && <span role="status" className="text-xs text-slate-500">{notice}</span>}
      {canRun && runHint && <span id="agent-run-hint" className="text-xs text-slate-500">{runHint}</span>}
      {canRun && (
        <button
          type="button"
          onClick={onRun}
          disabled={runDisabled}
          aria-describedby={runHint ? 'agent-run-hint' : undefined}
          className={`${BUTTON_CLASSES} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          Run now
        </button>
      )}
      <button type="submit" form="agent-editor-form" disabled={saveDisabled} className={`${BUTTON_CLASSES} bg-teal-600 text-white hover:bg-teal-700`}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
        {saveLabel}
      </button>
    </div>
  </header>
);

interface RunGate { running: boolean; saving: boolean; dirty: boolean; conflict: boolean; loading: boolean; attachmentsPending: boolean }

/**
 * Run now starts the definition the server holds, so it is held back while a
 * save is replacing it, while the form shows changes that are not saved yet,
 * while the agent changed elsewhere and its replacement has not loaded, and
 * while input files are still being added or removed.
 */
function runAvailability(isDemoMode: boolean, { running, saving, dirty, conflict, loading, attachmentsPending }: RunGate) {
  return {
    runDisabled: isDemoMode || running || saving || dirty || conflict || loading || attachmentsPending,
    runHint: !isDemoMode && dirty && !saving && !conflict ? RUN_NEEDS_SAVE_MESSAGE : null,
  };
}

/** Create or edit an agent: scope, prompt and files, model, capabilities, schedule and autonomy. */
export const AgentEditor: React.FC<AgentEditorProps> = ({ definitionId, headerControls, ...callbacks }) => {
  const { isDemoMode } = useDemoMode();
  const editor = useAgentEditor(definitionId, callbacks);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { definition, form, update } = editor;
  const readOnly = isDemoMode || editor.saving;
  const title = definitionId ? (definition?.name || 'Agent') : 'New agent';

  const header = (
    <AgentEditorHeader
      title={title}
      headerControls={headerControls}
      notice={editor.notice}
      canRun={Boolean(definition)}
      running={editor.running}
      onRun={() => void editor.run()}
      saveLabel={definition ? 'Save' : 'Create agent'}
      saving={editor.saving}
      {...runAvailability(isDemoMode, editor)}
      saveDisabled={readOnly || editor.conflict}
    />
  );

  if (editor.loading || editor.loadError) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-white">
        {header}
        <div className="p-4">
          {editor.loadError
            ? <p role="alert" className="text-sm text-red-700">{editor.loadError}</p>
            : <ListSkeleton layout="block" rows={4} label="Loading agent…" />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white" data-testid="agent-editor">
      {header}
      {isDemoMode && (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">Demo mode is read-only: agents cannot be saved or run.</p>
      )}
      {editor.conflict && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <span className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{CONFLICT_MESSAGE}</span>
          <button type="button" onClick={() => void editor.reload()} className="inline-flex items-center gap-1 text-sm font-medium text-amber-900 underline-offset-2 hover:underline">
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />Reload
          </button>
        </div>
      )}
      {editor.error && <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{editor.error}</p>}

      <form
        id="agent-editor-form"
        noValidate
        onSubmit={event => { event.preventDefault(); if (!readOnly && !editor.conflict) void editor.save(); }}
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
              onClick={() => setConfirmingDelete(true)}
              className={`${BUTTON_CLASSES} border border-red-200 bg-white text-red-700 hover:bg-red-50`}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />Delete
            </button>
          </div>
        )}
      </form>

      {confirmingDelete && definition && (
        <AgentDeleteDialog
          name={definition.name}
          deleting={editor.deleting}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void editor.remove().then(() => setConfirmingDelete(false))}
        />
      )}
    </div>
  );
};

export default AgentEditor;
