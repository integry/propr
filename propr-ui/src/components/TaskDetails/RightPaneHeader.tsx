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

interface FilterBadgeProps {
  label: string;
  icon: React.ReactNode;
  color: string;
  isActive: boolean;
  onClick: () => void;
  count?: number;
}

const FilterBadge: React.FC<FilterBadgeProps> = ({ label, icon, color, isActive, onClick, count }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium uppercase rounded transition-all
      ${isActive
        ? `${color} bg-opacity-10 ring-1 ring-current`
        : 'text-gray-400 hover:text-gray-600'
      }`}
  >
    {icon}
    <span>{label}</span>
    {count !== undefined && count > 0 && (
      <span className="font-mono text-[9px] opacity-70">({count})</span>
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
  onClearAllFilters
}) => {
  const hasActiveFilters = activeThoughtFilters.size > 0 || activeEventFilters.size > 0;

  return (
    <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-4 py-2">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-4">
          {/* Thinking Log title and count */}
          <div className="flex items-center gap-1.5">
            <MessageSquareText className="h-3.5 w-3.5 text-gray-500" />
            <span className="text-[10px] font-bold uppercase text-gray-600">Thoughts</span>
            <span className="font-mono text-[10px] text-gray-400">({thoughtCount})</span>
          </div>

          {/* Divider */}
          <div className="h-3 w-px bg-gray-200" />

          {/* Execution Log title and count */}
          <div className="flex items-center gap-1.5">
            <Terminal className="h-3.5 w-3.5 text-gray-500" />
            <span className="text-[10px] font-bold uppercase text-gray-600">Events</span>
            <span className="font-mono text-[10px] text-gray-400">({eventCount})</span>
          </div>
        </div>

        {/* Clear filters button */}
        {hasActiveFilters && (
          <button
            onClick={onClearAllFilters}
            className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {/* Thought type filters */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-gray-400 uppercase mr-1">Thought:</span>
          <FilterBadge
            label="Analysis"
            icon={<Lightbulb className="h-2.5 w-2.5" />}
            color="text-blue-600"
            isActive={activeThoughtFilters.has('analysis')}
            onClick={() => onToggleThoughtFilter('analysis')}
            count={thoughtTypeCounts.analysis}
          />
          <FilterBadge
            label="Action"
            icon={<Wrench className="h-2.5 w-2.5" />}
            color="text-green-600"
            isActive={activeThoughtFilters.has('action')}
            onClick={() => onToggleThoughtFilter('action')}
            count={thoughtTypeCounts.action}
          />
          <FilterBadge
            label="Search"
            icon={<Search className="h-2.5 w-2.5" />}
            color="text-purple-600"
            isActive={activeThoughtFilters.has('search')}
            onClick={() => onToggleThoughtFilter('search')}
            count={thoughtTypeCounts.search}
          />
          <FilterBadge
            label="Summary"
            icon={<CheckCircle2 className="h-2.5 w-2.5" />}
            color="text-amber-600"
            isActive={activeThoughtFilters.has('summary')}
            onClick={() => onToggleThoughtFilter('summary')}
            count={thoughtTypeCounts.summary}
          />
        </div>

        {/* Vertical divider */}
        <div className="h-4 w-px bg-gray-200" />

        {/* Event type filters */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-gray-400 uppercase mr-1">Event:</span>
          <FilterBadge
            label="Read"
            icon={<Eye className="h-2.5 w-2.5" />}
            color="text-cyan-600"
            isActive={activeEventFilters.has('read')}
            onClick={() => onToggleEventFilter('read')}
            count={eventTypeCounts.read}
          />
          <FilterBadge
            label="Write"
            icon={<Edit3 className="h-2.5 w-2.5" />}
            color="text-orange-600"
            isActive={activeEventFilters.has('write')}
            onClick={() => onToggleEventFilter('write')}
            count={eventTypeCounts.write}
          />
          <FilterBadge
            label="Bash"
            icon={<Terminal className="h-2.5 w-2.5" />}
            color="text-gray-700"
            isActive={activeEventFilters.has('bash')}
            onClick={() => onToggleEventFilter('bash')}
            count={eventTypeCounts.bash}
          />
          <FilterBadge
            label="Search"
            icon={<FolderSearch className="h-2.5 w-2.5" />}
            color="text-indigo-600"
            isActive={activeEventFilters.has('search')}
            onClick={() => onToggleEventFilter('search')}
            count={eventTypeCounts.search}
          />
        </div>
      </div>
    </div>
  );
};

export default RightPaneHeader;
