import React, { useRef, useState, useEffect } from 'react';
import { PlannerAttachment, getAttachmentUrl } from '../../api/gitfixApi';
import { X, FileText, Image, Loader2 } from 'lucide-react';

const MAX_IMAGE_SIZE = 1024;

export const resizeImage = (file: File): Promise<File> => {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/') || file.size <= 1024 * 1024) {
      resolve(file);
      return;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new window.Image();
    
    img.onload = () => {
      let { width, height } = img;
      
      if (width > MAX_IMAGE_SIZE || height > MAX_IMAGE_SIZE) {
        if (width > height) {
          height = (height / width) * MAX_IMAGE_SIZE;
          width = MAX_IMAGE_SIZE;
        } else {
          width = (width / height) * MAX_IMAGE_SIZE;
          height = MAX_IMAGE_SIZE;
        }
      }
      
      canvas.width = width;
      canvas.height = height;
      ctx?.drawImage(img, 0, 0, width, height);
      
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(new File([blob], file.name, { type: file.type }));
        } else {
          resolve(file);
        }
      }, file.type, 0.9);
    };
    
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
};

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
          const preview = text.length > 150 ? text.slice(0, 150) + '...' : text;
          setTextPreview(preview);
        })
        .catch(() => setTextPreview('Unable to load preview'))
        .finally(() => setIsLoadingPreview(false));
    }
  }, [file.id, draftId, isImage, textPreview, isLoadingPreview]);

  return (
    <div className="inline-flex flex-col items-start bg-gray-50 border border-gray-200 rounded-lg p-2 m-1 max-w-[200px] relative group">
      <button
        onClick={() => onRemove(file.id)}
        className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
        title="Remove"
      >
        <X className="w-3 h-3" />
      </button>
      
      {isImage ? (
        <div className="w-full h-24 mb-2 overflow-hidden rounded bg-gray-100 flex items-center justify-center">
          <img
            src={getAttachmentUrl(draftId, file.id)}
            alt={file.originalName}
            className="max-w-full max-h-full object-contain"
            crossOrigin="use-credentials"
          />
        </div>
      ) : (
        <div className="w-full h-24 mb-2 overflow-hidden rounded bg-gray-100 p-2 text-xs font-mono text-gray-600 flex items-start">
          {isLoadingPreview ? (
            <div className="flex items-center justify-center w-full h-full">
              <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
            </div>
          ) : (
            <span className="line-clamp-5 break-all">{textPreview}</span>
          )}
        </div>
      )}
      
      <div className="flex items-center gap-1.5 w-full">
        {isImage ? (
          <Image className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
        ) : (
          <FileText className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
        )}
        <span className="text-xs text-gray-700 truncate flex-1" title={file.originalName}>
          {file.originalName}
        </span>
      </div>
      <span className="text-[10px] text-gray-400 mt-0.5">{file.tokenEstimate} tokens</span>
    </div>
  );
};

interface AttachmentUploaderProps {
  files: PlannerAttachment[];
  draftId: string;
  isUploading: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: (attachmentId: string) => Promise<void>;
}

export const AttachmentUploader: React.FC<AttachmentUploaderProps> = ({
  files,
  draftId,
  isUploading,
  onUpload,
  onRemove
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    const processedFile = await resizeImage(file);
    await onUpload(processedFile);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  return (
    <div className="mb-8">
      <label className="block text-sm font-medium text-gray-700 mb-2">Attachments</label>
      
      {files.length > 0 && (
        <div className="flex flex-wrap mb-4">
          {files.map(f => (
            <AttachmentPreview key={f.id} file={f} draftId={draftId} onRemove={onRemove} />
          ))}
        </div>
      )}
      
      <div 
        className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:bg-gray-50 transition-colors"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
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
