import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ChevronLeft, HelpCircle, Loader2, Target } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { getInstanceCatalog } from '../api/proprApi';
import { createGoal, type AutoMergePolicy, type CreateGoalParams, type UltrafixMode } from '../api/goalsApi';
import { useDemoMode } from '../contexts/DemoModeContext';
import { useToast } from '../components/ui/useToast';
import type { InstanceCatalogAgent, InstanceCatalogRepository } from '@propr/shared';
import { isDemoModeReadOnlyError } from '../api/apiClient';

const MAX_CONCURRENT_TASKS_MIN = 1;
const MAX_CONCURRENT_TASKS_MAX = 20;

const AUTO_MERGE_OPTIONS: { value: AutoMergePolicy; label: string; description: string }[] = [
  { value: 'disabled', label: 'Disabled', description: 'No auto-merge; human review required.' },
  { value: 'approved', label: 'On approval', description: 'Merge automatically when a required review is approved.' },
  { value: 'all', label: 'All PRs', description: 'Merge as soon as CI passes. Use with caution.' },
];

const ULTRAFIX_OPTIONS: { value: UltrafixMode; label: string; description: string }[] = [
  { value: 'disabled', label: 'Disabled', description: 'No UltraFix quality loop.' },
  { value: 'enabled', label: 'Enabled', description: 'Run the UltraFix quality loop on every PR.' },
  { value: 'goal', label: 'Until goal', description: 'Loop until the quality score reaches a target.' },
  { value: 'max_cycle', label: 'Max cycles', description: 'Loop up to a maximum number of cycles.' },
];

// ─── Field label + hint ──────────────────────────────────────────────────────

const FieldLabel: React.FC<{ htmlFor: string; label: string; hint?: string; required?: boolean }> = ({
  htmlFor,
  label,
  hint,
  required,
}) => (
  <div className="flex items-center gap-1.5 mb-1">
    <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">
      {label}
      {required && <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>}
    </label>
    {hint && (
      <span title={hint} className="text-gray-400 hover:text-gray-600 cursor-help" aria-label={hint}>
        <HelpCircle className="w-3.5 h-3.5" />
      </span>
    )}
  </div>
);

const FieldError: React.FC<{ message: string }> = ({ message }) => (
  <p role="alert" className="mt-1 text-xs text-red-600 flex items-center gap-1">
    <AlertCircle className="w-3 h-3 flex-shrink-0" />
    {message}
  </p>
);

// ─── Agent / model selector (simplified, goal-specific) ──────────────────────

interface AgentModelPickerProps {
  agents: InstanceCatalogAgent[];
  selectedAgent: string;
  selectedModel: string;
  onAgentChange: (alias: string) => void;
  onModelChange: (model: string) => void;
  disabled?: boolean;
  agentError?: string;
  modelError?: string;
}

const AgentModelPicker: React.FC<AgentModelPickerProps> = ({
  agents,
  selectedAgent,
  selectedModel,
  onAgentChange,
  onModelChange,
  disabled,
  agentError,
  modelError,
}) => {
  const availableModels =
    agents.find(a => a.alias === selectedAgent)?.supportedModels ?? [];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {/* Agent */}
      <div>
        <FieldLabel htmlFor="goal-agent" label="Agent" required />
        <select
          id="goal-agent"
          value={selectedAgent}
          onChange={e => onAgentChange(e.target.value)}
          disabled={disabled || agents.length === 0}
          aria-invalid={!!agentError}
          aria-describedby={agentError ? 'goal-agent-error' : undefined}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 disabled:bg-gray-50 disabled:text-gray-400"
        >
          {agents.length === 0 && (
            <option value="">No agents available</option>
          )}
          {agents.map(a => (
            <option key={a.alias} value={a.alias}>{a.alias}</option>
          ))}
        </select>
        {agentError && <FieldError message={agentError} />}
      </div>

      {/* Model */}
      <div>
        <FieldLabel
          htmlFor="goal-model"
          label="Model"
          hint="Model changes apply at safe boundaries (e.g., between PR batches). The effective model may differ from the requested one at any given moment."
          required
        />
        <select
          id="goal-model"
          value={selectedModel}
          onChange={e => onModelChange(e.target.value)}
          disabled={disabled || availableModels.length === 0}
          aria-invalid={!!modelError}
          aria-describedby={modelError ? 'goal-model-error' : undefined}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 disabled:bg-gray-50 disabled:text-gray-400"
        >
          {availableModels.length === 0 && (
            <option value="">Select an agent first</option>
          )}
          {availableModels.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        {modelError && <FieldError message={modelError} />}
        {selectedAgent && !disabled && (
          <p className="mt-1 text-xs text-gray-500">
            Changes apply at safe boundaries; the active model may temporarily differ.
          </p>
        )}
      </div>
    </div>
  );
};

