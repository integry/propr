import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Check, X } from 'lucide-react';

export interface AddTodoInputProps {
  categoryId: string | null;
  onAdd: (content: string) => void;
  onCancel: () => void;
}

const AddTodoInput: React.FC<AddTodoInputProps> = ({ onAdd, onCancel }) => {
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [content, adjustTextareaHeight]);

  const handleSubmit = () => {
    if (content.trim()) {
      onAdd(content.trim());
      setContent('');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    adjustTextareaHeight();
  };

  return (
    <div className="flex items-start gap-2 p-2.5 rounded-lg border border-teal-300 bg-teal-50">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        placeholder="What needs to be done?"
        autoFocus
        className="flex-1 px-2 py-1 text-sm border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none overflow-hidden bg-white"
        style={{ minHeight: '2rem' }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
          if (e.key === 'Escape') {
            onCancel();
          }
        }}
      />
      <div className="flex flex-col gap-1">
        <button
          onClick={handleSubmit}
          disabled={!content.trim()}
          className="p-1.5 bg-teal-500 text-white rounded hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Add"
        >
          <Check size={14} />
        </button>
        <button
          onClick={onCancel}
          className="p-1.5 bg-slate-200 text-slate-600 rounded hover:bg-slate-300 transition-colors"
          title="Cancel"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

export default AddTodoInput;
