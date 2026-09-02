import { AlertCircle, Loader2 } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { GoalCreateForm, GoalCreateHeader } from './GoalCreateForm';
import { useGoalCreateForm } from './useGoalCreateForm';

const GoalCreatePage = () => {
  useDocumentTitle('New Goal');
  const form = useGoalCreateForm();

  if (form.catalogLoading) {
    return (
      <div className="flex h-full flex-col">
        <GoalCreateHeader onBack={form.cancel} />
        <div className="flex flex-1 items-center justify-center" role="status" aria-label="Loading goal catalog">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (form.catalogError) {
    return (
      <div className="flex h-full flex-col">
        <GoalCreateHeader onBack={form.cancel} />
        <div className="flex-1 px-4 py-6 sm:px-6">
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {form.catalogError}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <GoalCreateHeader onBack={form.cancel} />
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-2xl">
          {form.isDemoMode && (
            <div role="status" className="mb-6 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              Goal creation is disabled in demo mode. You can inspect the settings but cannot submit.
            </div>
          )}
          <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
            <p className="mb-1 font-medium">What is a Goal?</p>
            <p>A goal hosts one coding agent&apos;s native goal session until it completes, pauses, is cancelled, or fails. The agent owns its plan and may create GitHub artifacts; ProPR observes those artifacts without scheduling them.</p>
          </div>
          <GoalCreateForm {...form} />
        </div>
      </div>
    </div>
  );
};

export default GoalCreatePage;
