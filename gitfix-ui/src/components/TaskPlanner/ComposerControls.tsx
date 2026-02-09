import React from 'react';
import { X, FileText, Square, Layers, LayoutGrid } from 'lucide-react';
import { Granularity } from '../../api/gitfixApi';

// Compact Granularity Segmented Control for Composer Bar
export const GranularityPills: React.FC<{
  value: Granularity;
  onChange: (g: Granularity) => void;
}> = ({ value, onChange }) => {
  const options: { id: Granularity; label: string; icon: typeof Square }[] = [
    { id: 'single', label: 'Single', icon: Square },
    { id: 'balanced', label: 'Balanced', icon: Layers },
    { id: 'granular', label: 'Granular', icon: LayoutGrid },
  ];

  return (
    <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
      {options.map((opt) => {
        const Icon = opt.icon;
        const isSelected = value === opt.id;
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
              isSelected
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
};

// Attachment Chip component
export const AttachmentChip: React.FC<{
  file: File;
  onRemove: () => void;
}> = ({ file, onRemove }) => {
  const isImage = file.type.startsWith('image/');

  return (
    <div className="inline-flex items-center gap-1.5 bg-gray-100 border border-gray-200 rounded-lg px-2 py-1 text-sm">
      {isImage ? (
        <div className="w-5 h-5 rounded overflow-hidden flex-shrink-0 bg-gray-200">
          <img
            src={URL.createObjectURL(file)}
            alt={file.name}
            className="w-full h-full object-cover"
          />
        </div>
      ) : (
        <FileText className="w-4 h-4 text-gray-500 flex-shrink-0" />
      )}
      <span className="text-gray-700 max-w-[120px] truncate">{file.name}</span>
      <button
        onClick={onRemove}
        className="p-0.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
