import type { Plan, PlanItem } from './types.js';

export const REFINEMENT_OUTPUT_INVALID = 'REFINEMENT_OUTPUT_INVALID' as const;

export type RefinementOutputFailureReason =
  | 'incomplete_tasks'
  | 'unknown_operation'
  | 'unknown_target'
  | 'mixed_shape'
  | 'empty_plan';

export interface IncompleteRefinedTask {
  index: number;
  missing: string[];
}

export interface RefinementOutputDetails {
  reason: RefinementOutputFailureReason;
  incomplete?: IncompleteRefinedTask[];
  operations?: number;
}

export type NormalizedRefinedPlan =
  | { ok: true; plan: Plan; merged: boolean; operations?: number }
  | { ok: false; code: typeof REFINEMENT_OUTPUT_INVALID; message: string; details: RefinementOutputDetails };

export class RefinementOutputError extends Error {
  readonly code = REFINEMENT_OUTPUT_INVALID;

  constructor(message: string, readonly details: RefinementOutputDetails) {
    super(message);
    this.name = 'RefinementOutputError';
  }
}

type TaskRecord = Record<string, unknown>;
type EditOperation = 'retain' | 'keep' | 'extend' | 'update' | 'replace' | 'add' | 'remove' | 'delete';

const operations = new Set<EditOperation>([
  'retain', 'keep', 'extend', 'update', 'replace', 'add', 'remove', 'delete',
]);
const requiredFields = ['title', 'body', 'implementation'] as const;
const operationFields = new Set(['action', 'op', 'index', 'afterIndex']);

function record(value: unknown): TaskRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as TaskRecord
    : undefined;
}

function missingFields(value: unknown): string[] {
  const item = record(value);
  return requiredFields.filter(field => typeof item?.[field] !== 'string' || !(item[field] as string).trim());
}

function incompleteTasks(plan: unknown[]): IncompleteRefinedTask[] {
  return plan.flatMap((item, index) => {
    const missing = missingFields(item);
    return missing.length ? [{ index, missing }] : [];
  });
}

function failure(reason: RefinementOutputFailureReason, message: string, extra: Omit<RefinementOutputDetails, 'reason'> = {}): NormalizedRefinedPlan {
  return { ok: false, code: REFINEMENT_OUTPUT_INVALID, message, details: { reason, ...extra } };
}

function operationName(item: TaskRecord): unknown {
  if (Object.hasOwn(item, 'action') && Object.hasOwn(item, 'op') && item.action !== item.op) return undefined;
  return Object.hasOwn(item, 'action') ? item.action : item.op;
}

function targetIndex(item: TaskRecord, current: TaskRecord[]): number | undefined {
  // A supplied index is authoritative. This also lets an update target by
  // index while providing a new title for the task.
  if (Object.hasOwn(item, 'index')) {
    return Number.isSafeInteger(item.index) && Number(item.index) >= 0 && Number(item.index) < current.length
      ? Number(item.index)
      : undefined;
  }
  if (Object.hasOwn(item, 'id')) {
    const matches = current.flatMap((task, index) => task.id === item.id ? [index] : []);
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (typeof item.title === 'string') {
    const matches = current.flatMap((task, index) => task.title === item.title ? [index] : []);
    return matches.length === 1 ? matches[0] : undefined;
  }
  return undefined;
}

function editableFields(item: TaskRecord): TaskRecord {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !operationFields.has(key)));
}

function appendText(existing: unknown, addition: string): string {
  if (!addition) return typeof existing === 'string' ? existing : '';
  return typeof existing === 'string' && existing.length > 0 ? `${existing}\n\n${addition}` : addition;
}

/**
 * Accept a complete refined plan, or deterministically apply an edit-style
 * model response to the plan it was asked to refine. Ambiguous output fails
 * closed so callers never replace a complete plan with partial instructions.
 */
