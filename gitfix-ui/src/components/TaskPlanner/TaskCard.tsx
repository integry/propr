import React from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { FileText, MessageSquare, StickyNote, Trash2 } from 'lucide-react';
import { PlanTask } from '../../api/gitfixApi';

interface TaskCardProps {
  task: PlanTask;
  isHighlighted: boolean;
  onChange: (task: PlanTask) => void;
  onDelete: () => void;
  onAddBelow: () => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  isHighlighted,
  onChange,
  onDelete
}) => {
  return (
    <div className={'group relative mb-6 transition-all duration-500 ' + (isHighlighted ? 'ring-2 ring-indigo-400 shadow-lg' : 'hover:shadow-md')}>
      {/* Main Card Container */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">

        {/* SECTION 1: ISSUE HEADER (Title & Context) */}
        <div className="p-6 pb-4">
          <div className="flex items-start gap-3 mb-4">
            <div className="mt-1 p-1.5 bg-blue-50 text-blue-600 rounded-md">
              <FileText size={18} />
            </div>
            <div className="flex-1">
              <input
                value={task.title}
                onChange={e => onChange({ ...task, title: e.target.value })}
                className="w-full text-lg font-bold text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-100 rounded px-1 -ml-1"
                placeholder="Task Title"
              />
              <div className="mt-2">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Context</span>
                <TextareaAutosize
                  value={task.body}
                  onChange={e => onChange({ ...task, body: e.target.value })}
                  className="w-full mt-1 text-gray-600 leading-relaxed resize-none focus:outline-none focus:bg-gray-50 rounded p-1 -ml-1"
                  placeholder="Describe the context..."
                />
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 2: IMPLEMENTATION (Comment Style) */}
        <div className="bg-slate-50 border-t border-gray-100 p-6 pt-4">
          <div className="flex items-start gap-3">
            <div className="mt-1 p-1.5 bg-slate-200 text-slate-600 rounded-md">
              <MessageSquare size={16} />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Suggested Implementation</span>
              </div>
              <TextareaAutosize
                value={task.implementation}
                onChange={e => onChange({ ...task, implementation: e.target.value })}
                className="w-full font-mono text-sm text-slate-700 bg-transparent resize-none focus:outline-none focus:bg-white focus:ring-1 focus:ring-slate-200 rounded p-2 -ml-2 transition-colors"
                placeholder="Implementation details..."
              />
            </div>
          </div>
        </div>

        {/* SECTION 3: NOTES (Draft Style) */}
        <div className="bg-yellow-50/50 border-t border-yellow-100/50 p-4">
          <div className="flex items-start gap-3">
            <div className="mt-1 p-1.5 text-yellow-600">
              <StickyNote size={16} />
            </div>
            <div className="flex-1">
              <span className="text-xs font-semibold text-yellow-600/70 uppercase tracking-wider block mb-1">User Notes</span>
              <TextareaAutosize
                value={task.notes || ''}
                onChange={e => onChange({ ...task, notes: e.target.value })}
                className="w-full text-sm text-gray-600 bg-transparent resize-none focus:outline-none placeholder-yellow-600/30"
                placeholder="Add your notes here..."
              />
            </div>
          </div>
        </div>

      </div>

      {/* Hidden Hover Actions */}
      <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
         <button onClick={onDelete} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
            <Trash2 size={16} />
         </button>
      </div>
    </div>
  );
};

export default TaskCard;
