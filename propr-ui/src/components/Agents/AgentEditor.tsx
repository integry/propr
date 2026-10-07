import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDemoMode } from '../../contexts/DemoModeContext';
import { ListSkeleton } from '../ui/Skeleton';
import { AgentDeleteDialog } from './AgentDeleteDialog';
import { AgentConfirmDialog } from './AgentConfirmDialog';
import { AgentRunsPane } from './AgentRunsPane';
import { AgentConflictBanner, AgentDetailTabs, AgentEditorHeader, type AgentDetailSection } from './AgentEditorHeader';
import { AgentSettingsForm } from './AgentSettingsForm';
import { runAvailability, useAgentEditor, type AgentEditorCallbacks } from './useAgentEditor';
import type { AgentRunRecord } from '../../api/agentDefinitionsApi';

interface AgentEditorProps extends AgentEditorCallbacks {
  /** The agent to edit, or null to create one. */
  definitionId: string | null;
  /** Navigation docked in the header: "Back to list" on narrow screens, pane controls in the split. */
  headerControls?: React.ReactNode;
  /** Which part of a saved agent is showing: its settings, its run history, or one run. */
  section?: AgentDetailSection;
  /** The run shown when `section` is `run`. */
  runId?: string | null;
}

/** A new agent has only its settings; a run section without a run shows the history. */
const resolveSection = (definitionId: string | null, requested: AgentDetailSection, runId: string | null): AgentDetailSection => {
  if (!definitionId) return 'settings';
  return requested === 'run' && !runId ? 'runs' : requested;
};

interface AgentEditorTopProps {
  definitionId: string | null;
  editor: ReturnType<typeof useAgentEditor>;
  section: AgentDetailSection;
  isDemoMode: boolean;
  headerControls?: React.ReactNode;
}

/** The header with Run now and Save, and for a saved agent the Settings/Runs tabs. */
const AgentEditorTop: React.FC<AgentEditorTopProps> = ({ definitionId, editor, section, isDemoMode, headerControls }) => {
  const { definition } = editor;
  const readOnly = isDemoMode || editor.saving;
  return (
    <>
      <AgentEditorHeader
        title={definitionId ? (definition?.name || 'Agent') : 'New agent'}
        headerControls={headerControls}
        notice={editor.notice}
        canRun={Boolean(definition)}
        running={editor.running}
        onRun={() => void editor.run()}
        saveLabel={definition ? 'Save' : 'Create agent'}
        saving={editor.saving}
        {...runAvailability(isDemoMode, { ...editor, disabledAgent: definition?.enabled === false })}
        saveDisabled={readOnly || editor.conflict || editor.attachmentsPending}
        showSave={section === 'settings'}
      />
      {definitionId && <AgentDetailTabs definitionId={definitionId} section={section} />}
    </>
  );
};

/**
 * Create or edit an agent: scope, prompt and files, model, capabilities,
 * schedule and autonomy. A saved agent also has a Runs tab with its run
 * history and run detail; the settings form stays mounted (hidden) while
 * another tab shows, so unsaved edits survive a look at the runs.
 */
export const AgentEditor: React.FC<AgentEditorProps> = ({ definitionId, headerControls, section: requestedSection = 'settings', runId = null, ...callbacks }) => {
  const { isDemoMode } = useDemoMode();
  const navigate = useNavigate();
  const openRun = useCallback((run: AgentRunRecord) => {
    navigate(`/agents/${encodeURIComponent(run.definitionId)}/runs/${encodeURIComponent(run.id)}`);
  }, [navigate]);
  const editor = useAgentEditor(definitionId, callbacks, { openRun });
  const section = resolveSection(definitionId, requestedSection, runId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { definition } = editor;
  const readOnly = isDemoMode || editor.saving;
  const top = (
    <AgentEditorTop definitionId={definitionId} editor={editor} section={section} isDemoMode={isDemoMode} headerControls={headerControls} />
  );

  if (editor.loading || editor.loadError) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-white">
        {top}
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
      {top}
      {isDemoMode && (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">Demo mode is read-only: agents cannot be saved or run.</p>
      )}
      {editor.conflict && <AgentConflictBanner reloadDisabled={editor.attachmentsPending} onReload={() => void editor.reload()} />}
      {editor.error && <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{editor.error}</p>}

      <AgentSettingsForm editor={editor} readOnly={readOnly} isDemoMode={isDemoMode} hidden={section !== 'settings'} onDelete={() => setConfirmingDelete(true)} />

      {section !== 'settings' && definition && (
        <AgentRunsPane definition={definition} runId={section === 'run' ? runId : null} readOnly={isDemoMode} />
      )}

      {editor.capacityQuestion && (
        <AgentConfirmDialog
          title="Close to the usage limit"
          confirmLabel="Run anyway"
          onCancel={editor.dismissRun}
          onConfirm={() => void editor.confirmRun()}
        >
          <p data-testid="agent-capacity-warning">{editor.capacityQuestion}</p>
        </AgentConfirmDialog>
      )}

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