// eslint-disable-next-line complexity -- every accepted edit variant is validated and merged in one deterministic pass
export function normalizeRefinedPlan(currentPlan: Plan, refined: unknown): NormalizedRefinedPlan {
  if (!Array.isArray(refined)) {
    return failure('mixed_shape', 'The refinement output is not a plan array or edit list.');
  }
  if (refined.length === 0) {
    return failure('empty_plan', 'The refinement returned an empty plan.');
  }

  const records = refined.map(record);
  const hasDiscriminator = records.map(item => !!item && (Object.hasOwn(item, 'action') || Object.hasOwn(item, 'op')));
  const operationCount = hasDiscriminator.filter(Boolean).length;
  if (operationCount === 0) {
    const incomplete = incompleteTasks(refined);
    return incomplete.length
      ? failure('incomplete_tasks', 'The refinement returned incomplete plan tasks.', { incomplete })
      : { ok: true, plan: refined as Plan, merged: false };
  }
  if (operationCount !== refined.length || records.some(item => !item)) {
    return failure('mixed_shape', 'The refinement mixed complete tasks with edit operations.', { operations: operationCount });
  }

  const edits = records as TaskRecord[];
  const names = edits.map(operationName);
  if (names.some(name => typeof name !== 'string' || !operations.has(name as EditOperation))) {
    return failure('unknown_operation', 'The refinement contained an unrecognised edit operation.', { operations: edits.length });
  }

  const current = currentPlan.map(item => ({ ...item })) as TaskRecord[];
  const removed = new Set<number>();
  const targeted = new Set<number>();
  const additionsAfter = new Map<number, TaskRecord[]>();
  const appended: TaskRecord[] = [];

  for (let operationIndex = 0; operationIndex < edits.length; operationIndex++) {
    const edit = edits[operationIndex];
    const name = names[operationIndex] as EditOperation;
    if (name === 'add') {
      const added = editableFields(edit);
      if (Object.hasOwn(edit, 'afterIndex')) {
        if (!Number.isSafeInteger(edit.afterIndex) || Number(edit.afterIndex) < 0 || Number(edit.afterIndex) >= current.length) {
          return failure('unknown_target', 'An add operation referred to an unknown insertion target.', { operations: edits.length });
        }
        const afterIndex = Number(edit.afterIndex);
        const additions = additionsAfter.get(afterIndex) ?? [];
        additions.push(added);
        additionsAfter.set(afterIndex, additions);
      } else {
        appended.push(added);
      }
      continue;
    }

    const index = targetIndex(edit, current);
    if (index === undefined) {
      return failure('unknown_target', 'A refinement edit referred to an unknown task.', { operations: edits.length });
    }
    if (targeted.has(index)) {
      return failure('unknown_target', 'More than one refinement edit targeted the same task.', { operations: edits.length });
    }
    targeted.add(index);

    if (name === 'remove' || name === 'delete') {
      removed.add(index);
    } else if (name === 'update' || name === 'replace') {
      current[index] = { ...current[index], ...editableFields(edit) };
    } else if (name === 'extend') {
      for (const field of ['body', 'implementation', 'notes'] as const) {
        if (!Object.hasOwn(edit, field)) continue;
        if (typeof edit[field] !== 'string') {
          return failure('incomplete_tasks', `An extend operation provided an invalid ${field} value.`, {
            operations: edits.length,
            incomplete: [{ index, missing: [field] }],
          });
        }
        current[index][field] = appendText(current[index][field], edit[field] as string);
      }
    }
  }

  const merged: TaskRecord[] = [];
  current.forEach((task, index) => {
    if (!removed.has(index)) merged.push(task);
    merged.push(...(additionsAfter.get(index) ?? []));
  });
  merged.push(...appended);

  if (merged.length === 0) {
    return failure('empty_plan', 'The refinement edits removed every task from the plan.', { operations: edits.length });
  }
  const incomplete = incompleteTasks(merged);
  if (incomplete.length) {
    return failure('incomplete_tasks', 'The merged refinement contains incomplete plan tasks.', {
      operations: edits.length,
      incomplete,
    });
  }
  return { ok: true, plan: merged as unknown as PlanItem[], merged: true, operations: edits.length };
}
