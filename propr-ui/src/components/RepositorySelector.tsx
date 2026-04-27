import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Search, Star, ChevronDown, X, Github, Loader2 } from 'lucide-react';
import { fetchEnabledRepos } from '../utils/repoHelpers';

export interface RepoOption {
  name: string;
  enabled: boolean;
  baseBranch?: string;
  starred?: boolean;
  iconPath?: string | null;
  /** Custom label shown instead of the owner/repo name. */
  displayName?: string;
  /** Count badge rendered next to the label. */
  count?: number;
  /** Extra text to match when filtering (searched alongside name and displayName). */
  searchText?: string;
}

interface RepositorySelectorProps {
  repos?: RepoOption[];
  selectedRepo: string;
  onRepoChange: (repo: string) => void;
  onReposLoaded?: (repos: RepoOption[]) => void;
  disabled?: boolean;
  isLoading?: boolean;
  placeholder?: string;
  variant?: 'default' | 'breadcrumb';
  className?: string;
}

const getIconUrl = (repoName: string, iconPath: string): string => {
  const [owner, repo] = repoName.split('/');
  if (!owner || !repo) return '';
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${iconPath}`;
};

const RepoIcon: React.FC<{
  repoName: string;
  iconPath?: string | null;
  size?: 'sm' | 'md';
}> = ({ repoName, iconPath, size = 'sm' }) => {
  const [hasError, setHasError] = useState(false);
  const sizeClass = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
  if (iconPath && !hasError) return <img src={getIconUrl(repoName, iconPath)} alt="" className={`${sizeClass} rounded flex-shrink-0 object-contain`} onError={() => setHasError(true)} />;
  return <Github className={`${sizeClass} text-gray-400 flex-shrink-0`} />;
};

const FormatRepoName: React.FC<{ name: string }> = ({ name }) => {
  const parts = name.split('/');
  if (parts.length === 2) return <><span className="text-gray-400">{parts[0]}/</span><span className="font-medium">{parts[1]}</span></>;
  return <span>{name}</span>;
};

const RepoLabel: React.FC<{ repo: RepoOption }> = ({ repo }) =>
  repo.displayName ? <>{repo.displayName}</> : <><FormatRepoName name={repo.name} />{repo.baseBranch && <span className="text-gray-500"> ({repo.baseBranch})</span>}</>;

const RepoCountBadge: React.FC<{ count: number }> = ({ count }) => <span className="inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600 flex-shrink-0">{count}</span>;

const RepoItem: React.FC<{
  repo: RepoOption;
  isSelected: boolean;
  onSelect: (repo: RepoOption) => void;
}> = ({ repo, isSelected, onSelect }) => (
  <button
    type="button"
    className={`w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-gray-50 transition-colors ${
      isSelected ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'
    }`}
    onClick={() => onSelect(repo)}
  >
    <RepoIcon repoName={repo.name} iconPath={repo.iconPath} />
    <span className="flex-1 truncate text-sm font-mono">
      <RepoLabel repo={repo} />
    </span>
    {repo.count !== undefined && <RepoCountBadge count={repo.count} />}
    {repo.starred && (
      <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500 flex-shrink-0" />
    )}
  </button>
);

const FilterInput: React.FC<{
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}> = ({ inputRef, value, onChange, onKeyDown }) => (
  <div className="p-2 border-b border-gray-100">
    <div className="relative">
      <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
      <input ref={inputRef} type="text" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} placeholder="Filter repositories..." className="w-full pl-8 pr-8 py-1.5 text-sm border border-gray-200 rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500" />
      {value && (
        <button type="button" onClick={() => onChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
      )}
    </div>
  </div>
);

const repoKey = (repo: RepoOption): string =>
  repo.baseBranch ? `${repo.name}:${repo.baseBranch}` : repo.name;

const RepoSectionHeader: React.FC<{ title: string }> = ({ title }) => (
  <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500 bg-slate-50">{title}</div>
);

const RepoList: React.FC<{
  starredRepos: RepoOption[];
  otherRepos: RepoOption[];
  selectedRepoKey: string | null;
  onSelect: (repo: RepoOption) => void;
}> = ({ starredRepos, otherRepos, selectedRepoKey, onSelect }) => {
  if (starredRepos.length === 0 && otherRepos.length === 0) return <div className="px-3 py-4 text-sm text-gray-500 text-center">No repositories found</div>;
  return (
    <>
      {starredRepos.length > 0 && (
        <>
          <RepoSectionHeader title="Starred" />
          {starredRepos.map(repo => <RepoItem key={repoKey(repo)} repo={repo} isSelected={selectedRepoKey === repoKey(repo)} onSelect={onSelect} />)}
        </>
      )}
      {otherRepos.length > 0 && (
        <>
          {starredRepos.length > 0 && <RepoSectionHeader title="All Repositories" />}
          {otherRepos.map(repo => <RepoItem key={repoKey(repo)} repo={repo} isSelected={selectedRepoKey === repoKey(repo)} onSelect={onSelect} />)}
        </>
      )}
    </>
  );
};

const getBreadcrumbLabel = (
  selectedRepoData: RepoOption | undefined,
  selectedRepo: string,
  placeholder: string,
  reposCount: number
) => {
  if (selectedRepoData?.displayName) return selectedRepoData.displayName;
  if (selectedRepoData?.baseBranch) return `${selectedRepo.split('/')[1] || selectedRepo} (${selectedRepoData.baseBranch})`;
  if (selectedRepo) return selectedRepo.split('/')[1] || selectedRepo;
  return reposCount === 0 ? 'No repositories' : placeholder;
};

const BreadcrumbTrigger: React.FC<{
  selectedRepoData: RepoOption | undefined;
  selectedRepo: string;
  placeholder: string;
  reposCount: number;
  disabled: boolean;
  isOpen: boolean;
  onClick: () => void;
}> = ({ selectedRepoData, selectedRepo, placeholder, reposCount, disabled, isOpen, onClick }) => (
  <>
    <button type="button" onClick={onClick} disabled={disabled || reposCount === 0} className="appearance-none bg-transparent border-none text-sm pr-5 py-0.5 font-mono text-gray-700 hover:text-indigo-600 focus:outline-none cursor-pointer transition-colors truncate max-w-full flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50" title={selectedRepo || placeholder}>
      {selectedRepoData ? <RepoIcon repoName={selectedRepoData.name} iconPath={selectedRepoData.iconPath} /> : <Github className="w-4 h-4 text-gray-500 flex-shrink-0" />}
      <span className="truncate">{getBreadcrumbLabel(selectedRepoData, selectedRepo, placeholder, reposCount)}</span>
    </button>
    <ChevronDown className={`w-3.5 h-3.5 text-gray-400 absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none transition-transform ${isOpen ? 'rotate-180' : ''}`} />
  </>
);

const getDefaultTriggerLabel = (selectedRepoData: RepoOption) => {
  if (selectedRepoData.displayName) return selectedRepoData.displayName;
  if (selectedRepoData.baseBranch) return `${selectedRepoData.name} (${selectedRepoData.baseBranch})`;
  return selectedRepoData.name;
};

const DefaultTrigger: React.FC<{
  selectedRepoData: RepoOption | undefined;
  placeholder: string;
  reposCount: number;
  disabled: boolean;
  isOpen: boolean;
  onClick: () => void;
}> = ({ selectedRepoData, placeholder, reposCount, disabled, isOpen, onClick }) => (
  <button type="button" onClick={onClick} disabled={disabled || reposCount === 0} className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 flex items-center gap-2 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500">
    {selectedRepoData ? (
      <>
        <RepoIcon repoName={selectedRepoData.name} iconPath={selectedRepoData.iconPath} />
        <span className="flex-1 text-left truncate text-sm">{getDefaultTriggerLabel(selectedRepoData)}</span>
        {selectedRepoData.count !== undefined && <RepoCountBadge count={selectedRepoData.count} />}
        {selectedRepoData.starred && <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500 flex-shrink-0" />}
      </>
    ) : (
      <>
        <Github className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <span className="flex-1 text-left text-gray-500 text-sm">{reposCount === 0 ? 'No repositories configured' : placeholder}</span>
      </>
    )}
    <ChevronDown className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
  </button>
);

export const RepositorySelector: React.FC<RepositorySelectorProps> = ({
  repos: externalRepos,
  selectedRepo,
  onRepoChange,
  onReposLoaded,
  disabled = false,
  isLoading = false,
  placeholder = 'Select repository',
  variant = 'default',
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedRepoKeyOverride, setSelectedRepoKeyOverride] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [internalRepos, setInternalRepos] = useState<RepoOption[]>([]);
  const [internalLoading, setInternalLoading] = useState(false);
  const onReposLoadedRef = useRef(onReposLoaded);
  onReposLoadedRef.current = onReposLoaded;

  useEffect(() => {
    if (externalRepos !== undefined) return;
    setInternalLoading(true);
    fetchEnabledRepos().then(loaded => {
      setInternalRepos(loaded);
      onReposLoadedRef.current?.(loaded);
    }).catch(() => {}).finally(() => setInternalLoading(false));
  }, [externalRepos !== undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const repos = externalRepos ?? internalRepos;
  const effectiveLoading = isLoading || (externalRepos === undefined && internalLoading);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setFilter('');
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  useEffect(() => { if (isOpen && inputRef.current) inputRef.current.focus(); }, [isOpen]);

  const { starredRepos, otherRepos } = useMemo(() => {
    const lowerFilter = filter.toLowerCase();
    const filtered = repos.filter(repo =>
      repo.name.toLowerCase().includes(lowerFilter) ||
      (repo.displayName && repo.displayName.toLowerCase().includes(lowerFilter)) ||
      (repo.searchText && repo.searchText.toLowerCase().includes(lowerFilter))
    );
    return {
      starredRepos: filtered.filter(r => r.starred),
      otherRepos: filtered.filter(r => !r.starred),
    };
  }, [repos, filter]);

  useEffect(() => {
    if (!selectedRepoKeyOverride) return;
    const selectedOverride = repos.find(repo => repoKey(repo) === selectedRepoKeyOverride);
    if (!selectedOverride || selectedOverride.name !== selectedRepo) setSelectedRepoKeyOverride(null);
  }, [repos, selectedRepo, selectedRepoKeyOverride]);

  const selectedRepoData = useMemo(() => {
    if (selectedRepoKeyOverride) {
      const selectedOverride = repos.find(repo => repoKey(repo) === selectedRepoKeyOverride && repo.name === selectedRepo);
      if (selectedOverride) return selectedOverride;
    }
    return repos.find(repo => repo.name === selectedRepo);
  }, [repos, selectedRepo, selectedRepoKeyOverride]);

  const selectedRepoKeyValue = selectedRepoData ? repoKey(selectedRepoData) : null;

  const handleSelect = useCallback((repo: RepoOption) => {
    setSelectedRepoKeyOverride(repoKey(repo));
    onRepoChange(repo.name);
    setIsOpen(false);
    setFilter('');
  }, [onRepoChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      setFilter('');
    } else if (e.key === 'Enter' && starredRepos.length + otherRepos.length === 1) {
      const singleRepo = starredRepos[0] || otherRepos[0];
      handleSelect(singleRepo);
    }
  }, [starredRepos, otherRepos, handleSelect]);

  const handleToggle = useCallback(() => {
    if (!disabled) setIsOpen(prev => {
      if (prev) setFilter('');
      return !prev;
    });
  }, [disabled]);

  if (effectiveLoading) return <div className={`flex items-center gap-2 text-gray-400 text-sm ${className}`}><Loader2 className="w-4 h-4 animate-spin" /><span>Loading repositories...</span></div>;

  const dropdownContent = isOpen && (
    <div className={`absolute top-full ${variant === 'breadcrumb' ? 'left-0 w-72' : 'left-0 right-0'} mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden`}>
      <FilterInput inputRef={inputRef} value={filter} onChange={setFilter} onKeyDown={handleKeyDown} />
      <div className="max-h-64 overflow-y-auto">
        <RepoList starredRepos={starredRepos} otherRepos={otherRepos} selectedRepoKey={selectedRepoKeyValue} onSelect={handleSelect} />
      </div>
    </div>
  );

  if (variant === 'breadcrumb') {
    return (
      <div ref={containerRef} className={`relative inline-flex items-center ${className}`}>
        <BreadcrumbTrigger selectedRepoData={selectedRepoData} selectedRepo={selectedRepo} placeholder={placeholder} reposCount={repos.length} disabled={disabled} isOpen={isOpen} onClick={handleToggle} />
        {dropdownContent}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <DefaultTrigger selectedRepoData={selectedRepoData} placeholder={placeholder} reposCount={repos.length} disabled={disabled} isOpen={isOpen} onClick={handleToggle} />
      {dropdownContent}
    </div>
  );
};

export default RepositorySelector;
