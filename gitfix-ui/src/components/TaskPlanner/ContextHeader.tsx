import React from 'react';
import { GitBranch } from 'lucide-react';
import { BranchSelector } from './BranchSelector';

interface ContextHeaderProps {
  repository: string;
  baseBranch: string;
  branches: string[];
  isLoading: boolean;
  error: string | null;
  onBranchChange: (branch: string) => void;
}

export const ContextHeader: React.FC<ContextHeaderProps> = ({
  repository,
  baseBranch,
  branches,
  isLoading,
  error,
  onBranchChange
}) => {
  return (
    <div className="bg-slate-800 text-white rounded-t-xl px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <GitBranch className="w-5 h-5 text-slate-400" />
          <div>
            <span className="text-slate-400 text-sm">Repository</span>
            <p className="font-mono text-white">{repository}</p>
          </div>
        </div>
        <BranchSelector
          value={baseBranch}
          branches={branches}
          isLoading={isLoading}
          error={error}
          onChange={onBranchChange}
        />
      </div>
    </div>
  );
};
