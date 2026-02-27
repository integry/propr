import React from 'react';
import { PromptData } from './types';
import { formatModelName } from './utils';

interface PromptModalProps {
  prompt: PromptData | null;
  loading: boolean;
  onClose: () => void;
}

const PromptModal: React.FC<PromptModalProps> = ({ prompt, loading, onClose }) => {
  if (!prompt) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[80vh] flex flex-col border border-gray-300 shadow-lg">
        <div className="flex justify-between items-center p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">LLM Prompt</h3>
          <button
            className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
            onClick={onClose}
          >
            &times;
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
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
      </div>
    </div>
  );
};

interface MetadataSectionProps {
  prompt: PromptData;
}

const MetadataSection: React.FC<MetadataSectionProps> = ({ prompt }) => (
  <div className="bg-gray-50 rounded-md p-4 border border-gray-200">
    <h4 className="text-sm font-semibold text-gray-600 uppercase mb-3">Prompt Metadata</h4>
    <table className="w-full text-sm border-collapse">
      <tbody>
        {prompt.sessionId && (
          <tr className="border-b border-gray-200">
            <td className="py-2 pr-4 text-gray-600 font-medium align-top w-1/3">Session ID:</td>
            <td className="py-2 text-gray-700">
              <code className="bg-white px-2 py-1 rounded border border-gray-300 text-xs">{prompt.sessionId}</code>
            </td>
          </tr>
        )}
        {prompt.model && (
          <tr className="border-b border-gray-200">
            <td className="py-2 pr-4 text-gray-600 font-medium align-top w-1/3">Model:</td>
            <td className="py-2 text-gray-700">
              <div className="text-blue-600 font-medium">{formatModelName(prompt.model)}</div>
              <div className="text-xs text-gray-500 mt-1">{prompt.model}</div>
            </td>
          </tr>
        )}
        {prompt.timestamp && (
          <tr className="border-b border-gray-200">
            <td className="py-2 pr-4 text-gray-600 font-medium align-top w-1/3">Timestamp:</td>
            <td className="py-2 text-gray-700">{new Date(prompt.timestamp).toLocaleString()}</td>
          </tr>
        )}
        {prompt.isRetry !== undefined && (
          <tr className="border-b border-gray-200">
            <td className="py-2 pr-4 text-gray-600 font-medium align-top w-1/3">Is Retry:</td>
            <td className={`py-2 ${prompt.isRetry ? 'text-amber-600 font-medium' : 'text-gray-700'}`}>
              {prompt.isRetry ? 'Yes' : 'No'}
            </td>
          </tr>
        )}
        {prompt.issueRef && (
          <tr>
            <td className="py-2 pr-4 text-gray-600 font-medium align-top w-1/3">Issue Reference:</td>
            <td className="py-2 text-gray-700">
              <code className="bg-white px-2 py-1 rounded border border-gray-300 text-xs">
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
    <pre className="whitespace-pre-wrap font-mono text-sm text-gray-700 bg-gray-50 p-4 rounded-md border border-gray-200">
      {prompt.prompt}
    </pre>
  </div>
);

export default PromptModal;
