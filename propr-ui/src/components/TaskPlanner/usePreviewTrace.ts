import { useEffect, useState } from 'react';
import type { GenerationTrace, PlannerDraft } from '../../api/proprApi';

export function usePreviewTrace(
  draft: PlannerDraft | undefined,
  draftId: string,
  isPreviewLoading: boolean
) {
  const [previewTrace, setPreviewTrace] = useState<GenerationTrace | undefined>();

  useEffect(() => {
    if (!draftId || !isPreviewLoading) {
      return void (!isPreviewLoading && setPreviewTrace(undefined));
    }
    if (draft?.generation_trace?.steps?.length) {
      return void setPreviewTrace(draft.generation_trace);
    }

    setPreviewTrace({
      steps: [
        { name: 'relevance', status: 'in_progress' },
        { name: 'context', status: 'pending' },
      ],
    });
  }, [draftId, draft?.generation_trace, isPreviewLoading]);

  return previewTrace;
}
