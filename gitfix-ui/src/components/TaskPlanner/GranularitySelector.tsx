import React from 'react';
import { Square, Layers, LayoutGrid } from 'lucide-react';
import { Granularity } from '../../api/gitfixApi';

const GRANULARITY_OPTIONS: Array<{
  id: Granularity;
  label: string;
  description: string;
  icon: typeof Square;
}> = [
  { 
    id: 'single', 
    label: 'Single Task', 
    description: 'Consolidate all changes into one large GitHub issue.',
    icon: Square 
  },
  { 
    id: 'balanced', 
    label: 'Balanced', 
    description: 'Group related changes logically. (Recommended)',
    icon: Layers 
  },
  { 
    id: 'granular', 
    label: 'Granular', 
    description: 'Create a separate issue for every modified file.',
    icon: LayoutGrid 
  }
];

interface GranularitySelectorProps {
  value: Granularity;
  onChange: (granularity: Granularity) => void;
}

export const GranularitySelector: React.FC<GranularitySelectorProps> = ({ value, onChange }) => {
  return (
    <div className="mb-6">
      <label className="block text-sm font-medium text-gray-700 mb-3">Task Granularity</label>
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
                  : 'border-gray-200 hover:border-gray-300 text-gray-600'
              }`}
              title={option.description}
            >
              <Icon className="w-4 h-4" />
              <span className="font-medium text-sm">{option.label}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {GRANULARITY_OPTIONS.find(o => o.id === value)?.description}
      </p>
    </div>
  );
};
