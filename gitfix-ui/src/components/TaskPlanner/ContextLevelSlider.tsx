import React from 'react';

interface ContextLevelSliderProps {
  value: number;
  onChange: (level: number) => void;
  compress?: boolean;
  onCompressChange?: (compress: boolean) => void;
}

const MIN_LEVEL = 10;
const MAX_LEVEL = 100;
const STEP = 10;

export const ContextLevelSlider: React.FC<ContextLevelSliderProps> = ({ value, onChange, compress = false, onCompressChange }) => {
  return (
    <div className="mb-6">
      <label className="block text-sm font-medium text-gray-700 mb-3">
        Context Level: {value}%
      </label>
      <input
        type="range"
        min={MIN_LEVEL}
        max={MAX_LEVEL}
        step={STEP}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
      />
      <div className="flex justify-between text-xs text-gray-500 mt-1">
        <span>{MIN_LEVEL}%</span>
        <span>{MAX_LEVEL}%</span>
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Controls how much repository context is included. Higher values include more files but increase cost.
      </p>

      {onCompressChange && (
        <div className="mt-4 flex items-start gap-3">
          <input
            type="checkbox"
            id="compress-context"
            checked={compress}
            onChange={(e) => onCompressChange(e.target.checked)}
            className="mt-1 h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
          />
          <label htmlFor="compress-context" className="text-sm">
            <span className="font-medium text-gray-700">Compress context</span>
            <p className="text-xs text-gray-500 mt-0.5">
              Removes comments, whitespace, and simplifies code structure to fit more files. May reduce code readability.
            </p>
          </label>
        </div>
      )}
    </div>
  );
};
