import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ChevronLeft, HelpCircle, Loader2, Target } from 'lucide-react';
import { getGoalCapableModels, type InstanceCatalogAgent, type InstanceCatalogRepository } from '@propr/shared';
import {
  AUTO_MERGE_OPTIONS,
  MAX_CONCURRENT_TASKS_MAX,
  MAX_CONCURRENT_TASKS_MIN,
  OBJECTIVE_MAX_LENGTH,
  OBJECTIVE_MIN_LENGTH,
  ULTRAFIX_CYCLES_MAX,
  ULTRAFIX_CYCLES_MIN,
  ULTRAFIX_GOAL_MAX,
  ULTRAFIX_GOAL_MIN,
  type GoalFormErrors,
  type GoalFormValues,
} from './goalCreateUtils';

interface FieldLabelProps {
  htmlFor: string;
  label: string;
  hint?: string;
  required?: boolean;
}

export const FieldLabel = ({ htmlFor, label, hint, required }: FieldLabelProps) => (
  <div className="mb-1 flex items-center gap-1.5">
    <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">
      {label}
    </label>
    {required && <span className="text-red-500" aria-hidden="true">*</span>}
    {hint && (
      <span title={hint} className="cursor-help text-gray-400" aria-label={hint}>
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    )}
  </div>
);

export const FieldError = ({ id, message }: { id: string; message: string }) => (
  <p id={id} role="alert" className="mt-1 flex items-center gap-1 text-xs text-red-600">
    <AlertCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
    {message}
  </p>
);

interface AgentModelPickerProps {
  agents: InstanceCatalogAgent[];
  values: GoalFormValues;
  errors: GoalFormErrors;
  disabled: boolean;
  onAgentChange: (alias: string) => void;
  onModelChange: (model: string) => void;
}

export const AgentModelPicker = ({
  agents,
  values,
  errors,
  disabled,
  onAgentChange,
  onModelChange,
}: AgentModelPickerProps) => {
  const selectedAgent = agents.find(agent => agent.alias === values.agent);
  const models = selectedAgent ? getGoalCapableModels(selectedAgent) : [];
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <FieldLabel htmlFor="goal-agent" label="Agent" required />
        <select
          id="goal-agent"
          value={values.agent}
          onChange={event => onAgentChange(event.target.value)}
          disabled={disabled || agents.length === 0}
          required
          aria-invalid={Boolean(errors.agent)}
          aria-describedby={errors.agent ? 'goal-agent-error' : undefined}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 disabled:bg-gray-50"
        >
          {agents.length === 0 && <option value="">No goal-capable agents available</option>}
          {agents.map(agent => <option key={agent.alias} value={agent.alias}>{agent.alias}</option>)}
        </select>
        {errors.agent && <FieldError id="goal-agent-error" message={errors.agent} />}
      </div>
      <div>
        <FieldLabel
          htmlFor="goal-model"
          label="Requested model"
          hint="The effective model can change only at safe execution boundaries."
          required
        />
        <select
          id="goal-model"
          value={values.model}
          onChange={event => onModelChange(event.target.value)}
          disabled={disabled || models.length === 0}
          required
          aria-invalid={Boolean(errors.model)}
          aria-describedby={errors.model ? 'goal-model-error' : 'goal-model-hint'}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 disabled:bg-gray-50"
        >
          {models.length === 0 && <option value="">Select a goal-capable agent</option>}
          {models.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
        {errors.model
          ? <FieldError id="goal-model-error" message={errors.model} />
          : <p id="goal-model-hint" className="mt-1 text-xs text-gray-500">Requested now; effective model is shown separately while a goal runs.</p>}
      </div>
    </div>
  );
};

interface GoalCreateFormProps {
  agents: InstanceCatalogAgent[];
  repositories: InstanceCatalogRepository[];
  values: GoalFormValues;
  errors: GoalFormErrors;
  submitting: boolean;
  isDemoMode: boolean;
  setField: <K extends keyof GoalFormValues>(field: K, value: GoalFormValues[K]) => void;
  setAgent: (alias: string) => void;
  submit: () => Promise<void>;
  cancel: () => void;
}

