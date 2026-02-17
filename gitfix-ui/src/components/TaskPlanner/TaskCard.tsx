import { useState, forwardRef, useRef, useCallback } from 'react';
import { MessageSquare, Trash2, Pencil, ChevronDown, Maximize2, Minimize2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { PlanTask, uploadAttachment, removeAttachment } from '../../api/gitfixApi';
import { AttachmentUploader } from './AttachmentUploader';
import { resizeImage } from './imageUtils';
import { ClearImplementationDialog } from './ClearImplementationDialog';
import { extractFilePaths } from './taskCardUtils';
import { RenderEditableContent, CollapsedImplementationPreview, EditableField, ViewMode } from './TaskCardComponents';

interface TaskCardProps {
  task: PlanTask;
  isHighlighted: boolean;
  stepNumber: number;
  draftId: string;
  onChange: (task: PlanTask) => void;
  onDelete: () => void;
}

export const TaskCard = forwardRef<HTMLDivElement, TaskCardProps>(({
  task,
  isHighlighted,
  stepNumber,
  draftId,
  onChange,
  onDelete,
}, ref) => {
  const [editingField, setEditingField] = useState<EditableField>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [isImplementationCollapsed, setIsImplementationCollapsed] = useState(true);
  const [isCodeExpanded, setIsCodeExpanded] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const notesTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Extract file paths from implementation for collapsed summary and count
  const filePaths = extractFilePaths(task.implementation);
  const fileCount = filePaths.length;

  const handleFieldClick = (field: EditableField) => {
    // Allow direct editing of notes regardless of view mode
    if (viewMode === 'edit' || field === 'notes') {
      setEditingField(field);
    }
  };

  // Handle attachment upload
  const handleAttachmentUpload = useCallback(async (file: File) => {
    if (!draftId) return;

    setIsUploadingAttachment(true);
    try {
      const attachment = await uploadAttachment(draftId, file);
      const currentAttachments = task.attachments || [];
      onChange({
        ...task,
        attachments: [...currentAttachments, attachment]
      });
    } catch (error) {
      console.error('Failed to upload attachment:', error);
    } finally {
      setIsUploadingAttachment(false);
    }
  }, [draftId, task, onChange]);

  // Handle attachment removal
  const handleAttachmentRemove = useCallback(async (attachmentId: string) => {
    if (!draftId) return;

    try {
      await removeAttachment(draftId, attachmentId);
      const currentAttachments = task.attachments || [];
      onChange({
        ...task,
        attachments: currentAttachments.filter(a => a.id !== attachmentId)
      });
    } catch (error) {
      console.error('Failed to remove attachment:', error);
    }
  }, [draftId, task, onChange]);

  // Handle paste in notes textarea for image upload
  const handleNotesPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const processedFile = await resizeImage(file);
          await handleAttachmentUpload(processedFile);
        }
        return;
      }
    }
  }, [handleAttachmentUpload]);

  const handleBlur = () => {
    setEditingField(null);
  };

  // Helper to create common props for RenderEditableContent
  const editableContentProps = {
    editingField,
    viewMode,
    task,
    onChange,
    onBlur: handleBlur,
    setEditingField,
    handleFieldClick,
    handleNotesPaste,
    notesTextareaRef,
  };

  const toggleImplementationCollapse = () => {
    setIsImplementationCollapsed(prev => !prev);
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
              <RenderEditableContent
                {...editableContentProps}
                field="body"
                value={task.body}
                placeholder="Describe the context..."
                className="w-full mt-1.5 text-gray-700 leading-relaxed text-sm"
                markdownClassName="w-full mt-1.5 text-gray-700 leading-relaxed text-sm"
              />
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
              <div className="flex items-center gap-1">
                {!isImplementationCollapsed && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsCodeExpanded(prev => !prev);
                    }}
                    className="opacity-0 group-hover/impl:opacity-100 transition-opacity p-1 text-gray-400 hover:text-teal-600 hover:bg-gray-100 rounded transition-colors"
                    title={isCodeExpanded ? 'Collapse code' : 'Expand code'}
                  >
                    {isCodeExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </button>
                )}
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
              </div>
            )}
          </div>

          {/* Content */}
          <AnimatePresence initial={false}>
            {isImplementationCollapsed ? (
              <CollapsedImplementationPreview
                filePaths={filePaths}
                implementation={task.implementation}
                onClick={toggleImplementationCollapse}
              />
            ) : (
              <motion.div
                key="expanded"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
              >
                <RenderEditableContent
                  {...editableContentProps}
                  field="implementation"
                  value={task.implementation}
                  placeholder="Implementation details..."
                  className="w-full font-mono text-sm bg-transparent transition-colors placeholder-gray-400"
                  markdownClassName="w-full font-mono text-sm"
                  isCodeExpanded={isCodeExpanded}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* SECTION 3: NOTES (Draft Style - Scratchpad) */}
        <div className="bg-white rounded-lg mt-3 mb-8 p-4 border border-dashed border-gray-300">
          <div className="flex items-start gap-3">
            <div className="mt-1 p-1.5 text-gray-400">
              <Pencil size={16} />
            </div>
            <div className="flex-1">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1">User Notes</span>
              <RenderEditableContent
                {...editableContentProps}
                field="notes"
                value={task.notes || ''}
                placeholder="Add specific constraints, API keys, or reminders for the implementation phase..."
                className="w-full text-sm text-gray-800 bg-transparent placeholder-gray-400"
                markdownClassName="w-full text-sm text-gray-800"
              />
              {/* Attachments section */}
              <div className="mt-3">
                <AttachmentUploader
                  files={task.attachments || []}
                  draftId={draftId}
                  isUploading={isUploadingAttachment}
                  onUpload={handleAttachmentUpload}
                  onRemove={handleAttachmentRemove}
                  compact
                />
              </div>
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
