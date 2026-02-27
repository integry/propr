import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, ScrollText, ListTodo, ChevronRight } from 'lucide-react';
import { RunningItem } from '../hooks/useHeaderStats';

// Utility function for formatting time ago
const formatTimeAgo = (dateString: string): string => {
  const diffMins = Math.floor((Date.now() - new Date(dateString).getTime()) / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
};

// Extract repo name from full path
const getRepoName = (repository: string): string => {
  const parts = repository.split('/');
  return parts.length > 1 ? parts[1] : repository;
};

// Hook for click outside detection
const useClickOutside = (onClose: () => void, isOpen: boolean) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handler);
    }
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, onClose]);
  return ref;
};

interface AIActivityMonitorProps {
  runningItems: RunningItem[];
  runningCount: number;
}

const AIActivityMonitor: React.FC<AIActivityMonitorProps> = ({ runningItems, runningCount }) => {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useClickOutside(() => setIsOpen(false), isOpen);

  // Don't render if nothing is running
  if (runningCount === 0) {
    return null;
  }

  const handleItemClick = (item: RunningItem) => {
    setIsOpen(false);
    if (item.type === 'plan') {
      navigate(`/studio/${item.id}`);
    } else {
      navigate(`/tasks/${item.id}`);
    }
  };

  return (
    <div className="relative h-full" ref={containerRef}>
      {/* Activity Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative flex items-center gap-1.5 px-3 h-full text-sm transition-colors ${
          isOpen ? 'bg-white' : 'hover:bg-slate-50'
        }`}
      >
        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 border border-blue-200">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          <Bot className="w-3.5 h-3.5 text-blue-600" />
          <span className="text-xs font-medium text-blue-700">{runningCount}</span>
          <span className="text-xs text-blue-600">Running</span>
        </div>
        {isOpen && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-blue-600" />}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          className="fixed w-[400px] bg-white border border-slate-200 border-t-0 shadow-xl ring-1 ring-black/5 z-50 overflow-hidden"
          style={{
            top: '64px',
            left: '240px',
          }}
        >
          {/* Header */}
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
            <div className="flex items-baseline justify-between">
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  AI ACTIVITY
                </span>
                <span className="text-[10px] font-bold text-slate-400">
                  ({runningCount})
                </span>
              </div>
            </div>
          </div>

          {/* Scrollable content */}
          <div className="max-h-[400px] overflow-y-auto scrollbar-stealth">
            {runningItems.length === 0 ? (
              <div className="px-4 py-8 text-center flex flex-col items-center gap-2">
                <Bot className="w-8 h-8 text-slate-200" />
                <p className="text-sm text-slate-500">No active processes</p>
              </div>
            ) : (
              runningItems.map((item, index) => (
                <div
                  key={item.id}
                  onClick={() => handleItemClick(item)}
                  className={`px-4 py-2.5 hover:bg-slate-50 transition-colors group cursor-pointer border-b border-slate-50 overflow-hidden ${
                    index === runningItems.length - 1 ? 'border-b-0' : ''
                  }`}
                >
                  {/* Line 1: Icon + Type Badge + Status + Time */}
                  <div className="flex items-center gap-2 mb-0.5">
                    {item.type === 'plan' ? (
                      <ScrollText className="w-3.5 h-3.5 text-teal-500 flex-shrink-0" />
                    ) : (
                      <ListTodo className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                    )}
                    <span className="text-xs text-slate-500">
                      {getRepoName(item.repository)}
                    </span>
                    <span className="text-slate-300">•</span>
                    <span className="px-1.5 py-0.5 bg-blue-50 border border-blue-200 text-xs font-mono text-blue-600">
                      {item.status}
                    </span>
                    <span className="text-xs text-slate-400 ml-auto">
                      {formatTimeAgo(item.createdAt)}
                    </span>
                    <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  {/* Line 2: Title */}
                  <div className="w-full min-w-0 pl-5">
                    <p className="text-sm font-medium text-slate-900 truncate group-hover:text-primary-600">
                      {item.label}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AIActivityMonitor;
