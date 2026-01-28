import React from 'react';
import { Layers, Minimize2, Zap, Clock } from 'lucide-react';

interface ContextLevelSliderProps {
  value: number;
  onChange: (level: number) => void;
  compress?: boolean;
  onCompressChange?: (compress: boolean) => void;
}

const MIN_LEVEL = 10;
const MAX_LEVEL = 100;
const STEP = 10;

// Semantic labels for context levels with speed indication
const getSemanticLabel = (value: number): { label: string; description: string; speed: string } => {
  if (value <= 30) {
    return { label: 'Standard', description: 'Essential files only', speed: 'Faster' };
  }
  if (value <= 60) {
    return { label: 'Comprehensive', description: 'Related modules included', speed: 'Moderate' };
  }
  return { label: 'Deep Dive', description: 'Full context analysis', speed: 'Slower' };
};

const getLabelColor = (value: number): string => {
  if (value <= 30) return 'text-green-600 bg-green-50 border-green-200';
  if (value <= 60) return 'text-blue-600 bg-blue-50 border-blue-200';
  return 'text-purple-600 bg-purple-50 border-purple-200';
};

const getSpeedColor = (value: number): string => {
  if (value <= 30) return 'text-green-600';
  if (value <= 60) return 'text-yellow-600';
  return 'text-orange-600';
};

export const ContextLevelSlider: React.FC<ContextLevelSliderProps> = ({ value, onChange, compress = false, onCompressChange }) => {
  const semantic = getSemanticLabel(value);
  const labelColor = getLabelColor(value);
  const speedColor = getSpeedColor(value);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-gray-500" />
          <label className="text-sm font-medium text-gray-700">
            Context Level
          </label>
        </div>
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1 text-xs ${speedColor}`}>
            {value <= 30 ? (
              <Zap className="w-3.5 h-3.5" />
            ) : (
              <Clock className="w-3.5 h-3.5" />
            )}
            <span>{semantic.speed}</span>
          </div>
          <div className={`px-3 py-1 text-sm font-medium rounded-full border ${labelColor}`}>
            {semantic.label}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <input
          type="range"
          min={MIN_LEVEL}
          max={MAX_LEVEL}
          step={STEP}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
        />
        <div className="flex justify-between text-xs text-gray-400">
          <span>Standard</span>
          <span>Comprehensive</span>
          <span>Deep Dive</span>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        {semantic.description} ({value}% context window)
      </p>

      {onCompressChange && (
        <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 cursor-pointer transition-colors">
          <input
            type="checkbox"
            checked={compress}
            onChange={(e) => onCompressChange(e.target.checked)}
            className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
          />
          <div className="flex items-center gap-2 flex-1">
            <Minimize2 className="w-4 h-4 text-gray-500" />
            <div>
              <span className="text-sm font-medium text-gray-700">Compress context</span>
              <p className="text-xs text-gray-500">
                Remove comments and whitespace to fit more files
              </p>
            </div>
          </div>
        </label>
      )}
    </div>
  );
};
