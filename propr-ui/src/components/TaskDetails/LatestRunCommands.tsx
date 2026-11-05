import React from 'react';
import FollowupCommands from '../Inbox/FollowupCommands';
import type { TaskRunEntry } from '../TaskList/rowModel';
import { readTaskRuns } from './readTaskRuns';
import { latestRunFollowup } from './runFollowup';

/**
 * The newest run's follow-up commands; an earlier run shows none, so it cannot
 * replay one. The runs shown may lag work started elsewhere, so a command is
 * sent only once a fresh read confirms the run is still the newest.
 */
const LatestRunCommands: React.FC<{ runs?: readonly TaskRunEntry[]; taskId?: string }> = ({ runs, taskId }) => {
  const followup = latestRunFollowup(runs, taskId);
  if (!followup) return null;
  const revalidate = async (command: string) =>
    latestRunFollowup(await readTaskRuns(followup.taskId), followup.taskId)?.commands.includes(command) ?? false;
  return (
    <FollowupCommands
      taskId={followup.taskId}
      prNumber={followup.prNumber}
      commands={followup.commands}
      label={`Follow-up commands for PR #${followup.prNumber}`}
      revalidate={revalidate}
    />
  );
};

export default LatestRunCommands;
