import React from 'react';
import { Loader2 } from 'lucide-react';
import { PreviewResult } from '../../api/gitfixApi';

interface PreviewState {
  isLoading: boolean;
  data: PreviewResult | null;
  error: string | null;
  lastSynced: Date | null;
}

interface CostPreviewProps {
  preview: PreviewState;
}

const getCostColorClass = (cost: number) => {
  if (cost > 0.5) return 'bg-red-50 text-red-700 border-red-200';
  if (cost > 0.1) return 'bg-yellow-50 text-yellow-700 border-yellow-200';
  return 'bg-green-50 text-green-700 border-green-200';
};

export const CostPreview: React.FC<CostPreviewProps> = ({ preview }) => {
  return (
    <div className={`mb-6 p-4 rounded-md border transition-opacity ${
      preview.isLoading ? 'opacity-60' : ''
    } ${preview.data ? getCostColorClass(preview.data.stats.costEstimate) : 'bg-gray-50 border-gray-200'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {preview.isLoading ? (
            <span className="flex items-center gap-2 text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              Analyzing...
            </span>
          ) : preview.data ? (
            <>
              <span className="font-bold">Est. Cost: ${preview.data.stats.costEstimate.toFixed(3)}</span>
              <span>({preview.data.stats.totalTokens.toLocaleString()} tokens)</span>
            </>
          ) : preview.error ? (
            <span className="text-red-600">{preview.error}</span>
          ) : (
            <span className="text-gray-500">Enter a prompt to see cost estimate</span>
          )}
        </div>
        {preview.data && preview.data.smartSelection.length > 0 && (
          <span className="text-sm bg-indigo-100 text-indigo-700 px-3 py-1 rounded-full">
            Auto-selected {preview.data.smartSelection.filter(f => f.source === 'auto').length} relevant files
          </span>
        )}
      </div>
      
      {preview.data && preview.data.warnings.length > 0 && (
        <div className="mt-2 text-sm text-yellow-600">
          {preview.data.warnings.map((warning, idx) => (
            <p key={idx}>⚠️ {warning}</p>
          ))}
        </div>
      )}
    </div>
  );
};
