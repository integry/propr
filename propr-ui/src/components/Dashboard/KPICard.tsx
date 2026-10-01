import React from 'react';
import { Loader2 } from 'lucide-react';
import { SkeletonBlock } from '../ui/Skeleton';

export interface KPICardProps {
  title: string;
  value: string | number;
  color?: string;
  isLoading?: boolean;
}

export const KPICard: React.FC<KPICardProps> = ({
  title,
  value,
  color = 'text-slate-800',
  isLoading
}) => (
  <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
    <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">{title}</div>
    <div className={`text-2xl font-bold ${color} flex items-center gap-2`}>
      {isLoading ? (
        <SkeletonBlock pulse className="h-8 w-16" />
      ) : (
        value
      )}
      {title === 'Active Tasks' && !isLoading && Number(value) > 0 && (
        <Loader2 className="w-4 h-4 animate-spin text-green-500" />
      )}
    </div>
  </div>
);
