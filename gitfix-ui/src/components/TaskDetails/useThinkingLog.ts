import { useState, useEffect, useMemo } from 'react';
import { LiveDetails, LiveEvent, HistoryItem } from './types';
import { formatRelativeTime } from './utils';

interface ThinkingLogEvent extends LiveEvent {
  relativeTime?: string | null;
}

export const useThinkingLog = (liveDetails: LiveDetails, history: HistoryItem[]) => {
  const [lastThought, setLastThought] = useState<string | null>(null);
  const [eventsCollapsed, setEventsCollapsed] = useState<boolean>(true);

  const thinkingLogEvents = useMemo(() => {
    return liveDetails.events.filter(e => e.type === 'thought');
  }, [liveDetails.events]);

  const executionStartTime = history.find(item => item.state?.toUpperCase() === 'CLAUDE_EXECUTION')?.timestamp;
  
  const thinkingLogWithTimestamps: ThinkingLogEvent[] = useMemo(() => {
    if (!executionStartTime) return thinkingLogEvents;
    const startTime = new Date(executionStartTime).getTime();
    return thinkingLogEvents.map(event => ({
      ...event,
      relativeTime: event.timestamp ? formatRelativeTime(new Date(event.timestamp).getTime() - startTime) : null
    }));
  }, [thinkingLogEvents, executionStartTime]);

  useEffect(() => {
    if (liveDetails.events.length > 0) {
      const lastThoughtEvent = [...liveDetails.events].reverse().find(e => e.type === 'thought');
      setLastThought(lastThoughtEvent?.content ?? null);
    } else {
      setLastThought(null);
    }
  }, [liveDetails]);

  const toggleEventsCollapse = () => setEventsCollapsed(!eventsCollapsed);

  return {
    thinkingLogWithTimestamps,
    lastThought,
    eventsCollapsed,
    toggleEventsCollapse
  };
};
