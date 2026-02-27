import React from 'react';
import { PlannerAttachment } from '../../api/proprApi';
import { AttachmentUploader } from './AttachmentUploader';

interface HeroPromptAreaProps {
  prompt: string;
  files: PlannerAttachment[];
  draftId: string;
  isUploading: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onPromptChange: (prompt: string) => void;
  onInput: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onUpload: (file: File) => Promise<void>;
  onRemoveFile: (attachmentId: string) => Promise<void>;
  minHeight?: string;
}

export const HeroPromptArea: React.FC<HeroPromptAreaProps> = ({
  prompt,
  files,
  draftId,
  isUploading,
  textareaRef,
  onPromptChange,
  onInput,
  onPaste,
  onUpload,
  onRemoveFile,
  minHeight = '160px'
}) => {
  return (
    <div className="space-y-3">
      <label className="block text-lg font-semibold text-gray-900 mb-3">
        What would you like to build?
      </label>
      {/* Borderless textarea - white canvas stands on its own with gray Header/Footer framing */}
      <div className="overflow-hidden">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onInput={onInput}
          onPaste={onPaste}
          placeholder="Describe the feature, bug fix, or improvement you want to implement..."
          className="w-full px-5 py-4 text-base border-0 focus:ring-0 resize-none overflow-hidden"
          style={{ minHeight }}
        />
        {/* Integrated attachment area */}
        <div className="px-4 pb-3 border-t border-gray-100 bg-gray-50">
          <AttachmentUploader
            files={files}
            draftId={draftId}
            isUploading={isUploading}
            onUpload={onUpload}
            onRemove={onRemoveFile}
            compact
          />
        </div>
      </div>
      <p className="text-xs text-gray-400">
        Tip: Paste screenshots directly, or drag & drop files for additional context
      </p>
    </div>
  );
};
