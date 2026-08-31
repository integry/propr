import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  getGoalCapableModels,
  isGoalCapableCatalogAgent,
  type InstanceCatalogAgent,
  type InstanceCatalogRepository,
} from '@propr/shared';
import { getInstanceCatalog } from '../api/proprApi';
import { createGoal, isGoalApiErrorCode } from '../api/goalsApi';
import { isDemoModeReadOnlyError } from '../api/apiClient';
import { useDemoMode } from '../contexts/DemoModeContext';
import { useToast } from '../components/ui/useToast';
import {
  buildCreateGoalParams,
  type GoalFormErrors,
  type GoalFormValues,
  validateGoalForm,
} from './goalCreateUtils';
import { GOALS_RETURN_TO_PARAM, goalsReturnTarget } from './goalsUrlState';

const initialValues: GoalFormValues = {
  objective: '',
  repository: '',
  agent: '',
  model: '',
  maxActiveTasks: 3,
  mergePolicy: 'manual',
  ultrafixEnabled: false,
  ultrafixGoal: '8',
  ultrafixMaxCycles: '10',
};

const newIdempotencyKey = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export function useGoalCreateForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const rawReturnTarget = searchParams.get(GOALS_RETURN_TO_PARAM);
  const returnTarget = useMemo(() => goalsReturnTarget(rawReturnTarget), [rawReturnTarget]);
  const { isDemoMode } = useDemoMode();
  const { addToast } = useToast();
  const [agents, setAgents] = useState<InstanceCatalogAgent[]>([]);
  const [repositories, setRepositories] = useState<InstanceCatalogRepository[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [values, setValues] = useState<GoalFormValues>(initialValues);
  const [errors, setErrors] = useState<GoalFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  if (idempotencyKeyRef.current === null) idempotencyKeyRef.current = newIdempotencyKey();
  const lastAttemptRef = useRef<{ payload: string; key: string } | null>(null);
  const submissionInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getInstanceCatalog()
      .then(data => {
        if (cancelled) return;
        const goalAgents = data.agents.filter(agent =>
          isGoalCapableCatalogAgent(agent) && getGoalCapableModels(agent).length > 0
        );
        const enabledRepositories = data.repositories.filter(repository => repository.enabled);
        const preferredAgent = goalAgents.find(agent => agent.alias === data.defaultAgentAlias) ?? goalAgents[0];
        const models = preferredAgent ? getGoalCapableModels(preferredAgent) : [];
        const preferredModel = preferredAgent?.defaultModel && models.includes(preferredAgent.defaultModel)
          ? preferredAgent.defaultModel
          : models[0] ?? '';
        setAgents(goalAgents);
        setRepositories(enabledRepositories);
        setValues(current => ({
          ...current,
          agent: preferredAgent?.alias ?? '',
          model: preferredModel,
          repository: enabledRepositories[0]?.name ?? '',
        }));
      })
      .catch(error => {
        if (!cancelled) setCatalogError((error as Error).message || 'Failed to load catalog');
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const setField = useCallback(<K extends keyof GoalFormValues>(field: K, value: GoalFormValues[K]) => {
    setValues(current => ({ ...current, [field]: value }));
    setErrors(current => ({ ...current, [field]: undefined, submit: undefined }));
  }, []);

  const setAgent = useCallback((alias: string) => {
    const agent = agents.find(candidate => candidate.alias === alias);
    const models = agent ? getGoalCapableModels(agent) : [];
    const model = agent?.defaultModel && models.includes(agent.defaultModel)
      ? agent.defaultModel
      : models[0] ?? '';
    setValues(current => ({ ...current, agent: alias, model }));
    setErrors(current => ({ ...current, agent: undefined, model: undefined, submit: undefined }));
  }, [agents]);

  const submit = useCallback(async () => {
    if (isDemoMode || submissionInFlightRef.current) return;
    const validationErrors = validateGoalForm(values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    submissionInFlightRef.current = true;
    setSubmitting(true);
    setErrors({});
    const params = buildCreateGoalParams(values);
    const payload = JSON.stringify(params);
    if (lastAttemptRef.current && lastAttemptRef.current.payload !== payload) {
      idempotencyKeyRef.current = newIdempotencyKey();
      lastAttemptRef.current = null;
    }
    const key = idempotencyKeyRef.current ?? newIdempotencyKey();
    idempotencyKeyRef.current = key;
    lastAttemptRef.current = { payload, key };
    try {
      await createGoal(params, key);
      addToast({ type: 'success', message: 'Goal created successfully.' });
      navigate(returnTarget);
    } catch (error) {
      const idempotencyConflict = isGoalApiErrorCode(error, 'goal_idempotency_conflict');
      if (idempotencyConflict) {
        idempotencyKeyRef.current = newIdempotencyKey();
        lastAttemptRef.current = null;
      }
      setErrors({
        submit: idempotencyConflict
          ? 'This retry key was already used for different goal settings. A new key is ready; submit again to start this goal as a new intent.'
          : isDemoModeReadOnlyError(error)
          ? 'Goal creation is disabled in demo mode.'
          : (error as Error).message || 'Failed to create goal. Please try again.',
      });
    } finally {
      submissionInFlightRef.current = false;
      setSubmitting(false);
    }
  }, [addToast, isDemoMode, navigate, returnTarget, values]);

  return {
    agents,
    repositories,
    catalogLoading,
    catalogError,
    values,
    errors,
    submitting,
    isDemoMode,
    setField,
    setAgent,
    submit,
    cancel: () => navigate(returnTarget),
  };
}
