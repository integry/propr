import { useState, useEffect, useMemo } from 'react';
import { LiveDetails, LiveEvent, HistoryItem } from './types';
import { formatRelativeTime } from './utils';

interface ThinkingLogEvent extends LiveEvent {
  relativeTime?: string | null;
}

// Extract "Summary of Changes" section from a thinking log entry
// The summary is typically found in the last thinking log entry and contains
// a "Summary of Changes" heading followed by the actual summary content
const extractSummaryOfChanges = (content: string): string | null => {
  if (!content) return null;

  // Look for "Summary of Changes" heading (handles both markdown ## and HTML h2)
  // Match patterns like:
  // ## Summary of Changes
  // ### Summary of Changes
  // <h2>Summary of Changes</h2>
  const summaryPattern = /(?:^|\n)(?:#{1,3}\s*Summary of Changes|<h2[^>]*>Summary of Changes<\/h2>)/i;
  const match = content.match(summaryPattern);

  if (!match) return null;

  // Get everything from the "Summary of Changes" heading onwards
  const summaryStartIndex = match.index! + match[0].length;
  const summaryContent = content.substring(summaryStartIndex);

  return summaryContent.trim();
};

// Find the thinking log entry containing the summary and return the extracted summary
const findSummaryFromThinkingLog = (events: LiveEvent[]): string | null => {
  if (!events || events.length === 0) return null;

  // Search from the end since Summary of Changes is typically the last item
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'thought' && event.content) {
      const summary = extractSummaryOfChanges(event.content);
      if (summary) {
        return summary;
      }
    }
  }

  return null;
};

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

  // Extract "Summary of Changes" from thinking log events
  const extractedSummary = useMemo(() => {
    return findSummaryFromThinkingLog(liveDetails.events);
  }, [liveDetails.events]);

  useEffect(() => {
    if (liveDetails.events.length > 0) {
      const lastThoughtEvent = [...liveDetails.events].reverse().find(e => e.type === 'thought');
      setLastThought(lastThoughtEvent?.content ?? null);
    } else {
      setLastThought(null);
    }
  }, [liveDetails]);

  const toggleEventsCollapse = () => setEventsCollapsed(!eventsCollapsed);
  const collapseEvents = () => setEventsCollapsed(true);

  return {
    thinkingLogWithTimestamps,
    lastThought,
    eventsCollapsed,
    toggleEventsCollapse,
    collapseEvents,
    extractedSummary
  };
};
