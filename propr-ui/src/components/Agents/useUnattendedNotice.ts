import { useEffect, useState } from 'react';
import { getAgentCapacity } from '../../api/agentDefinitionsApi';
import { unattendedNotice } from './agentRunPresentation';

/**
 * Why a saved agent's scheduled and API runs are held by the instance's
 * unattended limits (window closed, malformed window, concurrency cap), read
 * once when the agent or its schedule toggle changes. Best-effort: a failed
 * read shows nothing, and the server's own gate still decides.
 */
export function useUnattendedNotice(definitionId: string | null | undefined, scheduleEnabled: boolean): string | null {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setNotice(null);
    if (!definitionId || !scheduleEnabled) return;
    let active = true;
    getAgentCapacity(definitionId)
      .then(capacity => { if (active) setNotice(unattendedNotice(capacity)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [definitionId, scheduleEnabled]);
  return notice;
}
