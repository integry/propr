import React from 'react';
import { PromptData } from './types';
import { formatModelName } from './utils';
import TaskDialog from './TaskDialog';

interface PromptModalProps {
  prompt: PromptData | null;
  loading: boolean;
  onClose: () => void;
}

const PromptModal: React.FC<PromptModalProps> = ({ prompt, loading, onClose }) => {
  if (!prompt) return null;

  return (
    <TaskDialog title="LLM Prompt" closeLabel="Close prompt" onClose={onClose} sizeClass="sm:h-auto sm:max-w-4xl" testId="prompt-dialog">
      {/* Focusable so keyboard users can scroll a prompt longer than the dialog. */}
      <div
        role="region"
        aria-label="Prompt details"
        tabIndex={0}
        data-testid="prompt-content"
        className="min-h-0 flex-1 overflow-y-auto p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:p-4"
      >
        {loading ? (
          <div className="text-gray-600">Loading prompt...</div>
        ) : prompt.error ? (
          <div className="text-red-600">{prompt.error}</div>
        ) : (
          <div className="space-y-4">
            {(prompt.sessionId || prompt.model || prompt.timestamp || prompt.issueRef) && (
              <MetadataSection prompt={prompt} />
            )}
            {prompt.prompt && <PromptContentSection prompt={prompt} />}
          </div>
        )}
      </div>
    </TaskDialog>
  );
};

interface MetadataSectionProps {
  prompt: PromptData;
}

const MetadataSection: React.FC<MetadataSectionProps> = ({ prompt }) => (
  <div className="bg-gray-50 rounded-md p-3 sm:p-4 border border-gray-200">
    <h4 className="text-sm font-semibold text-gray-600 uppercase mb-3">Prompt Metadata</h4>
    <table className="block w-full text-sm border-collapse sm:table sm:table-fixed">
      <tbody className="block sm:table-row-group">
        {prompt.sessionId && (
          <tr className="block border-b border-gray-200 sm:table-row">
            <td className="block pt-2 sm:table-cell sm:py-2 sm:pr-4 text-gray-600 font-medium align-top sm:w-1/3">Session ID:</td>
            <td className="block pb-2 sm:table-cell sm:py-2 text-gray-700 [overflow-wrap:anywhere]">
              <code className="inline-block max-w-full bg-white px-2 py-1 rounded border border-gray-300 text-xs">{prompt.sessionId}</code>
            </td>
          </tr>
        )}
        {prompt.model && (
          <tr className="block border-b border-gray-200 sm:table-row">
            <td className="block pt-2 sm:table-cell sm:py-2 sm:pr-4 text-gray-600 font-medium align-top sm:w-1/3">Model:</td>
            <td className="block pb-2 sm:table-cell sm:py-2 text-gray-700 [overflow-wrap:anywhere]">
              <div className="text-blue-600 font-medium">{formatModelName(prompt.model)}</div>
            </td>
          </tr>
        )}
        {prompt.timestamp && (
          <tr className="block border-b border-gray-200 sm:table-row">
            <td className="block pt-2 sm:table-cell sm:py-2 sm:pr-4 text-gray-600 font-medium align-top sm:w-1/3">Timestamp:</td>
            <td className="block pb-2 sm:table-cell sm:py-2 text-gray-700 [overflow-wrap:anywhere]">{new Date(prompt.timestamp).toLocaleString()}</td>
          </tr>
        )}
        {prompt.isRetry !== undefined && (
          <tr className="block border-b border-gray-200 sm:table-row">
            <td className="block pt-2 sm:table-cell sm:py-2 sm:pr-4 text-gray-600 font-medium align-top sm:w-1/3">Is Retry:</td>
            <td className={`block pb-2 sm:table-cell sm:py-2 ${prompt.isRetry ? 'text-amber-600 font-medium' : 'text-gray-700'}`}>
              {prompt.isRetry ? 'Yes' : 'No'}
            </td>
          </tr>
        )}
        {prompt.issueRef && (
          <tr className="block sm:table-row">
            <td className="block pt-2 sm:table-cell sm:py-2 sm:pr-4 text-gray-600 font-medium align-top sm:w-1/3">Issue Reference:</td>
            <td className="block pb-2 sm:table-cell sm:py-2 text-gray-700 [overflow-wrap:anywhere]">
              <code className="inline-block max-w-full bg-white px-2 py-1 rounded border border-gray-300 text-xs">
                {prompt.issueRef.repoOwner}/{prompt.issueRef.repoName} #{prompt.issueRef.number}
              </code>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
);

interface PromptContentSectionProps {
  prompt: PromptData;
}

const PromptContentSection: React.FC<PromptContentSectionProps> = ({ prompt }) => (
  <div>
    <h4 className="text-sm font-semibold text-gray-600 uppercase mb-2">Prompt Content</h4>
    {prompt.prompt && prompt.prompt.length > 5000 && (
      <div className="mb-2 text-amber-600 text-sm">
        Large prompt: {prompt.prompt.length} characters
      </div>
    )}
    <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-sm text-gray-700 bg-gray-50 p-4 rounded-md border border-gray-200">
      {prompt.prompt}
    </pre>
  </div>
);

export default PromptModal;
