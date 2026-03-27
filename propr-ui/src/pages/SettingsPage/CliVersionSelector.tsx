import React from 'react';
import { CliVersionType } from '../../api/proprApi';
import { AgentType, AGENT_DEFAULTS } from '../../config/modelDefinitions';
import { AvailableVersionsResponse } from '../../api/agentVersionApi';

interface CliVersionSelectorProps {
  agentType: AgentType;
  cliVersionType: CliVersionType;
  cliVersion?: string;
  cliVersionResolved?: string;
  versionData: AvailableVersionsResponse | null;
  versionLoading: boolean;
  onVersionTypeChange: (type: CliVersionType) => void;
  onVersionChange: (version: string) => void;
}

const CliVersionSelector: React.FC<CliVersionSelectorProps> = ({
  agentType, cliVersionType, cliVersion, cliVersionResolved,
  versionData, versionLoading, onVersionTypeChange, onVersionChange
}) => (
  <div>
    <label className="block text-gray-700 mb-1.5 font-medium text-sm">CLI Version</label>
    <div className="inline-flex bg-gray-100 rounded-full p-1 mb-2">
      {(['default', 'tag', 'specific', 'custom'] as CliVersionType[]).map(type => (
        <button
          key={type}
          type="button"
          onClick={() => onVersionTypeChange(type)}
          className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition-all ${
            cliVersionType === type
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          {type === 'default' ? 'Default' : type === 'tag' ? 'NPM Tag' : type === 'specific' ? 'Version' : 'Custom'}
        </button>
      ))}
    </div>

    {cliVersionType === 'default' && (
      <div className="bg-gray-50 border border-gray-200 rounded-md p-2">
        <span className="text-sm text-gray-600">
          Using default version: <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono text-xs">{AGENT_DEFAULTS[agentType].defaultCliVersion}</code>
        </span>
      </div>
    )}

    {cliVersionType === 'tag' && (
      <div>
        <select
          value={cliVersion || ''}
          onChange={(e) => onVersionChange(e.target.value)}
          className="w-full px-3 py-1.5 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm"
          disabled={versionLoading}
        >
          <option value="">Select a tag...</option>
          {versionData?.availableTags.map(tag => (
            <option key={tag.tag} value={tag.tag}>
              {tag.tag} ({tag.version})
            </option>
          ))}
        </select>
        {versionLoading && <p className="text-xs text-gray-500 mt-1">Loading tags...</p>}
      </div>
    )}

    {cliVersionType === 'specific' && (
      <div>
        <select
          value={cliVersion || ''}
          onChange={(e) => onVersionChange(e.target.value)}
          className="w-full px-3 py-1.5 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm"
          disabled={versionLoading}
        >
          <option value="">Select a version...</option>
          {versionData?.recentVersions.map(v => (
            <option key={v.version} value={v.version}>
              {v.version} ({new Date(v.publishedAt).toLocaleDateString()})
            </option>
          ))}
        </select>
        {versionLoading && <p className="text-xs text-gray-500 mt-1">Loading versions...</p>}
      </div>
    )}

    {cliVersionType === 'custom' && (
      <div>
        <input
          type="text"
          value={cliVersion || ''}
          onChange={(e) => onVersionChange(e.target.value)}
          placeholder="e.g., 2.1.77"
          className="w-full px-3 py-1.5 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm"
        />
        <p className="mt-1 text-xs text-gray-500">
          Enter a specific semver version.{' '}
          <a
            href={`https://www.npmjs.com/package/${AGENT_DEFAULTS[agentType].npmPackage}?activeTab=versions`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-600 hover:text-primary-800 underline"
          >
            View all versions on npm
          </a>
        </p>
      </div>
    )}

    {cliVersionResolved && cliVersionType !== 'default' && (
      <p className="mt-1.5 text-xs text-green-600">
        Resolved: <code className="bg-green-50 px-1.5 py-0.5 rounded">{cliVersionResolved}</code>
      </p>
    )}
  </div>
);

export default CliVersionSelector;
