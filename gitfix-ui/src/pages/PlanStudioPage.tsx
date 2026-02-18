import React, { useState, useCallback, useEffect } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useDraft } from '../hooks/useDraft';
import SetupWizard from '../components/TaskPlanner/SetupWizard';
import PlanEditor from '../components/TaskPlanner/PlanEditor';
import ApprovedPlanView from '../components/TaskPlanner/ApprovedPlanView';
import SkeletonLoader from '../components/TaskPlanner/SkeletonLoader';
import StudioStepper, { StudioStage } from '../components/TaskPlanner/StudioStepper';
import { PlannerDraft, DraftWithPlan } from '../api/plannerApi';

interface LocationState {
  initialDraft?: DraftWithPlan;
}

interface PlanStudioPageProps {
  isNew?: boolean;
}

const getStageFromStatus = (status: string | undefined): StudioStage => {
  if (!status) return 'draft';

  switch (status) {
    case 'draft':
    case 'generating':
      return 'draft';
    case 'review':
    case 'refining':
      return 'review';
    case 'approved':
    case 'executed':
    case 'pr_created':
    case 'merged':
      return 'execute';
    default:
      return 'draft';
  }
};

const LoadingView: React.FC<{ isNew: boolean }> = ({ isNew }) => (
  <div className="flex items-center justify-center min-h-[400px]">
    <div className="text-center">
      <div className="animate-spin h-8 w-8 border-4 border-indigo-600 border-t-transparent rounded-full mx-auto mb-4" />
      <p className="text-gray-600">{isNew ? 'Creating new plan...' : 'Loading draft...'}</p>
    </div>
  </div>
);

const ErrorView: React.FC<{ error: string | null }> = ({ error }) => (
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

const GeneratingView: React.FC<{ currentStage: StudioStage; taskTitle: string }> = ({ currentStage, taskTitle }) => (
  <div className="h-[calc(100vh-64px)] flex flex-col">
    {/* Fixed Header */}
    <div className="bg-gray-100 px-6 py-4 border-b border-gray-300">
      <StudioStepper currentStage={currentStage} />
    </div>

    {/* Scrollable Canvas */}
    <div className="flex-1 overflow-auto bg-white">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="h-full"
      >
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100">
          <div className="flex items-center gap-4">
            <div className="text-sm text-gray-500 truncate max-w-md">{taskTitle}</div>
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

          <div className="opacity-40">
            <SkeletonLoader count={3} />
          </div>
        </div>
      </motion.div>
    </div>
  </div>
);

const ApprovedView: React.FC<{ currentStage: StudioStage; draft: DraftWithPlan }> = ({ currentStage, draft }) => (
  <div className="h-[calc(100vh-64px)] flex flex-col">
    {/* Fixed Header */}
    <div className="bg-gray-100 px-6 py-4 border-b border-gray-300">
      <StudioStepper currentStage={currentStage} />
    </div>

    {/* Scrollable Canvas */}
    <div className="flex-1 overflow-auto bg-white">
      <ApprovedPlanView draft={draft} />
    </div>
  </div>
);

const ReviewView: React.FC<{ currentStage: StudioStage; draft: DraftWithPlan; onRefetch: () => void }> = ({ currentStage, draft, onRefetch }) => (
  <div className="h-[calc(100vh-64px)] flex flex-col">
    {/* Fixed Header */}
    <div className="bg-gray-100 px-6 py-4 border-b border-gray-300">
      <StudioStepper currentStage={currentStage} />
    </div>

    {/* Scrollable Canvas */}
    <div className="flex-1 overflow-auto bg-white">
      <PlanEditor
        draft={draft}
        originalPrompt={draft.initial_prompt}
        onFinalize={onRefetch}
        onBackToSetup={onRefetch}
      />
    </div>
  </div>
);

const DraftView: React.FC<{ currentStage: StudioStage; draft: PlannerDraft; onRefetch: () => void }> = ({ currentStage, draft, onRefetch }) => (
  <div className="h-[calc(100vh-64px)] flex flex-col">
    {/* Fixed Header */}
    <div className="bg-gray-100 px-6 py-4 border-b border-gray-300">
      <StudioStepper currentStage={currentStage} />
    </div>

    {/* Scrollable Canvas */}
    <div className="flex-1 overflow-auto bg-white">
      <SetupWizard
        draft={draft}
        onGenerateComplete={onRefetch}
      />
    </div>
  </div>
);

const getTaskTitle = (draft: PlannerDraft): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const draftAny = draft as any;
  return draftAny?.task_title || draftAny?.title || 'Untitled Task';
};

const getDocumentTitle = (draft: PlannerDraft | null): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const draftAny = draft as any;
  return draftAny?.name || draftAny?.task_title || draft?.repository || 'Plan Studio';
};

