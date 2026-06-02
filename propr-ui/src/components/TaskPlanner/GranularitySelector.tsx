import React from 'react';
import { Granularity } from '../../api/proprApi';

const GRANULARITY_OPTIONS: Array<{
  id: Granularity;
  label: string;
  description: string;
  estimatedIssues: string;
}> = [
  {
    id: 'single',
    label: 'Single',
    description: 'Consolidate all changes into one large GitHub issue.',
    estimatedIssues: '1 issue'
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Group related changes logically. (Recommended)',
    estimatedIssues: '3-5 issues'
  },
  {
    id: 'granular',
    label: 'Granular',
    description: 'Break down into many smaller, focused issues.',
    estimatedIssues: '7-15+ issues'
  }
];

interface GranularitySelectorProps {
  value: Granularity;
  onChange: (granularity: Granularity) => void;
  pressedOption?: Granularity;
}

export const GranularitySelector: React.FC<GranularitySelectorProps> = ({ value, onChange, pressedOption }) => {
  const selectedOption = GRANULARITY_OPTIONS.find(o => o.id === value);
  return (
    <div className="space-y-2">
      {/* Row 1: Label on left, estimated issues on right */}
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700">Break plan into issues</label>
        {selectedOption && (
          <span className="text-sm text-indigo-600 font-medium">{selectedOption.estimatedIssues}</span>
        )}
      </div>
      {/* Row 2: Three option buttons */}
      <div className="flex gap-2">
        {GRANULARITY_OPTIONS.map((option) => {
          const isSelected = value === option.id;
          const isPressed = pressedOption === option.id;
          return (
            <button
              key={option.id}
              onClick={() => onChange(option.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border transition-all ${
                isPressed
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-700 shadow-inner'
                  : isSelected
                    ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                    : 'border-gray-200 bg-white hover:border-gray-300 text-gray-600'
              }`}
              title={option.description}
            >
              <span className="font-medium text-sm">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
