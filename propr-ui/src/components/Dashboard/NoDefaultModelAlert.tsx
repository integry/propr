import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';

export interface NoDefaultModelAlertProps {
  hasAgents: boolean;
  hasDefaultModel: boolean;
}

/**
 * Error alert shown on the Dashboard when no AI agent is configured
 * or when agents exist but none has a default model set.
 * Urges the user to go to the AI Agents screen and resolve the configuration.
 */
export const NoDefaultModelAlert: React.FC<NoDefaultModelAlertProps> = ({ hasAgents, hasDefaultModel }) => {
  const navigate = useNavigate();

  if (hasAgents && hasDefaultModel) return null;

  const title = !hasAgents ? 'No AI Agent Configured' : 'No Default Model Configured';
  const subtitle = !hasAgents
    ? 'You must set up at least one AI agent with a default model before tasks can be processed.'
    : 'At least one enabled AI agent must have a default model selected before tasks can be processed.';

  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-red-100 rounded-lg">
          <AlertCircle className="w-5 h-5 text-red-600" />
        </div>
        <div>
          <p className="text-sm font-medium text-gray-900">
            {title}
          </p>
          <p className="text-xs text-gray-600">
            {subtitle}
          </p>
        </div>
      </div>
      <button
        onClick={() => navigate('/ai-agents')}
        className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md flex-shrink-0"
      >
        Configure Agent
      </button>
    </div>
  );
};

export default NoDefaultModelAlert;
