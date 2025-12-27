import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, RotateCcw, CheckCircle, Loader2 } from 'lucide-react';
import { revertCommit } from '../api/gitfixApi';

type RevertState = 'idle' | 'processing' | 'success' | 'error';

const RevertPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<RevertState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Read query params
  const repo = searchParams.get('repo') || '';
  const pr = searchParams.get('pr') || '';
  const commit = searchParams.get('commit') || '';
  const commentId = searchParams.get('commentId') || '';
  const owner = searchParams.get('owner') || '';

  const handleConfirmRevert = async () => {
    setState('processing');
    setErrorMessage('');

    try {
      await revertCommit({
        repo,
        pr,
        commit,
        commentId,
        owner,
      });
      setState('success');
    } catch (error) {
      setState('error');
      setErrorMessage(error instanceof Error ? error.message : 'An unexpected error occurred');
    }
  };

  // Validate required params
  const missingParams = [];
  if (!repo) missingParams.push('repo');
  if (!pr) missingParams.push('pr');
  if (!commit) missingParams.push('commit');
  if (!commentId) missingParams.push('commentId');
  if (!owner) missingParams.push('owner');

  if (missingParams.length > 0) {
    return (
      <div className="min-h-screen bg-light-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-md max-w-lg w-full text-center">
          <div className="text-red-600 mb-4">
            <AlertTriangle className="w-12 h-12 mx-auto" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-4">Missing Parameters</h1>
          <p className="text-gray-600 mb-2">
            The following required parameters are missing:
          </p>
          <p className="text-red-600 font-mono">
            {missingParams.join(', ')}
          </p>
        </div>
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div className="min-h-screen bg-light-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-md max-w-lg w-full text-center">
          <div className="text-green-600 mb-4">
            <CheckCircle className="w-12 h-12 mx-auto" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-4">Revert Initiated</h1>
          <p className="text-gray-600">
            You can close this tab and check the PR.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-light-100 flex items-center justify-center">
      <div className="bg-white p-8 rounded-lg shadow-md max-w-lg w-full">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="text-red-600 mb-4">
            <RotateCcw className="w-12 h-12 mx-auto" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Confirm Recursive Revert</h1>
        </div>

        {/* Warning Box */}
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-red-800 mb-2">
                Warning: This action is destructive.
              </p>
              <ul className="text-red-700 text-sm space-y-1.5">
                <li>
                  It will revert the selected commit and <strong>ALL</strong> subsequent code changes.
                </li>
                <li>
                  It will delete the instruction comment and <strong>ALL</strong> subsequent conversation history.
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Commit Info */}
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">Target Commit</h2>
          <div className="font-mono text-sm text-gray-800 break-all">
            {commit}
          </div>
          <div className="mt-2 text-sm text-gray-600">
            <span className="font-medium">Repository:</span> {owner}/{repo}
          </div>
          <div className="text-sm text-gray-600">
            <span className="font-medium">Pull Request:</span> #{pr}
          </div>
        </div>

        {/* Error Message */}
        {state === 'error' && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <p className="text-red-700 text-sm">{errorMessage}</p>
          </div>
        )}

        {/* Confirm Button */}
        <button
          onClick={handleConfirmRevert}
          disabled={state === 'processing'}
          className={`w-full font-medium py-3 px-4 rounded-md transition-colors flex items-center justify-center gap-2 ${
            state === 'processing'
              ? 'bg-gray-400 text-white cursor-not-allowed'
              : 'bg-red-600 hover:bg-red-700 text-white'
          }`}
        >
          {state === 'processing' ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <RotateCcw className="w-5 h-5" />
              Yes, Revert to Previous State
            </>
          )}
        </button>

        {/* Cancel hint */}
        <p className="text-center text-gray-500 text-sm mt-4">
          Close this tab to cancel
        </p>
      </div>
    </div>
  );
};

export default RevertPage;

