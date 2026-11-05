import {
  parseGoalCheckpointOutput,
  type ParsedGoalCheckpointDeclaration,
  type ParsedGoalCheckpointOutput,
} from '@propr/shared';
import type { LiveEvent } from './types';

export interface CheckpointOutcome {
  kind: 'bootstrap' | 'agent' | 'final';
  state: 'pending' | 'processing' | 'completed' | 'skipped' | 'failed' | 'rejected';
  commitSha: string | null;
  message: string | null;
  include: string[] | null;
  exclude: string[] | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
}

export interface PreparedThinkingLogEvent extends LiveEvent {
  relativeTime?: string | null;
  checkpoint?: ParsedGoalCheckpointOutput | null;
  checkpointOutcome?: CheckpointOutcome;
}

// Live details poll with fresh event objects. Cache by immutable output content so old events are
// not scanned and JSON-parsed again every five seconds; bound it to the server's retained history.
const checkpointCache = new Map<string, ParsedGoalCheckpointOutput | null>();
const CHECKPOINT_CACHE_LIMIT = 1_000;

const checkpointOutput = (content: string | undefined): ParsedGoalCheckpointOutput | null => {
  if (!content) return null;
  const cached = checkpointCache.get(content);
  if (cached !== undefined || checkpointCache.has(content)) return cached ?? null;
  const parsed = parseGoalCheckpointOutput(content);
  if (checkpointCache.size >= CHECKPOINT_CACHE_LIMIT) {
    checkpointCache.delete(checkpointCache.keys().next().value!);
  }
  checkpointCache.set(content, parsed);
  return parsed;
};

const samePaths = (left: string[] | undefined, right: string[] | null): boolean =>
  (left?.join('\0') ?? null) === (right?.join('\0') ?? null);

const outcomeMatches = (
  event: LiveEvent,
  declaration: ParsedGoalCheckpointDeclaration,
  outcome: CheckpointOutcome | undefined,
): outcome is CheckpointOutcome => {
  if (!outcome || outcome.kind !== 'agent') return false;
  const eventAt = event.timestamp ? Date.parse(event.timestamp) : Number.NaN;
  const outcomeAt = outcome.createdAt ? Date.parse(outcome.createdAt) : Number.NaN;
  // A durable record created before this output is evidence for an older request, even if an agent
  // repeated the same payload. Records and output arrive through separate APIs, so newer records may lag.
  if (Number.isFinite(eventAt) && Number.isFinite(outcomeAt) && outcomeAt < eventAt) return false;
  return (declaration.message ?? null) === outcome.message
    && (declaration.summary ?? null) === outcome.summary
    && samePaths(declaration.include, outcome.include)
    && samePaths(declaration.exclude, outcome.exclude);
};

export function prepareCheckpointEvents(
  events: PreparedThinkingLogEvent[],
  checkpointOutcome: CheckpointOutcome | null | undefined,
): PreparedThinkingLogEvent[] {
  const prepared = events.map(event => ({ ...event, checkpoint: checkpointOutput(event.content) }));
  if (!checkpointOutcome) return prepared;
  for (let index = prepared.length - 1; index >= 0; index -= 1) {
    const checkpoint = prepared[index].checkpoint;
    if (checkpoint && outcomeMatches(prepared[index], checkpoint.declaration, checkpointOutcome)) {
      prepared[index].checkpointOutcome = checkpointOutcome;
      break;
    }
  }
  return prepared;
}
