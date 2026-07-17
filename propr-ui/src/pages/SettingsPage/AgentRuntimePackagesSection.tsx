import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle, PackagePlus, RefreshCw, X } from 'lucide-react';
import {
  getAgentRuntimePackageState,
  searchAgentRuntimePackageCatalog,
  updateAgentRuntimePackageState,
  validateAgentRuntimePackageSelection,
  type AgentRuntimePackageState
} from '../../api/agentRuntimeApi';

const EMPTY_STATE: AgentRuntimePackageState = {
  packages: [],
  activePackages: [],
  status: 'disabled',
  images: {},
  updatedAt: ''
};

const PACKAGE_SPEC = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?(?:=[A-Za-z0-9.+:~_-]+)?$/;
const PACKAGE_QUERY = /^[a-z0-9+.-]+$/;

function normalizePackageSpec(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.indexOf('=');
  if (separator === -1) return trimmed.toLowerCase();
  return `${trimmed.slice(0, separator).toLowerCase()}=${trimmed.slice(separator + 1)}`;
}

function conciseBuildError(value?: string): string | null {
  if (!value) return null;
  const clean = value.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = clean.split('\n').map(line => line.trim()).filter(Boolean);
  const preferred = [
    /unable to locate package/i,
    /no such package/i,
    /not found/i,
    /unsupported package manager/i,
    /returned a non-zero code/i
  ];
  for (const pattern of preferred) {
    const line = [...lines].reverse().find(candidate => pattern.test(candidate));
    if (line) return line.slice(0, 240);
  }
  return (lines.at(-1) || value).slice(0, 240);
}

interface PackageAutocompleteProps {
  input: string;
  suggestions: string[];
  catalogSources: string[];
  searching: boolean;
  validating: boolean;
  showSuggestions: boolean;
  activeSuggestion: number;
  disabled: boolean;
  onInputChange: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onActiveSuggestionChange: (index: number) => void;
  onAdd: (candidate?: string) => void;
}

