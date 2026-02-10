import React, { useRef, useState, useEffect } from 'react';
import { PlannerAttachment, getAttachmentUrl } from '../../api/gitfixApi';
import { X, FileText, Loader2, Paperclip } from 'lucide-react';
import { resizeImage } from './imageUtils';

interface AttachmentPreviewProps {
  file: PlannerAttachment;
  draftId: string;
  onRemove: (id: string) => void;
}

const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({ file, draftId, onRemove }) => {
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const isImage = file.type === 'image' || file.mimeType?.startsWith('image/') ||
    /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file.originalName);

  useEffect(() => {
    if (!isImage && !textPreview && !isLoadingPreview) {
      setIsLoadingPreview(true);
      fetch(getAttachmentUrl(draftId, file.id), { credentials: 'include' })
        .then(res => res.text())
        .then(text => {
          const preview = text.length > 100 ? text.slice(0, 100) + '...' : text;
          setTextPreview(preview);
        })
        .catch(() => setTextPreview('Unable to load preview'))
        .finally(() => setIsLoadingPreview(false));
    }
  }, [file.id, draftId, isImage, textPreview, isLoadingPreview]);

  return (
    <div className="inline-flex items-center gap-2 bg-gray-100 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm group relative">
      {isImage ? (
        <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0 bg-gray-200 border border-gray-300">
          <img
            src={getAttachmentUrl(draftId, file.id)}
            alt={file.originalName}
            className="w-full h-full object-cover"
            crossOrigin="use-credentials"
          />
        </div>
      ) : (
        <FileText className="w-4 h-4 text-gray-500 flex-shrink-0" />
      )}
      <span className="text-gray-700 max-w-[150px] truncate" title={file.originalName}>
        {file.originalName}
      </span>
      <span className="text-xs text-gray-400">{file.tokenEstimate}t</span>
      <button
        onClick={() => onRemove(file.id)}
        className="ml-1 p-0.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
        title="Remove"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

interface AttachmentUploaderProps {
  files: PlannerAttachment[];
  draftId: string;
  isUploading: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: (attachmentId: string) => Promise<void>;
  compact?: boolean;
}

export const AttachmentUploader: React.FC<AttachmentUploaderProps> = ({
  files,
  draftId,
  isUploading,
  onUpload,
  onRemove,
  compact = false
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const processedFile = await resizeImage(file);
    await onUpload(processedFile);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    const processedFile = await resizeImage(file);
    await onUpload(processedFile);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  // Compact inline version for prompt area integration
  if (compact) {
    return (
      <div className="space-y-2">
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map(f => (
              <AttachmentPreview key={f.id} file={f} draftId={draftId} onRemove={onRemove} />
            ))}
          </div>
        )}

        <div
          className={`flex items-center gap-2 p-2 rounded-lg border-2 border-dashed transition-colors ${
            isDragging
              ? 'border-indigo-400 bg-indigo-50'
              : 'border-gray-200 hover:border-gray-300 bg-gray-50'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <input
            type="file"
            onChange={handleFileChange}
            className="hidden"
            id="file-upload-compact"
            ref={fileInputRef}
            accept="image/*,.log,.txt,.json"
          />
          <label
            htmlFor="file-upload-compact"
            className={`flex items-center gap-2 cursor-pointer text-sm ${isUploading ? 'opacity-50' : ''}`}
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                <span className="text-gray-500">Uploading...</span>
              </>
            ) : (
              <>
                <Paperclip className="w-4 h-4 text-gray-400" />
                <span className="text-gray-500">Add files or drop here</span>
              </>
            )}
          </label>
        </div>
      </div>
    );
  }

  // Full version with larger previews
  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-gray-700">Attachments</label>

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map(f => (
            <AttachmentPreview key={f.id} file={f} draftId={draftId} onRemove={onRemove} />
          ))}
        </div>
      )}

      <div
        className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors ${
          isDragging
            ? 'border-indigo-400 bg-indigo-50'
            : 'border-gray-300 hover:bg-gray-50'
        }`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <input
          type="file"
          onChange={handleFileChange}
          className="hidden"
          id="file-upload"
          ref={fileInputRef}
          accept="image/*,.log,.txt,.json"
        />
        <label
          htmlFor="file-upload"
          className={`cursor-pointer text-indigo-600 hover:text-indigo-500 text-sm ${isUploading ? 'opacity-50' : ''}`}
        >
          {isUploading ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Uploading...
            </span>
          ) : (
            'Upload logs or screenshots (drag & drop or paste supported)'
          )}
        </label>
        <p className="text-xs text-gray-400 mt-1">Images over 1MB will be automatically resized</p>
      </div>
    </div>
  );
};
