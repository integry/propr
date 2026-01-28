import React from 'react';
import { Loader2, Sparkles } from 'lucide-react';

interface GenerateButtonProps {
  isGenerating: boolean;
  isPreviewLoading: boolean;
  isRepoLoading: boolean;
  disabled: boolean;
  onClick: () => void;
  costEstimate?: number;
}

export const GenerateButton: React.FC<GenerateButtonProps> = ({
  isGenerating,
  isPreviewLoading,
  isRepoLoading,
  disabled,
  onClick,
  costEstimate,
}) => {
  const buttonContent = () => {
    if (isGenerating) {
      return (
        <span className="flex items-center justify-center gap-2">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Generating Plan...
        </span>
      );
    }
    if (isPreviewLoading) {
      return (
        <span className="flex items-center justify-center gap-2">
          <Loader2 className="w-5 h-5 animate-spin" />
          Syncing...
        </span>
      );
    }
    if (isRepoLoading) {
      return (
        <span className="flex items-center justify-center gap-2">
          <Loader2 className="w-5 h-5 animate-spin" />
          Loading repository info...
        </span>
      );
    }

    return (
      <span className="flex items-center justify-center gap-2">
        <Sparkles className="w-5 h-5" />
        <span>Generate Plan</span>
        {costEstimate !== undefined && costEstimate > 0 && (
          <span className="ml-1 px-2 py-0.5 text-sm bg-white/20 rounded-full">
            ${costEstimate.toFixed(2)}
          </span>
        )}
      </span>
    );
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full py-4 rounded-xl font-semibold text-lg transition-all ${
        disabled
          ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
          : 'bg-gradient-to-r from-indigo-600 to-indigo-700 text-white hover:from-indigo-700 hover:to-indigo-800 shadow-lg hover:shadow-xl cursor-pointer'
      }`}
    >
      {buttonContent()}
    </button>
  );
};
