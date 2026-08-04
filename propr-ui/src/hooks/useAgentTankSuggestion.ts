import { useCallback, useEffect, useState } from 'react';
import { getAgentTankStatus } from '../api/revertApi';

const DISMISSED_AGENT_TANK_SUGGESTION_KEY = 'dismissed_agent_tank_suggestion';

export function useAgentTankSuggestion(canManageAgents: boolean) {
  const [showSuggestion, setShowSuggestion] = useState(false);

  useEffect(() => {
    if (!canManageAgents) {
      setShowSuggestion(false);
      return;
    }
    if (localStorage.getItem(DISMISSED_AGENT_TANK_SUGGESTION_KEY) === 'true') return;

    let cancelled = false;
    getAgentTankStatus()
      .then(status => {
        if (!cancelled && !status.available) setShowSuggestion(true);
      })
      .catch(() => {
        if (!cancelled) setShowSuggestion(true);
      });
    return () => { cancelled = true; };
  }, [canManageAgents]);

  const dismissSuggestion = useCallback(() => {
    setShowSuggestion(false);
    localStorage.setItem(DISMISSED_AGENT_TANK_SUGGESTION_KEY, 'true');
  }, []);

  return { dismissSuggestion, showSuggestion };
}
