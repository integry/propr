/**
 * Which sections of the dashboard care about which changes.
 *
 * One shared token used to fan every task event out to all four sections, so an
 * agent's tool-call heartbeat re-ran the aggregate completion-count query behind
 * the historical stats panel. Declaring the interests here makes that impossible
 * by construction, and puts the reason each section reacts in one readable place
 * instead of spreading it across four components.
 *
 * Nothing in here guesses whether a frame was meaningful: the pushed envelope
 * states the `domain`, the `change` and a `revision`, which is exactly what the
 * old client-side task-state fingerprint was trying to approximate.
 */

import { useEffect, useRef, useState } from 'react';
import { useSocket } from '../../contexts/useSocket';
import type { ActivityChange, ActivityDomain, ActivityUpdatePayload } from '@propr/shared';
import { ALL_REPOSITORIES } from './sectionState';

interface SectionInterest {
  domains?: readonly ActivityDomain[];
  changes?: readonly ActivityChange[];
}

const SECTION_INTERESTS = {
  // A blocker can arrive as a failed task, an action-required task, a plan
  // issue awaiting review, or a dismissal that clears one.
  attention: {
    domains: ['task', 'goal', 'plan', 'notification'],
    changes: ['blocked', 'failed', 'created', 'completed', 'cancelled', 'dismissed'],
  },
  // The only section that legitimately wants progress: it is showing what is
  // happening right now, including queue depth.
  active: {
    domains: ['task', 'goal', 'queue'],
  },
  completed: {
    domains: ['task', 'goal', 'plan'],
    changes: ['completed'],
  },
  // Aggregates change only when work finishes. A heartbeat must never trigger a
  // stats query — that was the single most wasteful refresh on the page.
  stats: {
    changes: ['completed', 'failed', 'cancelled'],
  },
} as const satisfies Record<string, SectionInterest>;

export type DashboardSectionName = keyof typeof SECTION_INTERESTS;
export type SectionRefreshTokens = Record<DashboardSectionName, number>;

const SECTION_NAMES = Object.keys(SECTION_INTERESTS) as DashboardSectionName[];

const zeroTokens = (): SectionRefreshTokens =>
  Object.fromEntries(SECTION_NAMES.map(name => [name, 0])) as SectionRefreshTokens;

/** Sections woken by a goal transition, which carries no domain of its own. */
const GOAL_SECTIONS: readonly DashboardSectionName[] = ['attention', 'active', 'completed'];

function isRelevant(
  payload: ActivityUpdatePayload,
  section: DashboardSectionName,
  repository: string,
): boolean {
  const interest: SectionInterest = SECTION_INTERESTS[section];
  if (interest.domains && !interest.domains.includes(payload.domain)) return false;
  if (interest.changes && !interest.changes.includes(payload.change)) return false;
  // Repository scoping happens here, before any request: an event for a
  // repository the dashboard is not showing must cost nothing at all.
  if (repository !== ALL_REPOSITORIES && payload.repository !== null && payload.repository !== repository) {
    return false;
  }
  return true;
}

/**
 * Per-section refresh tokens, bumped only by relevant pushed activity.
 *
 * Coalescing, visibility pausing, reconnect reconciliation and disconnected
 * fallback polling all live in the sections' own `useDashboardSection`, which
 * reads these tokens — so this hook's only job is to decide whether a frame
 * matters to a given section.
 */
export function useSectionRefreshTokens(repository: string): SectionRefreshTokens {
  const {
    subscribeToActivity,
    unsubscribeFromActivity,
    onActivityUpdate,
    onGoalUpdate,
  } = useSocket();
  const [tokens, setTokens] = useState<SectionRefreshTokens>(zeroTokens);
  // Held in a ref so a changed repository does not re-register the listener.
  const repositoryRef = useRef(repository);
  repositoryRef.current = repository;

  useEffect(() => {
    subscribeToActivity();
    return () => { unsubscribeFromActivity(); };
  }, [subscribeToActivity, unsubscribeFromActivity]);

  useEffect(() => {
    const bump = (affected: readonly DashboardSectionName[]) => {
      if (affected.length === 0) return;
      // One state update covering every affected section, so React batches a
      // single render rather than one per section.
      setTokens(previous => {
        const next = { ...previous };
        for (const name of affected) next[name] += 1;
        return next;
      });
    };
    const unsubscribeActivity = onActivityUpdate((payload: ActivityUpdatePayload) => {
      bump(SECTION_NAMES.filter(name => isRelevant(payload, name, repositoryRef.current)));
    });
    // Goal-shaped frames are also projected as activity by the server, so this
    // is belt-and-braces for a relay that emits only the typed goal event.
    const unsubscribeGoal = onGoalUpdate(payload => {
      const scope = repositoryRef.current;
      if (scope !== ALL_REPOSITORIES && payload.repository !== null && payload.repository !== scope) return;
      bump(GOAL_SECTIONS);
    });
    return () => { unsubscribeActivity(); unsubscribeGoal(); };
  }, [onActivityUpdate, onGoalUpdate]);

  /*
    Nothing here reacts to the connection state. A reconnect is reconciled, and
    a dropped socket is polled through, by each section's own scheduler inside
    `useDashboardSection` — so a token only ever means "something relevant was
    pushed", never "the socket did something".
  */

  return tokens;
}
