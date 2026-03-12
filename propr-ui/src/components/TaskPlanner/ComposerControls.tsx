import React from 'react';
import { X, FileText, Square, Layers, LayoutGrid } from 'lucide-react';
import { Granularity } from '../../api/proprApi';

// Helper to estimate issue count based on granularity
// Single: always exactly 1 issue
// Balanced: 3-5 issues
// Granular: 7-15+ issues
const estimateIssueCount = (granularity: Granularity): string => {
  switch (granularity) {
    case 'single':
      return '1';
    case 'balanced':
      return '3-5';
    case 'granular':
      return '7-15+';
    default:
      return '1';
  }
};

// Compact Granularity Segmented Control for Composer Bar
export const GranularityPills: React.FC<{
  value: Granularity;
  onChange: (g: Granularity) => void;
  fileCount?: number;
  hideEstimate?: boolean;
}> = ({ value, onChange, hideEstimate = false }) => {
  const options: { id: Granularity; label: string; icon: typeof Square }[] = [
    { id: 'single', label: 'Single', icon: Square },
    { id: 'balanced', label: 'Balanced', icon: Layers },
    { id: 'granular', label: 'Granular', icon: LayoutGrid },
  ];

  const estimatedIssues = estimateIssueCount(value);

  return (
    <div className="inline-flex flex-wrap items-center gap-2">
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
                  ? 'bg-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              style={isSelected ? { color: 'rgb(29, 138, 138)' } : undefined}
            >
              <Icon className="w-3.5 h-3.5" />
              {opt.label}
            </button>
          );
        })}
      </div>
      {!hideEstimate && (
        <span className="text-xs text-gray-400">
          {estimatedIssues} {estimatedIssues === '1' ? 'issue' : 'issues'}
        </span>
      )}
    </div>
  );
};

// Helper to format file size
const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

// Attachment Chip component for local File objects
export const AttachmentChip: React.FC<{
  file: File;
  onRemove: () => void;
}> = ({ file, onRemove }) => {
  const isImage = file.type.startsWith('image/');
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (isImage && file instanceof Blob) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [file, isImage]);

  return (
    <div className="inline-flex items-center gap-2 bg-gray-100 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm">
      {isImage && previewUrl ? (
        <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0 bg-gray-200 border border-gray-300">
          <img
            src={previewUrl}
            alt={file.name}
            className="w-full h-full object-cover"
          />
        </div>
      ) : (
        <FileText className="w-4 h-4 text-gray-500 flex-shrink-0" />
      )}
      <span className="text-gray-700 max-w-[150px] truncate">{file.name}</span>
      <span className="text-gray-400 text-xs">{formatFileSize(file.size)}</span>
      <button
        onClick={onRemove}
        className="p-0.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

// Attachment Chip component for remote/server-stored attachments
export const RemoteAttachmentChip: React.FC<{
  name: string;
  mimeType?: string;
  tokenEstimate?: number;
  previewUrl?: string;
  onRemove: () => void;
}> = ({ name, mimeType, tokenEstimate, previewUrl, onRemove }) => {
  const isImage = mimeType?.startsWith('image/');

  return (
    <div className="inline-flex items-center gap-2 bg-gray-100 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm">
      {isImage && previewUrl ? (
        <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0 bg-gray-200 border border-gray-300">
          <img
            src={previewUrl}
            alt={name}
            className="w-full h-full object-cover"
            crossOrigin="use-credentials"
          />
        </div>
      ) : isImage ? (
        <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0 flex items-center justify-center border" style={{ backgroundColor: 'rgba(29, 138, 138, 0.1)', borderColor: 'rgba(29, 138, 138, 0.2)' }}>
          <FileText className="w-4 h-4" style={{ color: 'rgb(29, 138, 138)' }} />
        </div>
      ) : (
        <FileText className="w-4 h-4 text-gray-500 flex-shrink-0" />
      )}
      <span className="text-gray-700 max-w-[150px] truncate">{name}</span>
      {tokenEstimate !== undefined && (
        <span className="text-gray-400 text-xs">{tokenEstimate}t</span>
      )}
      <button
        onClick={onRemove}
        className="p-0.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
