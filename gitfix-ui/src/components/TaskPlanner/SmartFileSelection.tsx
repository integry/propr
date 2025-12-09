import React from 'react';
import { PreviewResult } from '../../api/gitfixApi';

interface SmartFileSelectionProps {
  smartSelection: PreviewResult['smartSelection'];
}

export const SmartFileSelection: React.FC<SmartFileSelectionProps> = ({ smartSelection }) => {
  if (smartSelection.length === 0) return null;

  return (
    <div className="mb-6">
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Smart File Selection ({smartSelection.length} files)
      </label>
      <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-md">
        <ul className="divide-y divide-gray-100">
          {smartSelection.slice(0, 20).map((file, idx) => (
            <li key={idx} className="px-3 py-2 text-sm flex items-center justify-between hover:bg-gray-50">
              <div className="flex items-center gap-2">
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  file.source === 'manual' 
                    ? 'bg-blue-100 text-blue-700' 
                    : 'bg-green-100 text-green-700'
                }`}>
                  {file.source}
                </span>
                <span className="font-mono text-gray-900">{file.path}</span>
              </div>
              <span className="text-xs text-gray-500 truncate max-w-xs" title={file.reason}>
                {file.reason}
              </span>
            </li>
          ))}
          {smartSelection.length > 20 && (
            <li className="px-3 py-2 text-sm text-gray-500 text-center">
              ... and {smartSelection.length - 20} more files
            </li>
          )}
        </ul>
      </div>
    </div>
  );
};
