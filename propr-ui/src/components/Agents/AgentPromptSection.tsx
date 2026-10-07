import React, { useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { FileText, Loader2, Paperclip, X } from 'lucide-react';
import { AGENT_PROMPT_MAX_LENGTH, MAX_AGENT_ATTACHMENTS, MAX_AGENT_PREVIOUS_REPORTS } from '@propr/shared';
import type { AgentDefinitionAttachment } from '../../api/agentDefinitionsApi';
import { AGENT_CHIP_CLASSES, AGENT_INPUT_CLASSES, AgentFormRow } from './AgentFormRow';

interface AgentPromptSectionProps {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  previousReportCount: number;
  onPreviousReportCountChange: (count: number) => void;
  /** Saved input files; null until the agent exists, which keeps the drop zone disabled. */
  attachments: AgentDefinitionAttachment[] | null;
  onUpload: (files: File[]) => Promise<void>;
  onRemoveAttachment: (attachmentId: string) => Promise<void>;
  disabled: boolean;
}

const formatSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

/** The prompt, the input files it can refer to, and whether earlier reports are fed back in. */
export const AgentPromptSection: React.FC<AgentPromptSectionProps> = ({
  prompt, onPromptChange, previousReportCount, onPreviousReportCountChange,
  attachments, onUpload, onRemoveAttachment, disabled,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const saved = attachments !== null;
  const canUpload = saved && !disabled && !busy && attachments.length < MAX_AGENT_ATTACHMENTS;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFileError(null);
    try {
      await work();
    } catch (error) {
      setFileError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upload = (files: FileList | null) => {
    if (!files?.length || !canUpload) return;
    void run(() => onUpload(Array.from(files)));
  };

  const includePrevious = previousReportCount > 0;

  return (
    <>
      <AgentFormRow
        label="Prompt"
        htmlFor="agent-prompt"
        hint="What the coding agent should look into and report on. Each run starts from this prompt."
      >
        <div className="rounded-md border border-slate-300 bg-white focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500">
          <TextareaAutosize
            id="agent-prompt"
            value={prompt}
            onChange={event => onPromptChange(event.target.value)}
            minRows={6}
            maxRows={24}
            maxLength={AGENT_PROMPT_MAX_LENGTH}
            disabled={disabled}
            placeholder="Review open pull requests in these repositories and summarize which ones are blocked and why."
            className="block w-full resize-none rounded-t-md border-0 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0 disabled:bg-slate-50"
          />
          <div
            data-testid="agent-attachment-dropzone"
            aria-disabled={!canUpload}
            onDragOver={event => { if (canUpload) { event.preventDefault(); setDragging(true); } }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); upload(event.dataTransfer.files); }}
            className={`flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-2 py-1.5 ${dragging ? 'bg-teal-50' : 'bg-slate-50'} rounded-b-md`}
          >
            {attachments?.map(file => (
              <span key={file.id} className={AGENT_CHIP_CLASSES}>
                <FileText className="h-3 w-3" aria-hidden="true" />
                {file.originalName}
                <span className="text-slate-400">{formatSize(file.size)}</span>
                {!disabled && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => onRemoveAttachment(file.id))}
                    aria-label={`Remove ${file.originalName}`}
                    className="text-slate-400 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </span>
            ))}
            <button
              type="button"
              disabled={!canUpload}
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />}
              {saved ? 'Add input files' : 'Save the automation to add input files'}
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              data-testid="agent-attachment-input"
              onChange={event => { upload(event.target.files); event.target.value = ''; }}
            />
          </div>
        </div>
        {fileError && <p role="alert" className="mt-1 text-xs text-red-700">{fileError}</p>}
      </AgentFormRow>

      <AgentFormRow
        label="Previous reports"
        hint="Feed the most recent reports back in, so each run can say what changed since last time."
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={includePrevious}
              disabled={disabled}
              onChange={event => onPreviousReportCountChange(event.target.checked ? 1 : 0)}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            Include previous reports
          </label>
          {includePrevious && (
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              Count
              <select
                aria-label="Previous report count"
                value={previousReportCount}
                disabled={disabled}
                onChange={event => onPreviousReportCountChange(Number(event.target.value))}
                className={`${AGENT_INPUT_CLASSES} w-auto py-1`}
              >
                {Array.from({ length: MAX_AGENT_PREVIOUS_REPORTS }, (_, index) => index + 1).map(count => (
                  <option key={count} value={count}>{count}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </AgentFormRow>
    </>
  );
};
