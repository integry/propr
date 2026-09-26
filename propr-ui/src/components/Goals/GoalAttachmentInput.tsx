import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FileText, Loader2, Paperclip, X } from 'lucide-react';
import { resizeImage } from '../TaskPlanner/imageUtils';

const MAX_FILES = 10;
const goalAttachmentAccept = 'image/*,.txt,.md,.csv,.json,.log';

interface GoalAttachmentInputProps {
  files: File[];
  onChange: (files: File[]) => void;
  onFilesSelected?: () => void;
  onProcessingChange?: (processing: boolean) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  compact?: boolean;
}

function SelectedFile({ file, onRemove, disabled }: { file: File; onRemove: () => void; disabled: boolean }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <div className="group inline-flex max-w-full items-center gap-2 rounded-md border border-slate-200 bg-slate-50 py-1.5 pl-1.5 pr-2 text-xs text-slate-700">
    {previewUrl
      ? <img src={previewUrl} alt="" className="h-8 w-8 rounded object-cover" />
      : <FileText className="ml-1 h-4 w-4 flex-none text-slate-400" />}
    <span className="max-w-48 truncate" title={file.name}>{file.name}</span>
    <button type="button" aria-label={`Remove ${file.name}`} disabled={disabled} onClick={onRemove} className="rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"><X className="h-3.5 w-3.5" /></button>
  </div>;
}

export function GoalAttachmentInput({ files, onChange, onFilesSelected, onProcessingChange, onError, disabled = false, compact = false }: GoalAttachmentInputProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);

  const addFiles = useCallback(async (incoming: File[]) => {
    if (disabled || processing) return;
    if (files.length + incoming.length > MAX_FILES) {
      onError(`Attach up to ${MAX_FILES} files to each prompt.`);
      return;
    }
    if (incoming.length === 0) return;
    onFilesSelected?.();
    setProcessing(true);
    onProcessingChange?.(true);
    try {
      onChange([...files, ...await Promise.all(incoming.map(resizeImage))]);
    } catch {
      onError('Could not process the selected files.');
    } finally {
      setProcessing(false);
      onProcessingChange?.(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [files, onChange, onError, onFilesSelected, onProcessingChange, disabled, processing]);

  const chooseFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    void addFiles(Array.from(event.target.files || []));
  };
  const dropFiles = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files || []));
  };

  return <div className={compact ? 'space-y-2' : 'mt-2 space-y-2'}>
    {files.length > 0 && <div aria-label="Files attached to prompt" className="flex flex-wrap gap-2">
      {files.map((file, index) => <SelectedFile key={`${file.name}-${file.size}-${file.lastModified}-${index}`} file={file} disabled={disabled || processing} onRemove={() => onChange(files.filter((_, candidate) => candidate !== index))} />)}
    </div>}
    <div
      onDrop={dropFiles}
      onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={event => { event.preventDefault(); setDragging(false); }}
      className={`flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs transition ${dragging ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-slate-300 text-slate-500 hover:border-slate-400'} ${disabled ? 'opacity-50' : ''}`}
    >
      <input ref={inputRef} id={inputId} type="file" multiple accept={goalAttachmentAccept} disabled={disabled || processing} onChange={chooseFiles} className="hidden" />
      <label htmlFor={inputId} className={`inline-flex items-center gap-1.5 font-medium ${disabled || processing ? 'cursor-not-allowed' : 'cursor-pointer hover:text-slate-700'}`}>
        {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
        {processing ? 'Preparing files…' : 'Attach files'}
      </label>
      <span className="hidden sm:inline">or drop them here · paste images into the prompt</span>
    </div>
  </div>;
}
