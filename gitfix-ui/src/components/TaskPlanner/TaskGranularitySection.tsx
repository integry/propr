import React from 'react';
import { ListTodo } from 'lucide-react';
import { Granularity } from '../../api/proprApi';
import { GranularitySelector } from './GranularitySelector';

interface TaskGranularitySectionProps {
  granularity: Granularity;
  onGranularityChange: (granularity: Granularity) => void;
}

export const TaskGranularitySection: React.FC<TaskGranularitySectionProps> = ({
  granularity,
  onGranularityChange
}) => {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-gray-700">
        <ListTodo className="w-5 h-5" />
        <h3 className="font-semibold">Break Plan Into Issues</h3>
      </div>

      <div className="bg-gray-50 rounded-xl p-5 border border-gray-100">
        <GranularitySelector
          value={granularity}
          onChange={onGranularityChange}
        />
      </div>
    </div>
  );
};
