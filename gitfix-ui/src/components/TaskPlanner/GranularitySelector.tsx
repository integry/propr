import React from 'react';
import { Square, Layers, LayoutGrid } from 'lucide-react';
import { Granularity } from '../../api/gitfixApi';

const GRANULARITY_OPTIONS: Array<{
  id: Granularity;
  label: string;
  description: string;
  estimatedIssues: string;
  icon: typeof Square;
}> = [
  {
    id: 'single',
    label: 'Single',
    description: 'Consolidate all changes into one large GitHub issue.',
    estimatedIssues: '1 issue',
    icon: Square
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Group related changes logically. (Recommended)',
    estimatedIssues: '3-5 issues',
    icon: Layers
  },
  {
    id: 'granular',
    label: 'Granular',
    description: 'Create a separate issue for every modified file.',
    estimatedIssues: '5-10 issues',
    icon: LayoutGrid
  }
];

interface GranularitySelectorProps {
  value: Granularity;
  onChange: (granularity: Granularity) => void;
}

export const GranularitySelector: React.FC<GranularitySelectorProps> = ({ value, onChange }) => {
  const selectedOption = GRANULARITY_OPTIONS.find(o => o.id === value);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700">Break plan into issues</label>
        {selectedOption && (
          <span className="text-xs text-indigo-600 font-medium">{selectedOption.estimatedIssues}</span>
        )}
      </div>
      <div className="flex gap-2">
        {GRANULARITY_OPTIONS.map((option) => {
          const Icon = option.icon;
          const isSelected = value === option.id;
          return (
            <button
              key={option.id}
              onClick={() => onChange(option.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 transition-all ${
                isSelected
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                  : 'border-gray-200 bg-white hover:border-gray-300 text-gray-600'
              }`}
              title={option.description}
            >
              <Icon className="w-4 h-4" />
              <span className="font-medium text-sm">{option.label}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-gray-500">
        {selectedOption?.description}
      </p>
    </div>
  );
};
