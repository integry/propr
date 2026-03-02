import React from 'react';
import {
  MessageSquareText,
  Terminal
} from 'lucide-react';

// Thought type categories for filtering
export type ThoughtType = 'analysis' | 'action' | 'summary' | 'search';

// Execution event categories for filtering
export type EventType = 'thought' | 'read' | 'write' | 'bash' | 'search' | 'tool_use' | 'tool_result';

// Tab button for THOUGHTS / EVENTS toggle
interface TabButtonProps {
  label: string;
  icon: React.ReactNode;
  count: number;
  isActive: boolean;
  onClick: () => void;
}

const TabButton: React.FC<TabButtonProps> = ({ label, icon, count, isActive, onClick }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-3 py-2 text-[11px] font-bold uppercase tracking-widest transition-all border-b-2 -mb-px
      ${isActive
        ? 'text-teal-600 border-teal-500'
        : 'text-slate-400 border-transparent hover:text-slate-600 hover:border-slate-300'
      }`}
  >
    {icon}
    <span>{label}</span>
    <span className="font-mono text-[9px] opacity-70">({count})</span>
  </button>
);

interface RightPaneHeaderProps {
  // Thinking log data
  thoughtCount: number;

  // Execution event data
  eventCount: number;

  // Active tab
  activeTab?: 'thoughts' | 'events';
  onTabChange?: (tab: 'thoughts' | 'events') => void;
}

const RightPaneHeader: React.FC<RightPaneHeaderProps> = ({
  thoughtCount,
  eventCount,
  activeTab = 'thoughts',
  onTabChange
}) => {
  return (
    <div className="flex-1 flex flex-col bg-white min-w-0">
      {/* Tabs row - sits on the continuous border like IDE tabs */}
      <div className="flex items-end px-4 border-b border-gray-100">
        <div className="flex items-center">
          <TabButton
            label="Thoughts"
            icon={<MessageSquareText className="h-3 w-3" />}
            count={thoughtCount}
            isActive={activeTab === 'thoughts'}
            onClick={() => onTabChange?.('thoughts')}
          />
          <TabButton
            label="Events"
            icon={<Terminal className="h-3 w-3" />}
            count={eventCount}
            isActive={activeTab === 'events'}
            onClick={() => onTabChange?.('events')}
          />
        </div>
      </div>
    </div>
  );
};

export default RightPaneHeader;
