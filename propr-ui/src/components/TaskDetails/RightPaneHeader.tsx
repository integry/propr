import React from 'react';
import {
  MessageSquareText,
  Terminal,
  Lightbulb,
  Wrench,
  Search,
  CheckCircle2,
  Eye,
  Edit3,
  FolderSearch
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
    className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase transition-all border-b-2 -mb-px
      ${isActive
        ? 'text-gray-900 border-gray-900'
        : 'text-gray-400 border-transparent hover:text-gray-600 hover:border-gray-300'
      }`}
  >
    {icon}
    <span>{label}</span>
    <span className="font-mono text-[9px] opacity-70">({count})</span>
  </button>
);

// Filter chip for the filter strip
interface FilterChipProps {
  label: string;
  icon: React.ReactNode;
  color: string;
  isActive: boolean;
  onClick: () => void;
  count?: number;
}

const FilterChip: React.FC<FilterChipProps> = ({ label, icon, color, isActive, onClick, count }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium uppercase rounded transition-all
      ${isActive
        ? `${color} bg-opacity-10 ring-1 ring-current`
        : 'text-gray-400 hover:text-gray-500'
      }`}
  >
    {icon}
    <span>{label}</span>
    {count !== undefined && count > 0 && (
      <span className="font-mono text-[9px] opacity-60 ml-0.5">{count}</span>
    )}
  </button>
);

interface RightPaneHeaderProps {
  // Thinking log data
  thoughtCount: number;
  thoughtTypeCounts: Record<ThoughtType, number>;
  activeThoughtFilters: Set<string>;
  onToggleThoughtFilter: (type: ThoughtType) => void;

  // Execution event data
  eventCount: number;
  eventTypeCounts: Record<EventType, number>;
  activeEventFilters: Set<string>;
  onToggleEventFilter: (type: EventType) => void;

  // Clear filters
  onClearAllFilters: () => void;

  // Active tab
  activeTab?: 'thoughts' | 'events';
  onTabChange?: (tab: 'thoughts' | 'events') => void;
}

const RightPaneHeader: React.FC<RightPaneHeaderProps> = ({
  thoughtCount,
  thoughtTypeCounts,
  activeThoughtFilters,
  onToggleThoughtFilter,
  eventCount,
  eventTypeCounts,
  activeEventFilters,
  onToggleEventFilter,
  onClearAllFilters,
  activeTab = 'thoughts',
  onTabChange
}) => {
  const hasActiveFilters = activeThoughtFilters.size > 0 || activeEventFilters.size > 0;
  const showThoughtsFilters = activeTab === 'thoughts';
  const showEventsFilters = activeTab === 'events';

  return (
    <div className="sticky top-0 z-10 bg-white">
      {/* Tabs row - sits on the continuous border like IDE tabs */}
      <div className="flex items-end justify-between px-4 border-b border-gray-200">
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

        {/* Clear filters button */}
        {hasActiveFilters && (
          <button
            onClick={onClearAllFilters}
            className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors pb-1.5"
          >
            Clear
          </button>
        )}
      </div>

      {/* Filter Strip - high-density single line */}
      <div className="flex items-center gap-1 px-4 py-1.5 bg-gray-50/50 border-b border-gray-100">
        {showThoughtsFilters && (
          <>
            <FilterChip
              label="Analysis"
              icon={<Lightbulb className="h-2.5 w-2.5" />}
              color="text-blue-600"
              isActive={activeThoughtFilters.has('analysis')}
              onClick={() => onToggleThoughtFilter('analysis')}
              count={thoughtTypeCounts.analysis}
            />
            <FilterChip
              label="Action"
              icon={<Wrench className="h-2.5 w-2.5" />}
              color="text-green-600"
              isActive={activeThoughtFilters.has('action')}
              onClick={() => onToggleThoughtFilter('action')}
              count={thoughtTypeCounts.action}
            />
            <FilterChip
              label="Search"
              icon={<Search className="h-2.5 w-2.5" />}
              color="text-purple-600"
              isActive={activeThoughtFilters.has('search')}
              onClick={() => onToggleThoughtFilter('search')}
              count={thoughtTypeCounts.search}
            />
            <FilterChip
              label="Summary"
              icon={<CheckCircle2 className="h-2.5 w-2.5" />}
              color="text-amber-600"
              isActive={activeThoughtFilters.has('summary')}
              onClick={() => onToggleThoughtFilter('summary')}
              count={thoughtTypeCounts.summary}
            />
          </>
        )}

        {showEventsFilters && (
          <>
            <FilterChip
              label="Read"
              icon={<Eye className="h-2.5 w-2.5" />}
              color="text-cyan-600"
              isActive={activeEventFilters.has('read')}
              onClick={() => onToggleEventFilter('read')}
              count={eventTypeCounts.read}
            />
            <FilterChip
              label="Write"
              icon={<Edit3 className="h-2.5 w-2.5" />}
              color="text-orange-600"
              isActive={activeEventFilters.has('write')}
              onClick={() => onToggleEventFilter('write')}
              count={eventTypeCounts.write}
            />
            <FilterChip
              label="Bash"
              icon={<Terminal className="h-2.5 w-2.5" />}
              color="text-gray-700"
              isActive={activeEventFilters.has('bash')}
              onClick={() => onToggleEventFilter('bash')}
              count={eventTypeCounts.bash}
            />
            <FilterChip
              label="Search"
              icon={<FolderSearch className="h-2.5 w-2.5" />}
              color="text-indigo-600"
              isActive={activeEventFilters.has('search')}
              onClick={() => onToggleEventFilter('search')}
              count={eventTypeCounts.search}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default RightPaneHeader;
