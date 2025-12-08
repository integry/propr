import React from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useDraft } from '../hooks/useDraft';
import SetupWizard from '../components/TaskPlanner/SetupWizard';
import PlanEditor from '../components/TaskPlanner/PlanEditor';
import { DraftWithPlan } from '../api/gitfixApi';

const TaskPlannerPage: React.FC = () => {
  const { draftId } = useParams<{ draftId: string }>();
  const navigate = useNavigate();
  const { draft, loading, error, refetch } = useDraft(draftId || '');

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
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="animate-spin h-12 w-12 border-4 border-indigo-600 border-t-transparent rounded-full mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Generating Your Plan</h2>
          <p className="text-gray-600 mb-4">
            The AI is analyzing your repository and creating an implementation plan...
          </p>
          <p className="text-sm text-gray-400">This may take a few minutes</p>
        </div>
      </div>
    );
  }

  if (draft.status === 'review') {
    return (
      <div className="h-[calc(100vh-120px)] p-4">
        <PlanEditor 
          draft={draft as DraftWithPlan} 
          onFinalize={() => navigate('/')}
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
