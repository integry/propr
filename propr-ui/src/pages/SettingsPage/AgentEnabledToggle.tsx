import React from 'react';

interface AgentEnabledToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const AgentEnabledToggle: React.FC<AgentEnabledToggleProps> = ({ checked, onChange }) => (
  <div className="flex items-center gap-2">
    <label className="relative inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="sr-only peer"
      />
      <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
    </label>
    <span className="text-gray-700 font-medium text-sm">Enabled</span>
  </div>
);

export default AgentEnabledToggle;
