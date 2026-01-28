import { useState, useCallback } from 'react';
import { downloadContext, Granularity, PlannerAttachment } from '../api/gitfixApi';

interface ExportParams {
  draftId: string;
  prompt: string;
  baseBranch: string;
  granularity: Granularity;
  contextLevel: number;
  compress: boolean;
  files: PlannerAttachment[];
}

interface UseContextExportResult {
  isExporting: boolean;
  exportContext: (params: ExportParams) => Promise<void>;
}

export function useContextExport(
  setError: (error: string | null) => void
): UseContextExportResult {
  const [isExporting, setIsExporting] = useState(false);

  const exportContext = useCallback(async (params: ExportParams) => {
    if (!params.prompt.trim() || !params.baseBranch) {
      setError('Please provide a prompt and select a branch before exporting');
      return;
    }

    setIsExporting(true);
    setError(null);

    try {
      const blob = await downloadContext({
        draftId: params.draftId,
        prompt: params.prompt,
        baseBranch: params.baseBranch,
        granularity: params.granularity,
        contextLevel: params.contextLevel,
        compress: params.compress,
        files: params.files.map(f => f.originalName)
      });

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `context-${params.draftId}.xml`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError((err as Error).message || 'Failed to export context');
    } finally {
      setIsExporting(false);
    }
  }, [setError]);

  return { isExporting, exportContext };
}
