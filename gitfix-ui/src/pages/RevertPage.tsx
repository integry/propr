import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, RotateCcw, CheckCircle, Loader2, GitCommit, ArrowDown, Trash2, GitBranch } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { revertCommit, getRevertPreview, type RevertPreviewResponse, type CommitInfo } from '../api/gitfixApi';

type RevertState = 'loading' | 'idle' | 'processing' | 'success' | 'error';

const CommitItem: React.FC<{ commit: CommitInfo; isRemoved?: boolean; isNewHead?: boolean }> = ({
  commit,
  isRemoved = false,
  isNewHead = false
}) => (
  <div className={`flex items-start gap-3 p-3 rounded-lg border ${
    isRemoved
      ? 'bg-red-50 border-red-200'
      : isNewHead
        ? 'bg-green-50 border-green-300 ring-2 ring-green-400'
        : 'bg-gray-50 border-gray-200'
  }`}>
    <div className={`flex-shrink-0 mt-0.5 ${isRemoved ? 'text-red-500' : isNewHead ? 'text-green-600' : 'text-gray-400'}`}>
      {isRemoved ? <Trash2 className="w-4 h-4" /> : <GitCommit className="w-4 h-4" />}
    </div>
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <code className={`text-xs px-1.5 py-0.5 rounded font-mono ${
          isRemoved
            ? 'bg-red-100 text-red-700'
            : isNewHead
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-200 text-gray-700'
        }`}>
          {commit.shortSha}
        </code>
        {isNewHead && (
          <span className="text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
            NEW HEAD
          </span>
        )}
        {isRemoved && (
          <span className="text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full">
            WILL BE REMOVED
          </span>
        )}
      </div>
      <p className={`text-sm mt-1 truncate ${isRemoved ? 'text-red-700' : 'text-gray-700'}`}>
        {commit.message}
      </p>
      <p className={`text-xs mt-0.5 ${isRemoved ? 'text-red-500' : 'text-gray-500'}`}>
        by {commit.author}
      </p>
    </div>
  </div>
);

const PageWrapper: React.FC<{ children: React.ReactNode; maxWidth?: string }> = ({
  children,
  maxWidth = 'max-w-lg'
}) => (
  <div className="min-h-screen bg-light-100 flex items-center justify-center p-4">
    <div className={`bg-white p-8 rounded-lg shadow-md ${maxWidth} w-full`}>
      {children}
    </div>
  </div>
);

const MissingParamsView: React.FC<{ missingParams: string[] }> = ({ missingParams }) => (
  <PageWrapper>
    <div className="text-center">
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
  </PageWrapper>
);

const LoadingView: React.FC = () => (
  <PageWrapper>
    <div className="text-center">
      <Loader2 className="w-12 h-12 mx-auto animate-spin text-gray-400" />
      <p className="mt-4 text-gray-600">Loading commit information...</p>
    </div>
  </PageWrapper>
);

const SuccessView: React.FC = () => (
  <PageWrapper>
    <div className="text-center">
      <div className="text-green-600 mb-4">
        <CheckCircle className="w-12 h-12 mx-auto" />
      </div>
      <h1 className="text-xl font-bold text-gray-900 mb-4">Revert Initiated</h1>
      <p className="text-gray-600">
        You can close this tab and check the PR.
      </p>
    </div>
  </PageWrapper>
);

const CommitVisualization: React.FC<{ preview: RevertPreviewResponse }> = ({ preview }) => (
  <div className="mb-6">
    <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
      <GitCommit className="w-4 h-4" />
      Commit History Visualization
    </h2>

    <div className="space-y-2">
      {preview.remainingCommits.length > 0 && (
        <>
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Commits that will remain ({preview.remainingCommits.length})
          </div>
          {preview.remainingCommits.map((c, idx) => (
            <CommitItem
              key={c.sha}
              commit={c}
              isNewHead={idx === preview.remainingCommits.length - 1}
            />
          ))}
        </>
      )}

      <div className="flex items-center justify-center py-2">
        <div className="flex-1 border-t border-dashed border-red-300" />
        <div className="px-3 flex items-center gap-2 text-red-500">
          <ArrowDown className="w-5 h-5" />
          <span className="text-xs font-medium uppercase">Revert Point</span>
          <ArrowDown className="w-5 h-5" />
        </div>
        <div className="flex-1 border-t border-dashed border-red-300" />
      </div>

      {preview.commitsToRemove.length > 0 && (
        <>
          <div className="text-xs font-medium text-red-500 uppercase tracking-wide mb-2">
            Commits that will be removed ({preview.commitsToRemove.length})
          </div>
          {preview.commitsToRemove.map((c) => (
            <CommitItem key={c.sha} commit={c} isRemoved />
          ))}
        </>
      )}

      {preview.willRevertToBase && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-4">
          <p className="text-sm text-amber-800">
            <strong>Note:</strong> This will revert <strong>all commits</strong> on this PR branch.
            The branch will be reset to the base branch state ({preview.baseBranch}).
          </p>
        </div>
      )}
    </div>
  </div>
);

