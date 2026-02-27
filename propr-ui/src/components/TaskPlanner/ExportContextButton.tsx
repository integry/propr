import React from 'react';
import { Loader2, Download } from 'lucide-react';

interface ExportContextButtonProps {
  isExporting: boolean;
  isPreviewLoading: boolean;
  canExport: boolean;
  onExport: () => void;
}

export const ExportContextButton: React.FC<ExportContextButtonProps> = ({
  isExporting,
  isPreviewLoading,
  canExport,
  onExport
}) => {
  return (
    <button
      onClick={onExport}
      disabled={isExporting || isPreviewLoading || !canExport}
      className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors disabled:text-gray-300 disabled:cursor-not-allowed"
    >
      {isExporting ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Exporting...</span>
        </>
      ) : (
        <>
          <Download className="w-4 h-4" />
          <span>Export Context (XML)</span>
        </>
      )}
    </button>
  );
};
