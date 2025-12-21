import React, { useState, forwardRef } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { FileText, MessageSquare, StickyNote, Trash2, Eye, Code } from 'lucide-react';
import { PlanTask } from '../../api/gitfixApi';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';

interface TaskCardProps {
  task: PlanTask;
  isHighlighted: boolean;
  onChange: (task: PlanTask) => void;
  onDelete: () => void;
  onAddBelow: () => void;
}

type EditableField = 'title' | 'body' | 'implementation' | 'notes' | null;
type ViewMode = 'preview' | 'markdown';

export const TaskCard = forwardRef<HTMLDivElement, TaskCardProps>(({
  task,
  isHighlighted,
  onChange,
  onDelete,
}, ref) => {
  const [editingField, setEditingField] = useState<EditableField>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');

  const handleFieldClick = (field: EditableField) => {
    if (viewMode === 'markdown') {
      setEditingField(field);
    }
  };

  const handleBlur = () => {
    setEditingField(null);
  };

  const renderEditableContent = (
    field: EditableField,
    value: string,
    placeholder: string,
    className: string,
    markdownClassName?: string
  ) => {
    const isEditing = editingField === field || viewMode === 'markdown';

    if (isEditing) {
      return (
        <TextareaAutosize
          value={value}
          onChange={e => onChange({ ...task, [field as string]: e.target.value })}
          onBlur={handleBlur}
          onFocus={() => setEditingField(field)}
          autoFocus={editingField === field}
          className={`${className} resize-none focus:outline-none focus:bg-gray-50 rounded p-1 -ml-1 cursor-text`}
          placeholder={placeholder}
        />
      );
    }

    // Preview mode - render markdown
    if (!value || value.trim() === '') {
      return (
        <div
          onClick={() => handleFieldClick(field)}
          className={`${markdownClassName || className} cursor-pointer hover:bg-gray-50 rounded p-1 -ml-1 min-h-[24px] text-gray-400 italic`}
        >
          {placeholder}
        </div>
      );
    }

    return (
      <div
        onClick={() => handleFieldClick(field)}
        className={`${markdownClassName || className} cursor-pointer hover:bg-gray-50 rounded p-1 -ml-1`}
      >
        <MarkdownRenderer text={value} className="prose prose-sm max-w-none" />
      </div>
    );
  };

  return (
    <div
      ref={ref}
      className={
        'group relative transition-all duration-500 ' +
        (isHighlighted ? 'ring-2 ring-indigo-400 shadow-lg' : 'hover:shadow-md')
      }
    >
      {/* Main Card Container */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {/* View Mode Toggle */}
        <div className="absolute top-3 right-12 opacity-0 group-hover:opacity-100 transition-opacity z-10">
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5 text-xs">
            <button
              onClick={() => { setViewMode('preview'); setEditingField(null); }}
              className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${
                viewMode === 'preview'
                  ? 'bg-white text-gray-700 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Eye size={12} />
              Preview
            </button>
            <button
              onClick={() => setViewMode('markdown')}
              className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${
                viewMode === 'markdown'
                  ? 'bg-white text-gray-700 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Code size={12} />
              Markdown
            </button>
          </div>
        </div>

        {/* SECTION 1: ISSUE HEADER (Title & Context) */}
        <div className="p-6 pb-4">
          <div className="flex items-start gap-3 mb-4">
            <div className="mt-1 p-1.5 bg-blue-50 text-blue-600 rounded-md">
              <FileText size={18} />
            </div>
            <div className="flex-1">
              {viewMode === 'markdown' || editingField === 'title' ? (
                <input
                  value={task.title}
                  onChange={e => onChange({ ...task, title: e.target.value })}
                  onBlur={handleBlur}
                  onFocus={() => setEditingField('title')}
                  autoFocus={editingField === 'title'}
                  className="w-full text-lg font-bold text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-100 rounded px-1 -ml-1"
                  placeholder="Task Title"
                />
              ) : (
                <div
                  onClick={() => handleFieldClick('title')}
                  className="w-full text-lg font-bold text-gray-900 cursor-pointer hover:bg-gray-50 rounded px-1 -ml-1"
                >
                  {task.title || <span className="text-gray-400 italic font-normal">Task Title</span>}
                </div>
              )}
              <div className="mt-2">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Context</span>
                {renderEditableContent(
                  'body',
                  task.body,
                  'Describe the context...',
                  'w-full mt-1 text-gray-800 leading-relaxed',
                  'w-full mt-1 text-gray-800 leading-relaxed'
                )}
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
              {renderEditableContent(
                'implementation',
                task.implementation,
                'Implementation details...',
                'w-full font-mono text-sm text-gray-800 bg-transparent transition-colors',
                'w-full font-mono text-sm text-gray-800'
              )}
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
              <span className="text-xs font-semibold text-yellow-700 uppercase tracking-wider block mb-1">User Notes</span>
              {renderEditableContent(
                'notes',
                task.notes || '',
                'Add your notes here...',
                'w-full text-sm text-gray-800 bg-transparent placeholder-yellow-600/30',
                'w-full text-sm text-gray-800'
              )}
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
});

TaskCard.displayName = 'TaskCard';

export default TaskCard;
