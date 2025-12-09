import React, { useRef } from 'react';
import { PlannerAttachment } from '../../api/gitfixApi';

const MAX_IMAGE_SIZE = 1024;

const resizeImage = (file: File): Promise<File> => {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/') || file.size <= 1024 * 1024) {
      resolve(file);
      return;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
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

interface AttachmentUploaderProps {
  files: PlannerAttachment[];
  isUploading: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: (attachmentId: string) => Promise<void>;
}

export const AttachmentUploader: React.FC<AttachmentUploaderProps> = ({
  files,
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
      <div 
        className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors"
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
          className={`cursor-pointer text-indigo-600 hover:text-indigo-500 ${isUploading ? 'opacity-50' : ''}`}
        >
          {isUploading ? 'Uploading...' : 'Upload logs or screenshots (drag & drop supported)'}
        </label>
        <p className="text-xs text-gray-400 mt-2">Images over 1MB will be automatically resized</p>
      </div>
      {files.length > 0 && (
        <ul className="mt-4 space-y-2">
          {files.map(f => (
            <li key={f.id} className="text-sm flex items-center justify-between bg-gray-50 p-3 rounded-md">
              <div className="flex items-center gap-2">
                <span>📄</span>
                <span className="text-gray-900">{f.originalName}</span>
                <span className="text-xs text-gray-400">({f.tokenEstimate} tokens)</span>
              </div>
              <button
                onClick={() => onRemove(f.id)}
                className="text-red-600 hover:text-red-700 text-xs font-medium"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
