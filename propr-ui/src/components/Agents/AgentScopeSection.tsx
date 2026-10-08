import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { MAX_AGENT_REPOSITORIES } from '@propr/shared';
import { RepositorySelector, type RepoOption } from '../RepositorySelector';
import { fetchEnabledRepos } from '../../utils/repoHelpers';
import { AGENT_CHIP_CLASSES, AgentFormRow } from './AgentFormRow';

interface AgentScopeSectionProps {
  repositories: string[];
  onChange: (repositories: string[]) => void;
  disabled: boolean;
}

/** Repository scope: up to ten enabled catalog repositories, shown as removable chips. */
export const AgentScopeSection: React.FC<AgentScopeSectionProps> = ({ repositories, onChange, disabled }) => {
  const [options, setOptions] = useState<RepoOption[] | undefined>(undefined);

  useEffect(() => {
    let active = true;
    fetchEnabledRepos()
      .then(loaded => { if (active) setOptions(loaded); })
      .catch(() => { if (active) setOptions([]); });
    return () => { active = false; };
  }, []);

  const selected = useMemo(() => new Set(repositories.map(repository => repository.toLowerCase())), [repositories]);
  const available = useMemo(
    () => options?.filter(option => !selected.has(option.name.toLowerCase())),
    [options, selected],
  );
  const full = repositories.length >= MAX_AGENT_REPOSITORIES;

  return (
    <AgentFormRow
      label="Repositories"
      hint={`The repositories this automation may read. Up to ${MAX_AGENT_REPOSITORIES}; leave empty for an automation that needs no code.`}
    >
      {repositories.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Selected repositories">
          {repositories.map(repository => (
            <li key={repository} className={AGENT_CHIP_CLASSES}>
              {repository}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(repositories.filter(candidate => candidate !== repository))}
                  aria-label={`Remove ${repository}`}
                  className="rounded-sm text-slate-400 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {options !== undefined && options.length > 0 && available?.length === 0 ? (
        <p className="text-xs text-slate-500">Every enabled repository is selected.</p>
      ) : (
        <RepositorySelector
          repos={available ?? []}
          selectedRepo=""
          onRepoChange={repository => { if (repository && !full) onChange([...repositories, repository]); }}
          disabled={disabled || full}
          isLoading={options === undefined}
          placeholder={full ? `Limit of ${MAX_AGENT_REPOSITORIES} reached` : 'Add repository…'}
          size="compact"
        />
      )}
    </AgentFormRow>
  );
};
