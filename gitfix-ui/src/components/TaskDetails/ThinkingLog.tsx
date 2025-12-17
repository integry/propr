import React from 'react';
import { LiveEvent } from './types';
import { renderMarkdown } from './renderMarkdown';
import { Brain, Lightbulb, CheckCircle2, Search, Wrench } from 'lucide-react';

interface ThinkingLogEvent extends LiveEvent {
  relativeTime?: string | null;
}

interface ThinkingLogProps {
  events: ThinkingLogEvent[];
}

const getThoughtType = (content: string) => {
    const lower = content.toLowerCase();
    if (lower.includes('analyz') || lower.includes('investigat') || lower.includes('check') || lower.includes('read') || lower.includes('search')) {
        return 'analysis';
    }
    if (lower.includes('create') || lower.includes('update') || lower.includes('modif') || lower.includes('implement') || lower.includes('write')) {
        return 'action';
    }
    if (lower.includes('done') || lower.includes('finish') || lower.includes('complet')) {
        return 'completion';
    }
    return 'default';
};

const ThinkingLog: React.FC<ThinkingLogProps> = ({ events }) => {
  if (events.length === 0) {
    return null;
  }

  return (
    <div className="mb-6">
      <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
        <Brain className="text-purple-600" />
        Thinking Process
      </h4>
      <div className="space-y-4">
        {events.map((event, index) => {
          const type = getThoughtType(event.content || '');
          let containerClass = "p-4 rounded-lg border shadow-sm transition-all hover:shadow-md";
          let icon = <Lightbulb className="text-yellow-600" size={20} />;
          
          if (type === 'analysis') {
             containerClass += " bg-blue-50 border-blue-100";
             icon = <Search className="text-blue-600" size={20} />;
          } else if (type === 'action') {
             containerClass += " bg-green-50 border-green-100";
             icon = <Wrench className="text-green-600" size={20} />;
          } else if (type === 'completion') {
             containerClass += " bg-purple-50 border-purple-100";
             icon = <CheckCircle2 className="text-purple-600" size={20} />;
          } else {
             containerClass += " bg-white border-gray-200";
          }

          return (
            <div key={index} className={containerClass}>
                <div className="flex items-start gap-3">
                    <div className="mt-0.5 bg-white p-1.5 rounded-full border border-gray-100 shadow-sm">{icon}</div>
                    <div className="flex-1">
                        <div className="text-gray-800 text-sm whitespace-pre-wrap leading-relaxed">
                            {renderMarkdown(event.content)}
                        </div>
                        {event.relativeTime && (
                            <p className="text-xs text-gray-400 mt-2 font-mono flex items-center gap-1">
                                <span>⏱</span> {event.relativeTime}
                            </p>
                        )}
                    </div>
                </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ThinkingLog;
