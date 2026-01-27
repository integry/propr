import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useDraft } from '../hooks/useDraft';
import SetupWizard from '../components/TaskPlanner/SetupWizard';
import PlanEditor from '../components/TaskPlanner/PlanEditor';
import ApprovedPlanView from '../components/TaskPlanner/ApprovedPlanView';
import SkeletonLoader from '../components/TaskPlanner/SkeletonLoader';
import { DraftWithPlan } from '../api/gitfixApi';

const TaskPlannerPage: React.FC = () => {
  const { draftId } = useParams<{ draftId: string }>();
  const { draft, loading, error, refetch } = useDraft(draftId || '');

  // Set document title with plan/draft name or repository
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const draftAny = draft as any;
  const documentTitle = draftAny?.name || draftAny?.task_title || draft?.repository || 'Plan';
  useDocumentTitle(documentTitle);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-4 border-indigo-600 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-gray-600">Loading draft...</p>
        </div>
      </div>
    );
  }

  if (error || !draft) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <h2 className="text-xl font-semibold text-red-700 mb-2">Error Loading Draft</h2>
          <p className="text-red-600 mb-4">{error || 'Draft not found'}</p>
          <Link 
            to="/" 
            className="inline-block px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
          >
            Return to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (draft.status === 'generating') {
    return (
      <div className="h-[calc(100vh-120px)] p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="h-full bg-white rounded-lg shadow overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
            <div className="flex items-center gap-4">
              <div className="text-sm text-gray-500 truncate max-w-md">{draft.task_title || draft.title || 'Untitled Task'}</div>
              <span className="px-2 py-1 rounded text-xs font-medium bg-yellow-100 text-yellow-700 flex items-center gap-1">
                <motion.span
                  animate={{ opacity: [1, 0.5, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                  className="w-2 h-2 bg-yellow-500 rounded-full"
                />
                Generating
              </span>
            </div>
          </div>

          {/* Message overlay */}
          <div className="relative h-[calc(100%-56px)]">
            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.3 }}
                className="bg-white/90 backdrop-blur-sm rounded-xl shadow-xl p-6 text-center max-w-md"
              >
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full mx-auto mb-4"
                />
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Generating Your Plan</h3>
                <p className="text-gray-600 text-sm">
                  The AI is analyzing your repository and creating an implementation plan...
                </p>
              </motion.div>
            </div>

            {/* Skeleton background */}
            <div className="opacity-40">
              <SkeletonLoader count={3} />
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  if (draft.status === 'approved' || draft.status === 'executed') {
    return (
      <div className="h-[calc(100vh-120px)] p-4">
        <ApprovedPlanView draft={draft as DraftWithPlan} />
      </div>
    );
  }

  if (draft.status === 'review') {
    return (
      <div className="h-[calc(100vh-120px)] p-4">
        <PlanEditor 
          draft={draft as DraftWithPlan} 
          onFinalize={() => refetch()}
        />
      </div>
    );
  }

  return (
    <SetupWizard 
      draft={draft} 
      onGenerateComplete={refetch}
    />
  );
};

export default TaskPlannerPage;
