import React from 'react';
import { Loader2, Download } from 'lucide-react';
import { CostPreview } from './CostPreview';
import { PreviewResult } from '../../api/gitfixApi';

interface PreviewState {
  isLoading: boolean;
  data: PreviewResult | null;
  error: string | null;
  lastSynced: Date | null;
}

interface CostPreviewSectionProps {
  preview: PreviewState;
  isExporting: boolean;
  canExport: boolean;
  onExport: () => void;
}

export const CostPreviewSection: React.FC<CostPreviewSectionProps> = ({
  preview,
  isExporting,
  canExport,
  onExport
}) => {
  return (
    <div className="space-y-3">
      <CostPreview preview={preview} />

      <div className="flex justify-end">
        <button
          onClick={onExport}
          disabled={isExporting || preview.isLoading || !canExport}
          className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1 disabled:text-gray-400 disabled:cursor-not-allowed"
        >
          {isExporting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          Export Context (XML)
        </button>
      </div>
    </div>
  );
};
