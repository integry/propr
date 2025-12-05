import React from 'react';
import { LiveEvent } from './types';
import { renderMarkdown } from './renderMarkdown';

interface ThinkingLogEvent extends LiveEvent {
  relativeTime?: string | null;
}

interface ThinkingLogProps {
  events: ThinkingLogEvent[];
}

const ThinkingLog: React.FC<ThinkingLogProps> = ({ events }) => {
  if (events.length === 0) {
    return null;
  }

  return (
    <div className="mb-6">
      <h4 className="text-lg font-semibold text-gray-900 mb-4">Thinking Log</h4>
      <div className="space-y-4 p-4 bg-gray-50 rounded-lg border border-gray-200 overflow-y-auto">
        {events.map((event, index) => (
          <div key={index} className="flex items-start gap-3">
            <span className="text-lg mt-0">🧠</span>
            <div className="flex-1">
              <p className="text-gray-700 whitespace-pre-wrap">{renderMarkdown(event.content)}</p>
              {event.relativeTime && (
                <p className="text-xs text-gray-500 mt-1">{event.relativeTime}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ThinkingLog;
