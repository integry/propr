import { useState, forwardRef, useRef, useEffect } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { MessageSquare, StickyNote, Trash2, Pencil, ChevronDown, AlertCircle, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { PlanTask } from '../../api/gitfixApi';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';

// Confirmation dialog component for clearing implementation
interface ClearImplementationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  fileCount: number;
}

const ClearImplementationDialog: React.FC<ClearImplementationDialogProps> = ({ isOpen, onClose, onConfirm, fileCount }) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    dialogRef.current?.focus();

    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              onClose();
            }
          }}
        >
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="bg-white rounded-lg max-w-md w-full border border-gray-300 shadow-lg"
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-implementation-dialog-title"
          >
            <div className="p-6">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                  <AlertCircle className="w-5 h-5 text-red-600" />
                </div>
                <div className="flex-1">
                  <h3 id="clear-implementation-dialog-title" className="text-lg font-semibold text-gray-900 mb-2">
                    Clear Implementation Details?
                  </h3>
                  <p className="text-sm text-gray-600 mb-4">
                    This will remove the suggested implementation containing {fileCount} file{fileCount !== 1 ? 's' : ''}.
                    This action cannot be undone.
                  </p>
                  <p className="text-sm text-gray-600">
                    Are you sure you want to continue?
                  </p>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors"
              >
                Clear Implementation
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// Helper to extract file paths from implementation markdown
const extractFilePaths = (implementation: string): string[] => {
  if (!implementation) return [];

  const filePaths: string[] = [];
  const lines = implementation.split('\n');

  for (const line of lines) {
    // Match patterns like: "File: path", "**File: path**", "### File: `path`", etc.
    const fileMatch = line.match(/^(?:#{1,6}\s+)?(?:\*\*)?File:\s*[`]?([^`\n]+?)[`]?(?:\*\*)?$/i);
    if (fileMatch) {
      filePaths.push(fileMatch[1].trim());
    }
  }

  // If no File: patterns found, try to extract from code block language hints
  if (filePaths.length === 0) {
    const codeBlockMatches = implementation.matchAll(/```(\w+)/g);
    for (const match of codeBlockMatches) {
      // Count code blocks as generic files
      filePaths.push(`(${match[1]} code block)`);
    }
  }

  return filePaths;
};

interface TaskCardProps {
  task: PlanTask;
  isHighlighted: boolean;
  stepNumber: number;
  onChange: (task: PlanTask) => void;
  onDelete: () => void;
}

type EditableField = 'title' | 'body' | 'implementation' | 'notes' | null;
type ViewMode = 'preview' | 'edit';

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
  const [showClearDialog, setShowClearDialog] = useState(false);

  // Extract file paths from implementation for collapsed summary and count
  const filePaths = extractFilePaths(task.implementation);
  const fileCount = filePaths.length;

  const handleFieldClick = (field: EditableField) => {
    if (viewMode === 'edit') {
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
    const isEditing = editingField === field || viewMode === 'edit';

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
        className={`${markdownClassName || className} cursor-default hover:bg-gray-50 rounded p-1 -ml-1 task-card-content`}
      >
        <MarkdownRenderer text={value} className="prose prose-sm max-w-none [&_code]:bg-gray-100 [&_code]:text-gray-600 [&_code]:px-1 [&_code]:py-0 [&_code]:rounded-sm [&_code]:font-mono [&_code]:text-xs [&_code]:before:content-none [&_code]:after:content-none" />
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
        (isHighlighted ? 'ring-2 ring-indigo-400 ring-offset-4 ring-offset-white' : '')
      }
    >
      {/* Main Content Container - Borderless document stream style */}
      <div className="bg-white">
        {/* SECTION 1: ISSUE CONTENT (Title & Specification) */}
        <div className="pb-4">
          <div className="flex flex-col gap-3">
            {/* Title Row with Step Number, Title, Edit Icon, and Delete */}
            <div className="flex items-start gap-3">
              <span className="text-xl font-semibold flex-shrink-0 mt-0.5" style={{ color: 'rgb(29, 138, 138)' }}>{stepNumber}.</span>
              <div className="flex-1 min-w-0">
                {viewMode === 'edit' || editingField === 'title' ? (
                  <input
                    value={task.title}
                    onChange={e => onChange({ ...task, title: e.target.value })}
                    onBlur={handleBlur}
                    onFocus={() => setEditingField('title')}
                    autoFocus={editingField === 'title'}
                    className="w-full text-xl font-semibold text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 rounded px-2 py-1 -ml-2 border border-transparent focus:border-indigo-200"
                    placeholder="Task Title"
                  />
                ) : (
                  <h3
                    onClick={() => handleFieldClick('title')}
                    className="text-xl font-semibold text-gray-900 cursor-default hover:bg-gray-50 rounded px-2 py-1 -ml-2 leading-tight"
                  >
                    {task.title || <span className="text-gray-400 italic font-normal">Task Title</span>}
                  </h3>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {/* Edit Toggle Icon */}
                <button
                  onClick={() => setViewMode(viewMode === 'edit' ? 'preview' : 'edit')}
                  className={`p-1.5 rounded-md transition-colors ${
                    viewMode === 'edit'
                      ? 'text-teal-600 bg-teal-50 hover:bg-teal-100'
                      : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                  }`}
                  title={viewMode === 'edit' ? 'Done editing' : 'Edit task'}
                >
                  <Pencil size={14} />
                </button>
                {/* Delete Button */}
                <button
                  onClick={onDelete}
                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                  title="Delete task"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <div className="mt-1">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Specification</span>
              {renderEditableContent(
                'body',
                task.body,
                'Describe the context...',
                'w-full mt-1.5 text-gray-700 leading-relaxed text-sm',
                'w-full mt-1.5 text-gray-700 leading-relaxed text-sm'
              )}
            </div>
          </div>
        </div>

        {/* SECTION 2: IMPLEMENTATION (Dark Code Window Style) */}
        <div className="mt-4 group/impl">
          {/* Header */}
          <div
            className="flex items-center justify-between py-3 cursor-pointer select-none"
            onClick={toggleImplementationCollapse}
          >
            <div className="flex items-center gap-3">
              <div className="p-1.5 text-gray-500 rounded-md">
                <MessageSquare size={14} />
              </div>
              <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">
                Suggested Implementation{fileCount > 0 && ` (${fileCount} FILE${fileCount !== 1 ? 'S' : ''})`}
              </span>
              <motion.div
                animate={{ rotate: isImplementationCollapsed ? 0 : 180 }}
                transition={{ duration: 0.2 }}
              >
                <ChevronDown size={14} className="text-gray-400" />
              </motion.div>
            </div>
            {task.implementation && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowClearDialog(true);
                }}
                className="opacity-0 group-hover/impl:opacity-100 transition-opacity p-1 text-gray-400 hover:text-red-500 hover:bg-gray-100 rounded transition-colors"
                title="Clear implementation"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>

          {/* Content */}
          <AnimatePresence initial={false}>
            {isImplementationCollapsed ? (
              <motion.div
                key="collapsed"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="py-3 cursor-pointer"
                onClick={toggleImplementationCollapse}
              >
                {filePaths.length > 0 ? (
                  <div className="space-y-1.5">
                    {filePaths.map((path, index) => (
                      <div key={index} className="flex items-center gap-2 text-sm text-gray-600">
                        <FileText size={14} className="text-gray-400 flex-shrink-0" />
                        <span className="font-mono text-xs truncate">{path}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500 italic">
                    {task.implementation ? getImplementationPreview() : 'No implementation details'}
                  </div>
                )}
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
                  'w-full font-mono text-sm text-gray-700 bg-transparent transition-colors placeholder-gray-400',
                  'w-full font-mono text-sm text-gray-700 [&_code]:bg-gray-100 [&_code]:text-gray-700'
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* SECTION 3: NOTES (Draft Style - Scratchpad) */}
        <div className="bg-white rounded-lg mt-3 mb-8 p-4 border border-dashed border-gray-300">
          <div className="flex items-start gap-3">
            <div className="mt-1 p-1.5 text-gray-400">
              <StickyNote size={16} />
            </div>
            <div className="flex-1">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1">User Notes</span>
              {renderEditableContent(
                'notes',
                task.notes || '',
                'Add specific constraints, API keys, or reminders for the implementation phase...',
                'w-full text-sm text-gray-800 bg-transparent placeholder-gray-400',
                'w-full text-sm text-gray-800'
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog for clearing implementation */}
      <ClearImplementationDialog
        isOpen={showClearDialog}
        onClose={() => setShowClearDialog(false)}
        onConfirm={() => {
          onChange({ ...task, implementation: '' });
          setShowClearDialog(false);
        }}
        fileCount={fileCount || 1}
      />
    </div>
  );
});

TaskCard.displayName = 'TaskCard';

export default TaskCard;