export const GoalCreateForm = ({
  agents,
  repositories,
  values,
  errors,
  submitting,
  isDemoMode,
  setField,
  setAgent,
  submit,
  cancel,
}: GoalCreateFormProps) => {
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };
  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Create goal">
      <div className="space-y-6">
        <div>
          <FieldLabel htmlFor="goal-objective" label="Objective" required />
          <textarea
            id="goal-objective"
            value={values.objective}
            onChange={event => setField(
              'objective',
              Array.from(event.target.value).slice(0, OBJECTIVE_MAX_LENGTH).join('')
            )}
            rows={4}
            minLength={OBJECTIVE_MIN_LENGTH}
            placeholder="Describe what the goal-capable agent should accomplish."
            disabled={submitting}
            required
            aria-invalid={Boolean(errors.objective)}
            aria-describedby={errors.objective ? 'goal-objective-error' : 'goal-objective-hint'}
            className="w-full resize-y rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 disabled:bg-gray-50"
          />
          <p id="goal-objective-hint" className="mt-1 text-xs text-gray-500">Required · {OBJECTIVE_MIN_LENGTH}–{OBJECTIVE_MAX_LENGTH} characters after trimming</p>
          {errors.objective && <FieldError id="goal-objective-error" message={errors.objective} />}
        </div>

        <div>
          <FieldLabel htmlFor="goal-repository" label="Repository" required />
          <select
            id="goal-repository"
            value={values.repository}
            onChange={event => setField('repository', event.target.value)}
            disabled={submitting || repositories.length === 0}
            required
            aria-invalid={Boolean(errors.repository)}
            aria-describedby={errors.repository ? 'goal-repository-error' : undefined}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 disabled:bg-gray-50"
          >
            {repositories.length === 0 && <option value="">No repositories available</option>}
            {repositories.map(repository => <option key={repository.name} value={repository.name}>{repository.name}</option>)}
          </select>
          {errors.repository && <FieldError id="goal-repository-error" message={errors.repository} />}
          {repositories.length === 0 && (
            <p className="mt-1 text-xs text-amber-700">Add an enabled repository on the <Link to="/repositories" className="underline">Repositories page</Link>.</p>
          )}
        </div>

        <AgentModelPicker
          agents={agents}
          values={values}
          errors={errors}
          disabled={submitting}
          onAgentChange={setAgent}
          onModelChange={model => setField('model', model)}
        />
        {agents.length === 0 && (
          <p className="text-xs text-amber-700">No agents are explicitly marked goal-capable. Update the coding-agent catalog first.</p>
        )}

        <div>
          <FieldLabel htmlFor="goal-concurrency" label="Maximum concurrent tasks" hint="The maximum tasks this goal may run in parallel." required />
          <input
            id="goal-concurrency"
            type="number"
            min={MAX_CONCURRENT_TASKS_MIN}
            max={MAX_CONCURRENT_TASKS_MAX}
            step={1}
            value={values.maxActiveTasks}
            onChange={event => setField('maxActiveTasks', Number(event.target.value))}
            disabled={submitting}
            required
            aria-invalid={Boolean(errors.maxActiveTasks)}
            aria-describedby={errors.maxActiveTasks ? 'goal-concurrency-error' : 'goal-concurrency-hint'}
            className="w-24 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
          />
          <span id="goal-concurrency-hint" className="ml-3 text-xs text-gray-500">{MAX_CONCURRENT_TASKS_MIN}–{MAX_CONCURRENT_TASKS_MAX} tasks</span>
          {errors.maxActiveTasks && <FieldError id="goal-concurrency-error" message={errors.maxActiveTasks} />}
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-gray-700">Merge policy</legend>
          <div className="space-y-2">
            {AUTO_MERGE_OPTIONS.map(option => (
              <label key={option.value} className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 has-[:checked]:border-teal-500 has-[:checked]:bg-teal-50">
                <input type="radio" name="merge-policy" value={option.value} checked={values.mergePolicy === option.value} onChange={() => setField('mergePolicy', option.value)} disabled={submitting} className="mt-0.5" />
                <span><span className="block text-sm font-medium text-gray-800">{option.label}</span><span className="text-xs text-gray-500">{option.description}</span></span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium text-gray-700">Ultrafix</legend>
          <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={values.ultrafixEnabled} onChange={event => setField('ultrafixEnabled', event.target.checked)} disabled={submitting} />
            Run Ultrafix after each pull request
          </label>
          {values.ultrafixEnabled && (
            <div className="mt-3 grid grid-cols-1 gap-4 rounded-lg border border-gray-200 bg-gray-50 p-3 sm:grid-cols-2">
              <div>
                <label htmlFor="ultrafix-goal-score" className="text-xs font-medium text-gray-700">Review goal ({ULTRAFIX_GOAL_MIN}–{ULTRAFIX_GOAL_MAX})</label>
                <input id="ultrafix-goal-score" type="number" min={ULTRAFIX_GOAL_MIN} max={ULTRAFIX_GOAL_MAX} value={values.ultrafixGoal} onChange={event => setField('ultrafixGoal', event.target.value)} disabled={submitting} aria-invalid={Boolean(errors.ultrafixGoal)} aria-describedby={errors.ultrafixGoal ? 'ultrafix-goal-error' : undefined} className="mt-1 block w-24 rounded border border-gray-300 bg-white px-2 py-1 text-sm" />
                {errors.ultrafixGoal && <FieldError id="ultrafix-goal-error" message={errors.ultrafixGoal} />}
              </div>
              <div>
                <label htmlFor="ultrafix-max-cycles" className="text-xs font-medium text-gray-700">Maximum cycles ({ULTRAFIX_CYCLES_MIN}–{ULTRAFIX_CYCLES_MAX})</label>
                <input id="ultrafix-max-cycles" type="number" min={ULTRAFIX_CYCLES_MIN} max={ULTRAFIX_CYCLES_MAX} value={values.ultrafixMaxCycles} onChange={event => setField('ultrafixMaxCycles', event.target.value)} disabled={submitting} aria-invalid={Boolean(errors.ultrafixMaxCycles)} aria-describedby={errors.ultrafixMaxCycles ? 'ultrafix-cycles-error' : undefined} className="mt-1 block w-24 rounded border border-gray-300 bg-white px-2 py-1 text-sm" />
                {errors.ultrafixMaxCycles && <FieldError id="ultrafix-cycles-error" message={errors.ultrafixMaxCycles} />}
              </div>
            </div>
          )}
        </fieldset>

        {errors.submit && <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"><AlertCircle className="h-4 w-4" aria-hidden="true" />{errors.submit}</div>}
        <div className="flex items-center gap-3 border-t border-gray-100 pt-4">
          <button type="submit" disabled={submitting || isDemoMode} className="inline-flex items-center gap-2 rounded-md bg-teal-600 px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Creating…</> : <><Target className="h-4 w-4" aria-hidden="true" />Create Goal</>}
          </button>
          <button type="button" onClick={cancel} disabled={submitting} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">Cancel</button>
        </div>
      </div>
    </form>
  );
};

export const GoalCreateHeader = ({ onBack }: { onBack: () => void }) => (
  <div className="flex-shrink-0 border-b border-gray-200 bg-slate-50 px-4 py-2 sm:px-6 sm:py-4">
    <div className="flex items-center gap-3">
      <button type="button" onClick={onBack} className="-ml-1 rounded p-1 text-gray-500" aria-label="Back to Goals"><ChevronLeft className="h-5 w-5" aria-hidden="true" /></button>
      <h1 className="text-lg font-bold text-gray-800 sm:text-2xl">New Goal</h1>
    </div>
  </div>
);
