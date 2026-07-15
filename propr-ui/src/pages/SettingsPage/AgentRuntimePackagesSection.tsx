import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PackagePlus, RefreshCw, X } from 'lucide-react';
import {
  getAgentRuntimePackageState,
  updateAgentRuntimePackageState,
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

function normalizePackageSpec(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.indexOf('=');
  if (separator === -1) return trimmed.toLowerCase();
  return `${trimmed.slice(0, separator).toLowerCase()}=${trimmed.slice(separator + 1)}`;
}

const AgentRuntimePackagesSection: React.FC = () => {
  const [state, setState] = useState<AgentRuntimePackageState>(EMPTY_STATE);
  const [packages, setPackages] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const normalizedDesired = useMemo(() => [...packages].sort(), [packages]);
  const dirty = JSON.stringify(normalizedDesired) !== JSON.stringify([...state.packages].sort());
  const building = state.status === 'pending' || state.status === 'building';

  const addPackage = () => {
    const value = normalizePackageSpec(input);
    if (!value) return;
    if (!PACKAGE_SPEC.test(value)) {
      setError(`Invalid Debian package name: ${value}`);
      return;
    }
    setPackages(current => [...new Set([...current, value])].sort());
    setInput('');
    setError(null);
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

  const statusColor = state.status === 'ready'
    ? 'bg-green-500'
    : state.status === 'failed'
      ? 'bg-red-500'
      : building
        ? 'bg-amber-500'
        : 'bg-gray-300';

  return (
    <div className="border-t border-gray-200 pt-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Agent Runtime Packages</h4>
        <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <span className={`h-1.5 w-1.5 rounded-full ${statusColor}`} />
          {state.status}
        </span>
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addPackage(); } }}
          placeholder="Debian package name"
          aria-label="Debian package name"
          disabled={loading || building}
          className="min-w-0 flex-1 rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-primary-500 focus:ring-primary-500 disabled:bg-gray-100"
        />
        <button
          type="button"
          onClick={addPackage}
          disabled={!input.trim() || loading || building}
          title="Add package"
          aria-label="Add package"
          className="inline-flex h-8 w-8 flex-none items-center justify-center rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PackagePlus size={16} />
        </button>
      </div>

      <div className="mt-3 divide-y divide-gray-100 border-y border-gray-100">
        {packages.length === 0 ? (
          <div className="py-3 text-xs text-gray-400">No additional system packages</div>
        ) : packages.map(packageName => (
          <div key={packageName} className="flex h-9 items-center justify-between gap-2">
            <code className="min-w-0 truncate text-xs text-gray-700">{packageName}</code>
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
          disabled={(!dirty && state.status !== 'failed') || saving || building}
          className="inline-flex items-center gap-1.5 rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw size={13} className={building ? 'animate-spin' : ''} />
          Apply
        </button>
      </div>

      {(error || state.error) && <p className="mt-2 text-xs text-red-600">{error || state.error}</p>}
    </div>
  );
};

export default AgentRuntimePackagesSection;