const isApprovedStatus = (status: string | undefined): boolean => {
  return status === 'approved' || status === 'executed' || status === 'pr_created' || status === 'merged';
};

const isReviewStatus = (status: string | undefined): boolean => {
  return status === 'review' || status === 'refining';
};

const isDraftStatus = (status: string | undefined): boolean => {
  return !status || status === 'draft';
};

const isGeneratingStatus = (status: string | undefined): boolean => {
  return status === 'generating';
};

// New Draft View - for /studio/new route
// Now accepts optional draft and callbacks to support seamless auto-save without navigation
const NewDraftView: React.FC<{
  draft?: PlannerDraft;
  onDraftCreated?: (draft: PlannerDraft) => void;
  onRefetch?: () => void;
}> = ({ draft, onDraftCreated, onRefetch }) => (
  <div className="h-[calc(100vh-64px)] flex flex-col">
    {/* Fixed Header */}
    <div className="bg-gray-100 px-6 py-4 border-b border-gray-300">
      <StudioStepper currentStage="draft" />
    </div>

    {/* Scrollable Canvas */}
    <div className="flex-1 overflow-auto bg-white">
      <SetupWizard
        draft={draft}
        onGenerateComplete={onRefetch || (() => {})}
        onDraftCreatedInPlace={onDraftCreated}
      />
    </div>
  </div>
);

// Helper to render the appropriate view based on draft status
const renderDraftView = (
  draft: PlannerDraft,
  currentStage: StudioStage,
  refetch: () => void
): React.ReactElement => {
  if (isGeneratingStatus(draft.status)) {
    return <GeneratingView currentStage={currentStage} taskTitle={getTaskTitle(draft)} />;
  }

  if (isApprovedStatus(draft.status)) {
    return <ApprovedView currentStage={currentStage} draft={draft as DraftWithPlan} />;
  }

  if (isReviewStatus(draft.status)) {
    return <ReviewView currentStage={currentStage} draft={draft as DraftWithPlan} onRefetch={refetch} />;
  }

  return <DraftView currentStage={currentStage} draft={draft} onRefetch={refetch} />;
};

const PlanStudioPage: React.FC<PlanStudioPageProps> = ({ isNew = false }) => {
  const { draftId } = useParams<{ draftId: string }>();
  const location = useLocation();
  const locationState = location.state as LocationState | undefined;
  const initialDraft = locationState?.initialDraft;

  // For /studio/new: track draft created in-place (without navigation)
  const [inPlaceDraft, setInPlaceDraft] = useState<PlannerDraft | null>(null);

  // Reset in-place draft when navigation occurs (detected via location.key change)
  // This ensures stale state doesn't persist when navigating between plans
  useEffect(() => {
    setInPlaceDraft(null);
  }, [location.key]);

  // Handle draft created in-place (auto-save in new mode)
  // This updates the URL without navigation, preserving focus and avoiding flicker
  const handleDraftCreatedInPlace = useCallback((draft: PlannerDraft) => {
    setInPlaceDraft(draft);
    // Update URL without triggering navigation - this keeps the component mounted
    window.history.replaceState(null, '', `/studio/${draft.draft_id}`);
  }, []);

  // Determine the effective draft ID for useDraft
  // When in new mode with an in-place draft, use that draft's ID
  const effectiveDraftId = isNew
    ? (inPlaceDraft?.draft_id || '')
    : (draftId || '');

  const { draft, loading, error, refetch } = useDraft(
    effectiveDraftId,
    { initialData: isNew ? inPlaceDraft : initialDraft }
  );

  // The actual draft to use - prefer the in-place draft when available
  const activeDraft = inPlaceDraft || draft;

  useDocumentTitle(isNew && !inPlaceDraft ? 'New Plan' : getDocumentTitle(activeDraft));

  // Determine effective draft and status for rendering decisions
  // After refetch, 'draft' from useDraft contains the latest status
  const effectiveDraft = draft || inPlaceDraft;
  const currentStage = getStageFromStatus(effectiveDraft?.status);

  // Show the new draft setup page for /studio/new
  // Stay in setup view only while status is 'draft' - transition when plan is generated
  // Check effectiveDraft status to allow auto-transition after plan generation completes
  if (isNew && (!effectiveDraft || isDraftStatus(effectiveDraft.status))) {
    return (
      <NewDraftView
        draft={inPlaceDraft || undefined}
        onDraftCreated={handleDraftCreatedInPlace}
        onRefetch={refetch}
      />
    );
  }

  if (loading) {
    return <LoadingView isNew={false} />;
  }

  if (error || !draft) {
    return <ErrorView error={error} />;
  }

  return renderDraftView(draft, currentStage, refetch);
};

export default PlanStudioPage;