// ─── Main page ───────────────────────────────────────────────────────────────

interface FormErrors {
  objective?: string;
  repository?: string;
  agent?: string;
  model?: string;
  maxConcurrentTasks?: string;
  ultrafixGoal?: string;
  ultrafixMaxCycles?: string;
  submit?: string;
}

const GoalCreatePage: React.FC = () => {
  useDocumentTitle('New Goal');
  const navigate = useNavigate();
  const { isDemoMode } = useDemoMode();
  const { addToast } = useToast();

  // ── Catalog data ────────────────────────────────────────────────────────
  const [agents, setAgents] = useState<InstanceCatalogAgent[]>([]);
  const [repositories, setRepositories] = useState<InstanceCatalogRepository[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    getInstanceCatalog()
      .then(data => {
        if (cancelled) return;
        setAgents(data.agents.filter(a => a.enabled));
        setRepositories(data.repositories.filter(r => r.enabled));
      })
      .catch(err => {
        if (cancelled) return;
        setCatalogError((err as Error).message || 'Failed to load catalog');
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // ── Form state ──────────────────────────────────────────────────────────
  const [objective, setObjective] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(3);
  const [autoMergePolicy, setAutoMergePolicy] = useState<AutoMergePolicy>('disabled');
  const [ultrafixMode, setUltrafixMode] = useState<UltrafixMode>('disabled');
  const [ultrafixGoal, setUltrafixGoal] = useState<string>('80');
  const [ultrafixMaxCycles, setUltrafixMaxCycles] = useState<string>('3');

  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  // Seed default agent + model when catalog loads
  useEffect(() => {
    if (agents.length > 0 && !selectedAgent) {
      const first = agents[0];
      setSelectedAgent(first.alias);
      setSelectedModel(first.defaultModel || first.supportedModels[0] || '');
    }
  }, [agents, selectedAgent]);

  // Seed default repo when catalog loads
  useEffect(() => {
    if (repositories.length > 0 && !selectedRepo) {
      setSelectedRepo(repositories[0].name);
    }
  }, [repositories, selectedRepo]);

  // Update model when agent changes
  const handleAgentChange = useCallback((alias: string) => {
    setSelectedAgent(alias);
    const agent = agents.find(a => a.alias === alias);
    if (agent) {
      setSelectedModel(agent.defaultModel || agent.supportedModels[0] || '');
    } else {
      setSelectedModel('');
    }
    setErrors(prev => ({ ...prev, agent: undefined, model: undefined }));
  }, [agents]);

  // ── Validation ──────────────────────────────────────────────────────────
  const validate = (): FormErrors => {
    const errs: FormErrors = {};
    if (!objective.trim()) errs.objective = 'Objective is required.';
    else if (objective.trim().length < 10) errs.objective = 'Objective must be at least 10 characters.';
    if (!selectedRepo) errs.repository = 'Repository is required.';
    if (!selectedAgent) errs.agent = 'Agent is required.';
    if (!selectedModel) errs.model = 'Model is required.';
    if (maxConcurrentTasks < MAX_CONCURRENT_TASKS_MIN || maxConcurrentTasks > MAX_CONCURRENT_TASKS_MAX) {
      errs.maxConcurrentTasks = `Must be between ${MAX_CONCURRENT_TASKS_MIN} and ${MAX_CONCURRENT_TASKS_MAX}.`;
    }
    if (ultrafixMode === 'goal') {
      const goalVal = parseInt(ultrafixGoal, 10);
      if (isNaN(goalVal) || goalVal < 1 || goalVal > 100) {
        errs.ultrafixGoal = 'Quality goal must be between 1 and 100.';
      }
    }
    if (ultrafixMode === 'max_cycle') {
      const cycleVal = parseInt(ultrafixMaxCycles, 10);
      if (isNaN(cycleVal) || cycleVal < 1 || cycleVal > 50) {
        errs.ultrafixMaxCycles = 'Max cycles must be between 1 and 50.';
      }
    }
    return errs;
  };

  // ── Submit ──────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isDemoMode) return;

    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    const params: CreateGoalParams = {
      objective: objective.trim(),
      repository: selectedRepo,
      agentAlias: selectedAgent,
      model: selectedModel,
      maxConcurrentTasks,
      autoMergePolicy,
      ultrafixMode,
      ...(ultrafixMode === 'goal' && { ultrafixGoal: parseInt(ultrafixGoal, 10) }),
      ...(ultrafixMode === 'max_cycle' && { ultrafixMaxCycles: parseInt(ultrafixMaxCycles, 10) }),
    };

    setSubmitting(true);
    setErrors({});
    try {
      const goal = await createGoal(params);
      addToast({ type: 'success', message: 'Goal created successfully.' });
      navigate(`/goals/${goal.id}`);
    } catch (err) {
      if (isDemoModeReadOnlyError(err)) {
        setErrors({ submit: 'Goal creation is disabled in demo mode.' });
      } else {
        setErrors({ submit: (err as Error).message || 'Failed to create goal. Please try again.' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => navigate('/goals');

  // ── Render: catalog loading ─────────────────────────────────────────────
  if (catalogLoading) {
    return (
      <div className="flex flex-col h-full">
        <GoalCreateHeader onBack={handleCancel} />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      </div>
    );
  }

  if (catalogError) {
    return (
      <div className="flex flex-col h-full">
        <GoalCreateHeader onBack={handleCancel} />
        <div className="flex-1 px-4 sm:px-6 py-6">
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {catalogError}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <GoalCreateHeader onBack={handleCancel} />

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
        <div className="max-w-2xl mx-auto">
          {/* Demo mode banner */}
          {isDemoMode && (
            <div className="mb-6 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                Goal creation is disabled in demo mode. You can explore the form but cannot submit.
              </span>
            </div>
          )}

          {/* Info banner */}
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-sm">
            <p className="font-medium mb-1">What is a Goal?</p>
            <p>
              A Goal runs a goal-capable AI agent against a repository to produce an{' '}
              <strong>epic PR</strong> — optionally with sub-epics and leaf PRs. The agent works
              iteratively: it picks issues to address, creates branches, and submits PRs until the
              objective is met or the goal is paused/cancelled.
            </p>
          </div>

          <form onSubmit={handleSubmit} noValidate aria-label="Create goal">
            <div className="space-y-6">
              {/* ── Objective ─────────────────────────────────────────── */}
              <div>
                <FieldLabel htmlFor="goal-objective" label="Objective" required />
                <textarea
                  id="goal-objective"
                  value={objective}
                  onChange={e => {
                    setObjective(e.target.value);
                    setErrors(prev => ({ ...prev, objective: undefined }));
                  }}
                  rows={4}
                  placeholder="Describe what the agent should accomplish, e.g. 'Refactor the authentication module to use JWT with refresh tokens and add comprehensive tests.'"
                  disabled={submitting}
                  aria-invalid={!!errors.objective}
                  aria-describedby={errors.objective ? 'goal-objective-error' : undefined}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 disabled:bg-gray-50 resize-y"
                />
                {errors.objective && (
                  <FieldError message={errors.objective} />
                )}
              </div>

              {/* ── Repository ────────────────────────────────────────── */}
              <div>
                <FieldLabel htmlFor="goal-repository" label="Repository" required />
                <select
                  id="goal-repository"
                  value={selectedRepo}
                  onChange={e => {
                    setSelectedRepo(e.target.value);
                    setErrors(prev => ({ ...prev, repository: undefined }));
                  }}
                  disabled={submitting || repositories.length === 0}
                  aria-invalid={!!errors.repository}
                  aria-describedby={errors.repository ? 'goal-repository-error' : undefined}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 disabled:bg-gray-50 disabled:text-gray-400"
                >
                  {repositories.length === 0 && (
                    <option value="">No repositories available</option>
                  )}
                  {repositories.map(r => (
                    <option key={r.name} value={r.name}>{r.name}</option>
                  ))}
                </select>
                {errors.repository && <FieldError message={errors.repository} />}
                {repositories.length === 0 && !catalogLoading && (
                  <p className="mt-1 text-xs text-amber-600">
                    No enabled repositories found. Add a repository in the{' '}
                    <a href="/repositories" className="underline hover:text-amber-800">Repositories</a>{' '}
                    page first.
                  </p>
                )}
              </div>

              {/* ── Agent + Model ──────────────────────────────────────── */}
              <AgentModelPicker
                agents={agents}
                selectedAgent={selectedAgent}
                selectedModel={selectedModel}
                onAgentChange={handleAgentChange}
                onModelChange={m => {
                  setSelectedModel(m);
                  setErrors(prev => ({ ...prev, model: undefined }));
                }}
                disabled={submitting}
                agentError={errors.agent}
                modelError={errors.model}
              />
              {agents.length === 0 && !catalogLoading && (
                <p className="text-xs text-amber-600">
                  No enabled agents found. Configure an agent in{' '}
                  <a href="/ai-agents" className="underline hover:text-amber-800">Coding Agents</a>{' '}
                  first.
                </p>
              )}

              {/* ── Concurrency ────────────────────────────────────────── */}
              <div>
                <FieldLabel
                  htmlFor="goal-concurrency"
                  label="Maximum concurrent tasks"
                  hint="How many tasks the agent may run in parallel. Does not affect the total number of tasks, only how many run at once."
                  required
                />
                <div className="flex items-center gap-3">
                  <input
                    id="goal-concurrency"
                    type="number"
                    min={MAX_CONCURRENT_TASKS_MIN}
                    max={MAX_CONCURRENT_TASKS_MAX}
                    step={1}
                    value={maxConcurrentTasks}
                    onChange={e => {
                      setMaxConcurrentTasks(parseInt(e.target.value, 10) || 1);
                      setErrors(prev => ({ ...prev, maxConcurrentTasks: undefined }));
                    }}
                    disabled={submitting}
                    aria-invalid={!!errors.maxConcurrentTasks}
                    className="w-24 px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 disabled:bg-gray-50"
                  />
                  <span className="text-xs text-gray-500">
                    {MAX_CONCURRENT_TASKS_MIN}–{MAX_CONCURRENT_TASKS_MAX} tasks
                  </span>
                </div>
                {errors.maxConcurrentTasks && <FieldError message={errors.maxConcurrentTasks} />}
              </div>

              {/* ── Auto-merge policy ─────────────────────────────────── */}
              <div>
                <FieldLabel
                  htmlFor="goal-auto-merge"
                  label="Auto-merge policy"
                  hint="Controls when sub-PRs created by the goal are merged automatically."
                />
                <div className="space-y-2">
                  {AUTO_MERGE_OPTIONS.map(opt => (
                    <label
                      key={opt.value}
                      className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50 transition-colors has-[:checked]:border-teal-500 has-[:checked]:bg-teal-50"
                    >
                      <input
                        type="radio"
                        name="auto-merge"
                        value={opt.value}
                        checked={autoMergePolicy === opt.value}
                        onChange={() => setAutoMergePolicy(opt.value)}
                        disabled={submitting}
                        className="mt-0.5 accent-teal-600"
                      />
                      <div>
                        <span className="text-sm font-medium text-gray-800">{opt.label}</span>
                        <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* ── UltraFix ─────────────────────────────────────────── */}
              <div>
                <FieldLabel
                  htmlFor="goal-ultrafix"
                  label="UltraFix"
                  hint="UltraFix runs a quality loop on each PR, re-evaluating and optionally re-applying improvements until a goal score or cycle limit is reached."
                />
                <div className="space-y-2">
                  {ULTRAFIX_OPTIONS.map(opt => (
                    <label
                      key={opt.value}
                      className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50 transition-colors has-[:checked]:border-teal-500 has-[:checked]:bg-teal-50"
                    >
                      <input
                        type="radio"
                        name="ultrafix"
                        value={opt.value}
                        checked={ultrafixMode === opt.value}
                        onChange={() => setUltrafixMode(opt.value)}
                        disabled={submitting}
                        className="mt-0.5 accent-teal-600"
                      />
                      <div className="flex-1">
                        <span className="text-sm font-medium text-gray-800">{opt.label}</span>
                        <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>

                        {/* Inline sub-fields for goal / max_cycle modes */}
                        {opt.value === 'goal' && ultrafixMode === 'goal' && (
                          <div className="mt-2">
                            <label htmlFor="ultrafix-goal-score" className="text-xs font-medium text-gray-700">
                              Quality score target (1–100)
                            </label>
                            <input
                              id="ultrafix-goal-score"
                              type="number"
                              min={1}
                              max={100}
                              value={ultrafixGoal}
                              onChange={e => {
                                setUltrafixGoal(e.target.value);
                                setErrors(prev => ({ ...prev, ultrafixGoal: undefined }));
                              }}
                              disabled={submitting}
                              className="mt-1 w-20 px-2 py-1 border border-gray-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                            />
                            {errors.ultrafixGoal && <FieldError message={errors.ultrafixGoal} />}
                          </div>
                        )}
                        {opt.value === 'max_cycle' && ultrafixMode === 'max_cycle' && (
                          <div className="mt-2">
                            <label htmlFor="ultrafix-max-cycles" className="text-xs font-medium text-gray-700">
                              Maximum cycles (1–50)
                            </label>
                            <input
                              id="ultrafix-max-cycles"
                              type="number"
                              min={1}
                              max={50}
                              value={ultrafixMaxCycles}
                              onChange={e => {
                                setUltrafixMaxCycles(e.target.value);
                                setErrors(prev => ({ ...prev, ultrafixMaxCycles: undefined }));
                              }}
                              disabled={submitting}
                              className="mt-1 w-20 px-2 py-1 border border-gray-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                            />
                            {errors.ultrafixMaxCycles && <FieldError message={errors.ultrafixMaxCycles} />}
                          </div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* ── Submit error ──────────────────────────────────────── */}
              {errors.submit && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{errors.submit}</span>
                </div>
              )}

              {/* ── Actions ───────────────────────────────────────────── */}
              <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
                <button
                  type="submit"
                  disabled={submitting || isDemoMode}
                  className="inline-flex items-center gap-2 px-5 py-2 bg-teal-600 text-white text-sm font-medium rounded-md hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Creating…
                    </>
                  ) : (
                    <>
                      <Target className="w-4 h-4" />
                      Create Goal
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={submitting}
                  className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

// ─── Header sub-component ────────────────────────────────────────────────────

const GoalCreateHeader: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onBack}
        className="text-gray-500 hover:text-gray-700 p-1 -ml-1 rounded"
        aria-label="Back to Goals"
      >
        <ChevronLeft className="w-5 h-5" />
      </button>
      <h1 className="text-lg sm:text-2xl font-bold text-gray-800">New Goal</h1>
    </div>
  </div>
);

export default GoalCreatePage;
