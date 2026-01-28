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
      className="w-full py-3 rounded-xl font-medium text-base transition-all border-2 border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50 disabled:border-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
    >
      {isExporting ? (
        <>
          <Loader2 className="w-5 h-5 animate-spin" />
          Exporting...
        </>
      ) : (
        <>
          <Download className="w-5 h-5" />
          Export Context (XML)
        </>
      )}
    </button>
  );
};
