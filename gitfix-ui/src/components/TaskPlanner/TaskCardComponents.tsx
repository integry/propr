import { RefObject } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { FileText } from 'lucide-react';
import { motion } from 'framer-motion';
import { PlanTask } from '../../api/gitfixApi';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';

export type EditableField = 'title' | 'body' | 'implementation' | 'notes' | null;
export type ViewMode = 'preview' | 'edit';

// Get markdown styles based on field type
function getMarkdownStyles(field: EditableField): string {
  if (field === 'implementation') {
    return "prose prose-sm max-w-none [&_code]:px-1 [&_code]:py-0 [&_code]:rounded-sm [&_code]:font-mono [&_code]:text-xs [&_code]:before:content-none [&_code]:after:content-none";
  }
  return "prose prose-sm max-w-none [&_code]:bg-gray-100 [&_code]:text-gray-600 [&_code]:px-1 [&_code]:py-0 [&_code]:rounded-sm [&_code]:font-mono [&_code]:text-xs [&_code]:before:content-none [&_code]:after:content-none";
}

export interface RenderEditableContentProps {
  field: EditableField;
  value: string;
  placeholder: string;
  className: string;
  markdownClassName?: string;
  isCodeExpanded?: boolean;
  editingField: EditableField;
  viewMode: ViewMode;
  task: PlanTask;
  onChange: (task: PlanTask) => void;
  onBlur: () => void;
  setEditingField: (field: EditableField) => void;
  handleFieldClick: (field: EditableField) => void;
  handleNotesPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  notesTextareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function RenderEditableContent({
  field,
  value,
  placeholder,
  className,
  markdownClassName,
  isCodeExpanded,
  editingField,
  viewMode,
  task,
  onChange,
  onBlur,
  setEditingField,
  handleFieldClick,
  handleNotesPaste,
  notesTextareaRef,
}: RenderEditableContentProps) {
  const isEditing = editingField === field || viewMode === 'edit';
  const isNotesField = field === 'notes';

  if (isEditing) {
    return (
      <TextareaAutosize
        ref={isNotesField ? notesTextareaRef : undefined}
        value={value}
        onChange={e => onChange({ ...task, [field as string]: e.target.value })}
        onBlur={onBlur}
        onFocus={() => setEditingField(field)}
        onPaste={isNotesField ? handleNotesPaste : undefined}
        autoFocus={editingField === field}
        className={`${className} resize-none focus:outline-none focus:bg-gray-50 rounded p-1 -ml-1 cursor-text`}
        placeholder={placeholder}
      />
    );
  }

  const cursorClass = isNotesField ? 'cursor-text' : 'cursor-default';

  if (!value || value.trim() === '') {
    return (
      <div
        onClick={() => handleFieldClick(field)}
        className={`${markdownClassName || className} ${cursorClass} hover:bg-gray-50 rounded p-1 -ml-1 min-h-[24px] text-gray-400 italic`}
      >
        {placeholder}
      </div>
    );
  }

  const markdownStyles = getMarkdownStyles(field);

  return (
    <div
      onClick={() => handleFieldClick(field)}
      className={`${markdownClassName || className} ${cursorClass} hover:bg-gray-50 rounded p-1 -ml-1 task-card-content`}
    >
      <MarkdownRenderer text={value} className={markdownStyles} isCodeExpanded={isCodeExpanded} />
    </div>
  );
}

// Component for rendering collapsed implementation preview
export function CollapsedImplementationPreview({
  filePaths,
  implementation,
  onClick
}: {
  filePaths: string[];
  implementation: string;
  onClick: () => void;
}) {
  const getPreview = () => {
    if (!implementation) return 'No implementation details';
    const firstLine = implementation.split('\n')[0];
    const preview = firstLine.length > 80 ? firstLine.substring(0, 80) + '...' : firstLine;
    return preview || 'Click to expand';
  };

  return (
    <motion.div
      key="collapsed"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
      className="py-3 cursor-pointer"
      onClick={onClick}
    >
      {filePaths.length > 0 ? (
        <div className="border-l-2 border-gray-200 pl-4 ml-2 space-y-1.5">
          {filePaths.map((path, index) => (
            <div key={index} className="flex items-center gap-2 text-sm text-gray-600">
              <FileText size={14} className="text-gray-400 flex-shrink-0" />
              <span className="font-mono text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-sm truncate">{path}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-gray-500 italic">
          {implementation ? getPreview() : 'No implementation details'}
        </div>
      )}
    </motion.div>
  );
}