const FallbackCommitInfo: React.FC<{ commit: string; owner: string; repo: string; pr: string }> = ({
  commit,
  owner,
  repo,
  pr
}) => (
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
);

const BranchInfo: React.FC<{ branch: string; pr: string }> = ({ branch, pr }) => (
  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
    <div className="flex items-center gap-2 text-blue-800">
      <GitBranch className="w-4 h-4" />
      <span className="font-medium">Branch:</span>
      <code className="bg-blue-100 px-2 py-0.5 rounded text-sm">{branch}</code>
      <span className="text-blue-600">on PR #{pr}</span>
    </div>
  </div>
);

const NewHeadSummary: React.FC<{ newHead: CommitInfo }> = ({ newHead }) => (
  <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
    <h2 className="text-sm font-medium text-green-700 mb-2">After Revert: New HEAD Commit</h2>
    <div className="flex items-center gap-2">
      <code className="bg-green-100 text-green-800 px-2 py-1 rounded font-mono text-sm">
        {newHead.shortSha}
      </code>
      <span className="text-green-700 text-sm truncate">{newHead.message}</span>
    </div>
  </div>
);

const ErrorMessage: React.FC<{ message: string }> = ({ message }) => (
  <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
    <p className="text-red-700 text-sm">{message}</p>
  </div>
);

const ConfirmButton: React.FC<{ isProcessing: boolean; onClick: () => void }> = ({
  isProcessing,
  onClick
}) => (
  <button
    onClick={onClick}
    disabled={isProcessing}
    className={`w-full font-medium py-3 px-4 rounded-md transition-colors flex items-center justify-center gap-2 ${
      isProcessing
        ? 'bg-gray-400 text-white cursor-not-allowed'
        : 'bg-red-600 hover:bg-red-700 text-white'
    }`}
  >
    {isProcessing ? (
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
);

const WarningBox: React.FC = () => (
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
);

const RevertPage: React.FC = () => {
  useDocumentTitle('Revert Commit');
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<RevertState>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [preview, setPreview] = useState<RevertPreviewResponse | null>(null);

  const repo = searchParams.get('repo') || '';
  const pr = searchParams.get('pr') || '';
  const commit = searchParams.get('commit') || '';
  const commentId = searchParams.get('commentId') || '';
  const owner = searchParams.get('owner') || '';

  const missingParams: string[] = [];
  if (!repo) missingParams.push('repo');
  if (!pr) missingParams.push('pr');
  if (!commit) missingParams.push('commit');
  if (!commentId) missingParams.push('commentId');
  if (!owner) missingParams.push('owner');

  useEffect(() => {
    if (missingParams.length > 0) {
      setState('idle');
      return;
    }

    const fetchPreview = async () => {
      try {
        const data = await getRevertPreview({ owner, repo, pr, commit });
        setPreview(data);
        setState('idle');
      } catch (error) {
        console.error('Failed to fetch revert preview:', error);
        setState('idle');
      }
    };

    fetchPreview();
  }, [owner, repo, pr, commit, missingParams.length]);

  const handleConfirmRevert = async () => {
    setState('processing');
    setErrorMessage('');

    try {
      await revertCommit({ repo, pr, commit, commentId, owner });
      setState('success');
    } catch (error) {
      setState('error');
      setErrorMessage(error instanceof Error ? error.message : 'An unexpected error occurred');
    }
  };

  if (missingParams.length > 0) {
    return <MissingParamsView missingParams={missingParams} />;
  }

  if (state === 'loading') {
    return <LoadingView />;
  }

  if (state === 'success') {
    return <SuccessView />;
  }

  return (
    <PageWrapper maxWidth="max-w-2xl">
      <div className="text-center mb-6">
        <div className="text-red-600 mb-4">
          <RotateCcw className="w-12 h-12 mx-auto" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Confirm Recursive Revert</h1>
      </div>

      <WarningBox />

      {preview && <BranchInfo branch={preview.branch} pr={pr} />}

      {preview && <CommitVisualization preview={preview} />}

      {!preview && <FallbackCommitInfo commit={commit} owner={owner} repo={repo} pr={pr} />}

      {preview?.newHead && <NewHeadSummary newHead={preview.newHead} />}

      {state === 'error' && <ErrorMessage message={errorMessage} />}

      <ConfirmButton isProcessing={state === 'processing'} onClick={handleConfirmRevert} />

      <p className="text-center text-gray-500 text-sm mt-4">
        Close this tab to cancel
      </p>
    </PageWrapper>
  );
};

export default RevertPage;
