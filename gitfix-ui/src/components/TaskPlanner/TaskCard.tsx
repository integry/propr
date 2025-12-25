import { useState, forwardRef } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { MessageSquare, StickyNote, Trash2, Eye, Code, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { PlanTask } from '../../api/gitfixApi';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';

interface TaskCardProps {
  task: PlanTask;
  isHighlighted: boolean;
  stepNumber: number;
  onChange: (task: PlanTask) => void;
  onDelete: () => void;
  onAddBelow: () => void;
}

type EditableField = 'title' | 'body' | 'implementation' | 'notes' | null;
type ViewMode = 'preview' | 'markdown';

export const TaskCard = forwardRef<HTMLDivElement, TaskCardProps>(({
  task,
  isHighlighted,
  stepNumber,
  onChange,
  onDelete,
}, ref) => {
  const [editingField, setEditingField] = useState<EditableField>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [isImplementationCollapsed, setIsImplementationCollapsed] = useState(true);

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
          className={`${markdownClassName || className} cursor-default hover:bg-gray-50 rounded p-1 -ml-1 min-h-[24px] text-gray-400 italic`}
        >
          {placeholder}
        </div>
      );
    }

    return (
      <div
        onClick={() => handleFieldClick(field)}
        className={`${markdownClassName || className} cursor-default hover:bg-gray-50 rounded p-1 -ml-1`}
      >
        <MarkdownRenderer text={value} className="prose prose-sm max-w-none" />
      </div>
    );
  };

  const toggleImplementationCollapse = () => {
    setIsImplementationCollapsed(prev => !prev);
  };

  // Generate a preview snippet for collapsed state
  const getImplementationPreview = () => {
    if (!task.implementation) return 'No implementation details';
    const firstLine = task.implementation.split('\n')[0];
    const preview = firstLine.length > 80 ? firstLine.substring(0, 80) + '...' : firstLine;
    return preview || 'Click to expand';
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
        {/* View Mode Toggle and Delete - positioned at top right, not overlaying title */}
        <div className="absolute -top-3 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex items-center gap-2">
          <div className="flex items-center bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => { setViewMode('preview'); setEditingField(null); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors text-sm ${
                viewMode === 'preview'
                  ? 'bg-white text-gray-700 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Eye size={14} />
              Preview
            </button>
            <button
              onClick={() => setViewMode('markdown')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors text-sm ${
                viewMode === 'markdown'
                  ? 'bg-white text-gray-700 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Code size={14} />
              Edit
            </button>
          </div>
          <button onClick={onDelete} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors bg-gray-100">
            <Trash2 size={16} />
          </button>
        </div>

        {/* SECTION 1: ISSUE HEADER (Title & Specification) */}
        <div className="p-6 pb-4">
          <div className="flex items-start gap-3 mb-4">
            <div className="mt-1 w-8 h-8 flex items-center justify-center bg-indigo-600 text-white rounded-full font-semibold text-sm flex-shrink-0">
              {stepNumber}
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
                  className="w-full text-lg font-bold text-gray-900 cursor-default hover:bg-gray-50 rounded px-1 -ml-1"
                >
                  {task.title || <span className="text-gray-400 italic font-normal">Task Title</span>}
                </div>
              )}
              <div className="mt-2">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Specification</span>
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
        <div className="bg-slate-50 border-t border-gray-100 p-6 pt-4 group/impl">
          <div className="flex items-start gap-3">
            <div
              className="mt-1 p-1.5 bg-slate-200 text-slate-600 rounded-md cursor-pointer hover:bg-slate-300 transition-colors"
              onClick={toggleImplementationCollapse}
            >
              <MessageSquare size={16} />
            </div>
            <div className="flex-1">
              <div
                className="flex items-center justify-between mb-2 cursor-pointer select-none"
                onClick={toggleImplementationCollapse}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Suggested Implementation</span>
                  <motion.div
                    animate={{ rotate: isImplementationCollapsed ? 0 : 180 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ChevronDown size={16} className="text-slate-400" />
                  </motion.div>
                </div>
                {task.implementation && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onChange({ ...task, implementation: '' });
                    }}
                    className="opacity-0 group-hover/impl:opacity-100 transition-opacity p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                    title="Clear implementation"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>

              <AnimatePresence initial={false}>
                {isImplementationCollapsed ? (
                  <motion.div
                    key="collapsed"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="text-sm text-slate-400 italic truncate cursor-pointer"
                    onClick={toggleImplementationCollapse}
                  >
                    {getImplementationPreview()}
                  </motion.div>
                ) : (
                  <motion.div
                    key="expanded"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    {renderEditableContent(
                      'implementation',
                      task.implementation,
                      'Implementation details...',
                      'w-full font-mono text-sm text-gray-800 bg-transparent transition-colors',
                      'w-full font-mono text-sm text-gray-800'
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
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

    </div>
  );
});

TaskCard.displayName = 'TaskCard';

export default TaskCard;
