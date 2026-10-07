import React from 'react';
import type { AgentDefinitionRecord } from '../../api/agentDefinitionsApi';
import { AgentRunDetail } from './AgentRunDetail';
import { AgentRunHistory } from './AgentRunHistory';

interface AgentRunsPaneProps {
  definition: AgentDefinitionRecord;
  /** The run to show, or null for the run history. */
  runId: string | null;
  readOnly: boolean;
}

/** The Runs tab of a saved agent: its run history, or one run opened from it. */
export const AgentRunsPane: React.FC<AgentRunsPaneProps> = ({ definition, runId, readOnly }) => (
  <div className="min-h-0 flex-1 overflow-y-auto" data-testid="agent-runs-pane">
    {runId
      ? (
        <AgentRunDetail
          key={runId}
          definitionId={definition.id}
          runId={runId}
          agentName={definition.name}
          repositories={definition.repositories}
          readOnly={readOnly}
        />
      )
      : <AgentRunHistory definitionId={definition.id} />}
  </div>
);

export default AgentRunsPane;