const PackageAutocomplete: React.FC<PackageAutocompleteProps> = ({
  input,
  suggestions,
  catalogSources,
  searching,
  validating,
  showSuggestions,
  activeSuggestion,
  disabled,
  onInputChange,
  onFocus,
  onBlur,
  onKeyDown,
  onActiveSuggestionChange,
  onAdd
}) => (
  <>
    <div className="flex items-start gap-2">
      <div className="relative min-w-0 flex-1">
        <input
          value={input}
          onChange={event => onInputChange(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder="Package name"
          aria-label="Package name"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showSuggestions && input.trim().length >= 2}
          aria-controls="agent-runtime-package-suggestions"
          aria-activedescendant={activeSuggestion >= 0 ? `agent-runtime-package-${activeSuggestion}` : undefined}
          disabled={disabled || validating}
          className="h-8 w-full rounded border border-gray-300 px-2.5 text-sm focus:border-primary-500 focus:ring-primary-500 disabled:bg-gray-100"
        />
        {showSuggestions && input.trim().length >= 2 && (
          <div
            id="agent-runtime-package-suggestions"
            role="listbox"
            className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded border border-gray-200 bg-white py-1 shadow-lg"
          >
            {searching ? (
              <div className="flex h-9 items-center gap-2 px-2.5 text-xs text-gray-500">
                <LoaderCircle size={13} className="animate-spin" />
                Loading package catalog...
              </div>
            ) : suggestions.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-gray-500">No package available across all agent runtimes</div>
            ) : suggestions.map((suggestion, index) => (
              <button
                id={`agent-runtime-package-${index}`}
                key={suggestion}
                type="button"
                role="option"
                aria-selected={index === activeSuggestion}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => onActiveSuggestionChange(index)}
                onClick={() => onAdd(suggestion)}
                className={`block h-8 w-full px-2.5 text-left font-mono text-xs ${index === activeSuggestion ? 'bg-gray-100 text-gray-900' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onAdd()}
        disabled={!input.trim() || disabled || validating}
        title="Add package"
        aria-label="Add package"
        className="inline-flex h-8 w-8 flex-none items-center justify-center rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {validating ? <LoaderCircle size={16} className="animate-spin" /> : <PackagePlus size={16} />}
      </button>
    </div>
    {catalogSources.length > 0 && (
      <p className="mt-1.5 truncate text-[10px] text-gray-400" title={catalogSources.join(', ')}>
        {catalogSources.join(', ')}
      </p>
    )}
  </>
);

function runtimeStatusColor(status: AgentRuntimePackageState['status']): string {
  if (status === 'ready') return 'bg-green-500';
  if (status === 'failed') return 'bg-red-500';
  if (status === 'pending' || status === 'building') return 'bg-amber-500';
  return 'bg-gray-300';
}

const AgentRuntimePackagesSection: React.FC = () => {
  const [state, setState] = useState<AgentRuntimePackageState>(EMPTY_STATE);
  const [packages, setPackages] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [catalogSources, setCatalogSources] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [validating, setValidating] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);

  const load = useCallback(async () => {
    try {
      const next = await getAgentRuntimePackageState();
      setState(next);
      setPackages(current => loading ? next.packages : current);
      setError(null);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state.status !== 'pending' && state.status !== 'building') return;
    const timer = window.setInterval(async () => {
      try {
        const next = await getAgentRuntimePackageState();
        setState(next);
        if (next.status === 'ready' || next.status === 'disabled') setPackages(next.packages);
      } catch (requestError) {
        setError((requestError as Error).message);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [state.status, state.buildId]);

  useEffect(() => {
    const query = input.trim().toLowerCase().split(/[=:]/, 1)[0];
    if (query.length < 2 || !PACKAGE_QUERY.test(query)) {
      setSuggestions([]);
      setSearching(false);
      setActiveSuggestion(-1);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await searchAgentRuntimePackageCatalog(query, controller.signal);
        setSuggestions(result.suggestions);
        setCatalogSources([...new Set(result.sources.map(source => `${source.osName} (${source.packageManager})`))]);
        setActiveSuggestion(result.suggestions.length > 0 ? 0 : -1);
        setShowSuggestions(true);
      } catch (requestError) {
        if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [input]);

  const normalizedDesired = useMemo(() => [...packages].sort(), [packages]);
  const dirty = JSON.stringify(normalizedDesired) !== JSON.stringify([...state.packages].sort());
  const building = state.status === 'pending' || state.status === 'building';

  const addPackage = async (candidate = input) => {
    const value = normalizePackageSpec(candidate);
    if (!value) return;
    if (!PACKAGE_SPEC.test(value)) {
      setError(`Invalid package spec: ${value}`);
      return;
    }
    setValidating(true);
    setError(null);
    try {
      const result = await validateAgentRuntimePackageSelection([...packages, value]);
      if (!result.valid) {
        setError(result.errors?.join('; ') || result.error || `${value} is unavailable for one or more agent runtimes`);
        return;
      }
      setPackages(result.packages);
      if (result.sources) {
        setCatalogSources([...new Set(result.sources.map(source => `${source.osName} (${source.packageManager})`))]);
      }
      setInput('');
      setSuggestions([]);
      setShowSuggestions(false);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setValidating(false);
    }
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      setShowSuggestions(true);
      setActiveSuggestion(current => (current + 1) % suggestions.length);
      return;
    }
    if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      setShowSuggestions(true);
      setActiveSuggestion(current => current <= 0 ? suggestions.length - 1 : current - 1);
      return;
    }
    if (event.key === 'Escape') {
      setShowSuggestions(false);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = showSuggestions && activeSuggestion >= 0 ? suggestions[activeSuggestion] : input;
      void addPackage(selected);
    }
  };

  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await updateAgentRuntimePackageState(normalizedDesired);
      setState(next);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const statusColor = runtimeStatusColor(state.status);

  return (
    <div className="border-t border-gray-200 pt-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Agent Runtime Packages</h4>
        <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <span className={`h-1.5 w-1.5 rounded-full ${statusColor}`} />
          {state.status}
        </span>
      </div>

      <PackageAutocomplete
        input={input}
        suggestions={suggestions}
        catalogSources={catalogSources}
        searching={searching}
        validating={validating}
        showSuggestions={showSuggestions}
        activeSuggestion={activeSuggestion}
        disabled={loading || building}
        onInputChange={setInput}
        onFocus={() => setShowSuggestions(true)}
        onBlur={() => setShowSuggestions(false)}
        onKeyDown={handleInputKeyDown}
        onActiveSuggestionChange={setActiveSuggestion}
        onAdd={candidate => void addPackage(candidate)}
      />

      <div className="mt-3 divide-y divide-gray-100 border-y border-gray-100">
        {packages.length === 0 ? (
          <div className="py-3 text-xs text-gray-400">No additional system packages</div>
        ) : packages.map(packageName => (
          <div key={packageName} className="flex h-9 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <Check size={12} className="flex-none text-green-600" aria-hidden="true" />
              <code className="min-w-0 truncate text-xs text-gray-700">{packageName}</code>
            </span>
            <button
              type="button"
              onClick={() => setPackages(current => current.filter(value => value !== packageName))}
              disabled={building}
              title={`Remove ${packageName}`}
              aria-label={`Remove ${packageName}`}
              className="inline-flex h-7 w-7 items-center justify-center text-gray-400 hover:text-red-600 disabled:opacity-50"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[11px] text-gray-500">
          {state.activePackages.length} active across {Object.keys(state.images).length} agent image{Object.keys(state.images).length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={(!dirty && state.status !== 'failed') || saving || building || validating}
          className="inline-flex items-center gap-1.5 rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw size={13} className={building ? 'animate-spin' : ''} />
          Apply
        </button>
      </div>

      {(error || state.error) && (
        <p className="mt-2 break-words text-xs text-red-600">{error || conciseBuildError(state.error)}</p>
      )}
      {state.status === 'failed' && (state.buildLog || (state.error && state.error.length > 240)) && (
        <details className="mt-2 text-xs text-gray-500">
          <summary className="cursor-pointer select-none">Build details</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border-l-2 border-gray-200 pl-2 text-[10px] leading-4 text-gray-500">
            {state.buildLog || state.error}
          </pre>
        </details>
      )}
    </div>
  );
};

export default AgentRuntimePackagesSection;
