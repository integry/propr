/**
 * Plan item identity and prerequisite edges.
 *
 * Every plan item carries a stable `id`; `dependsOn` optionally names the ids
 * of other items in the same plan that must land first. These pure helpers are
 * shared by every path that stores a plan (MCP, REST, generation, refinement,
 * restore) so they all accept and reject the same plans.
 */

export const PLAN_ITEM_ID_MAX_LENGTH = 255;

export type PlanItemGraphErrorCode =
  | 'invalid_id'
  | 'duplicate_id'
  | 'invalid_depends_on'
  | 'unknown_dependency'
  | 'self_dependency'
  | 'dependency_cycle';

export interface PlanItemGraphError {
  code: PlanItemGraphErrorCode;
  /** Zero-based position of the item the error names. */
  index: number;
  itemId?: string;
  title?: string;
  /** The offending `dependsOn` entry, for reference errors. */
  dependency?: string;
  /** Item ids along the cycle, starting and ending with the same id. */
  cycle?: string[];
  message: string;
}

export type PlanItemGraphResult =
  | { valid: true }
  | { valid: false; errors: PlanItemGraphError[]; message: string };

type ItemRecord = Record<string, unknown>;

function asRecord(value: unknown): ItemRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ItemRecord : undefined;
}

function hasId(item: ItemRecord | undefined): boolean {
  return typeof item?.id === 'string' && item.id.trim().length > 0;
}

function describe(index: number, item: ItemRecord | undefined): string {
  const title = typeof item?.title === 'string' && item.title.trim() ? ` "${item.title.trim()}"` : '';
  const id = typeof item?.id === 'string' && item.id ? ` (id "${item.id}")` : '';
  return `Task ${index + 1}${title}${id}`;
}

function errorFor(code: PlanItemGraphErrorCode, index: number, item: ItemRecord | undefined, message: string,
  extra: Partial<PlanItemGraphError> = {}): PlanItemGraphError {
  return {
    code, index, message,
    ...(typeof item?.id === 'string' ? { itemId: item.id } : {}),
    ...(typeof item?.title === 'string' ? { title: item.title } : {}),
    ...extra,
  };
}

/** The `dependsOn` list of an item, or an empty list when it has none. */
export function planItemDependencies(item: unknown): string[] {
  const dependsOn = asRecord(item)?.dependsOn;
  return Array.isArray(dependsOn) ? dependsOn.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** One cycle through `edges` (id → prerequisite ids), as a closed path, or null. */
function findCycle(ids: string[], edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 'visiting');
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      const seen = state.get(next);
      if (seen === 'visiting') return [...path.slice(path.indexOf(next)), next];
      if (seen === undefined) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };
  for (const id of ids) {
    if (state.has(id)) continue;
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Checks item ids and `dependsOn` edges: every id is a unique non-empty
 * string, and every `dependsOn` entry names another item of the same plan
 * without forming a cycle. A plan without any `dependsOn` is valid. With
 * `requireIds: false` items without an id are allowed (they cannot be
 * referenced), which is how a plan is checked before ids are assigned.
 */
// eslint-disable-next-line complexity -- one pass reports every id and reference error with the item it names
export function validatePlanItemGraph(items: readonly unknown[], options: { requireIds?: boolean } = {}): PlanItemGraphResult {
  const requireIds = options.requireIds ?? true;
  const errors: PlanItemGraphError[] = [];
  const records = items.map(asRecord);
  const positions = new Map<string, number>();

  records.forEach((item, index) => {
    const id = item?.id;
    if (id === undefined || id === null) {
      if (requireIds) errors.push(errorFor('invalid_id', index, item, `${describe(index, item)} has no id.`));
      return;
    }
    if (typeof id !== 'string' || !id.trim() || id.length > PLAN_ITEM_ID_MAX_LENGTH) {
      errors.push(errorFor('invalid_id', index, item,
        `${describe(index, item)} has an invalid id: ids are non-empty strings of at most ${PLAN_ITEM_ID_MAX_LENGTH} characters.`));
      return;
    }
    const first = positions.get(id);
    if (first !== undefined) {
      errors.push(errorFor('duplicate_id', index, item, `${describe(index, item)} reuses the id "${id}" of task ${first + 1}. Item ids must be unique.`));
      return;
    }
    positions.set(id, index);
  });

  const edges = new Map<string, string[]>();
  records.forEach((item, index) => {
    if (!item || !Object.hasOwn(item, 'dependsOn') || item.dependsOn === undefined) return;
    const dependsOn = item.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(entry => typeof entry !== 'string')) {
      errors.push(errorFor('invalid_depends_on', index, item, `${describe(index, item)} has an invalid dependsOn: it must be a list of item ids.`));
      return;
    }
    const ownId = typeof item.id === 'string' ? item.id : undefined;
    const prerequisites: string[] = [];
    for (const dependency of dependsOn as string[]) {
      if (ownId !== undefined && dependency === ownId) {
        errors.push(errorFor('self_dependency', index, item, `${describe(index, item)} depends on itself.`, { dependency }));
      } else if (!positions.has(dependency)) {
        errors.push(errorFor('unknown_dependency', index, item,
          `${describe(index, item)} depends on "${dependency}", which matches no item in this plan.`, { dependency }));
      } else if (!prerequisites.includes(dependency)) {
        prerequisites.push(dependency);
      }
    }
    if (ownId !== undefined && positions.get(ownId) === index) edges.set(ownId, prerequisites);
  });

  if (errors.length === 0) {
    const cycle = findCycle([...positions.keys()], edges);
    if (cycle) {
      const index = positions.get(cycle[0])!;
      const item = records[index];
      errors.push(errorFor('dependency_cycle', index, item,
        `${describe(index, item)} is part of a dependency cycle: ${cycle.map(id => `"${id}"`).join(' → ')}.`, { cycle }));
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors, message: errors[0].message };
}

function randomSuffix(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return (uuid ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`).replace(/-/g, '').slice(0, 12);
}

/** A fresh plan item id that is not in `taken`. */
export function generatePlanItemId(taken: ReadonlySet<string> = new Set()): string {
  let id = `item-${randomSuffix()}`;
  while (taken.has(id)) id = `item-${randomSuffix()}`;
  return id;
}

/**
 * Gives every item without an id a fresh one. An item that already has an id
 * keeps it unchanged, even when it collides with another (validation rejects
 * that instead of silently renaming an id that may be referenced).
 */
export function assignPlanItemIds<T>(items: readonly T[], generate: (taken: ReadonlySet<string>) => string = generatePlanItemId): T[] {
  const taken = new Set<string>();
  for (const item of items) {
    const record = asRecord(item);
    if (hasId(record)) taken.add(record!.id as string);
  }
  return items.map(item => {
    const record = asRecord(item);
    if (!record || hasId(record) || (record.id !== undefined && record.id !== null && record.id !== '')) return item;
    const id = generate(taken);
    taken.add(id);
    return { ...record, id } as T;
  });
}

export type NormalizedPlanItems<T> =
  | { ok: true; plan: T[] }
  | { ok: false; errors: PlanItemGraphError[]; message: string };

/** Assigns missing ids, then validates ids and dependencies: the check every stored plan passes. */
export function normalizePlanItems<T>(items: readonly T[]): NormalizedPlanItems<T> {
  const plan = assignPlanItemIds(items);
  const result = validatePlanItemGraph(plan);
  return result.valid ? { ok: true, plan } : { ok: false, errors: result.errors, message: result.message };
}

function withDependencies(record: ItemRecord, dependsOn: string[]): ItemRecord {
  const copy: ItemRecord = { ...record };
  if (dependsOn.length) copy.dependsOn = dependsOn;
  else delete copy.dependsOn;
  return copy;
}

/**
 * Repairs model-written dependencies instead of rejecting the plan: entries
 * that name no item or the item itself are dropped, and each cycle loses the
 * edge that closes it. Items without a valid id are left as they are.
 */
export function prunePlanItemDependencies<T>(items: readonly T[]): T[] {
  const ids = new Set(items.map(asRecord).filter(hasId).map(item => item!.id as string));
  let plan = items.map(item => {
    const record = asRecord(item);
    if (!record || !Object.hasOwn(record, 'dependsOn')) return item;
    const ownId = hasId(record) ? record.id as string : undefined;
    const kept = [...new Set(planItemDependencies(record))].filter(dependency => dependency !== ownId && ids.has(dependency));
    const unchanged = Array.isArray(record.dependsOn) && kept.length === record.dependsOn.length
      && kept.every((dependency, index) => (record.dependsOn as unknown[])[index] === dependency);
    return unchanged ? item : withDependencies(record, kept) as T;
  });
  for (let guard = 0; guard <= plan.length * plan.length; guard++) {
    const edges = new Map<string, string[]>();
    for (const item of plan.map(asRecord)) if (hasId(item)) edges.set(item!.id as string, planItemDependencies(item));
    const cycle = findCycle([...edges.keys()], edges);
    if (!cycle) break;
    const [from, to] = cycle.slice(-2);
    plan = plan.map(item => {
      const record = asRecord(item);
      if (!record || record.id !== from) return item;
      return withDependencies(record, planItemDependencies(record).filter(dependency => dependency !== to)) as T;
    });
  }
  return plan;
}

/**
 * Transitive reduction of `dependsOn`: drops an entry when it is already a
 * prerequisite, directly or indirectly, of another entry of the same item, so
 * each item lists only its direct prerequisites. The remaining entries keep
 * their order, and an item left with none loses the field. Expects an acyclic
 * graph (run it after validation or pruning); items it does not change are
 * returned as the same objects.
 */
export function reducePlanItemDependencies<T>(items: readonly T[]): T[] {
  const edges = new Map<string, string[]>();
  for (const item of items.map(asRecord)) {
    if (hasId(item) && !edges.has(item!.id as string)) edges.set(item!.id as string, planItemDependencies(item));
  }
  const reachable = new Map<string, Set<string>>();
  const ancestorsOf = (id: string, visiting: Set<string> = new Set()): Set<string> => {
    const known = reachable.get(id);
    if (known) return known;
    const result = new Set<string>();
    visiting.add(id);
    for (const next of edges.get(id) ?? []) {
      if (visiting.has(next)) continue;
      result.add(next);
      for (const further of ancestorsOf(next, visiting)) result.add(further);
    }
    visiting.delete(id);
    reachable.set(id, result);
    return result;
  };
  return items.map(item => {
    const record = asRecord(item);
    if (!record || !Array.isArray(record.dependsOn)) return item;
    const dependencies = planItemDependencies(record);
    const kept = dependencies.filter((dependency, position) =>
      dependencies.indexOf(dependency) === position
      && !dependencies.some(other => other !== dependency && ancestorsOf(other).has(dependency)));
    return kept.length === record.dependsOn.length ? item : withDependencies(record, kept) as T;
  });
}

export interface PlanItemIssueDependencies {
  index: number;
  itemId: string | null;
  issueNumber: number | null;
  /** Prerequisite issue numbers, in `dependsOn` order, for prerequisites that have an issue. */
  dependsOnIssues: number[];
}

/**
 * Resolves each published item's `dependsOn` ids to the issue numbers of the
 * items they name. `issueNumbers` holds each item's issue number by position;
 * prerequisites that were not published are left out.
 */
export function resolvePlanItemIssueDependencies(items: readonly unknown[], issueNumbers: ReadonlyArray<number | null | undefined>): PlanItemIssueDependencies[] {
  const issueById = new Map<string, number>();
  items.forEach((item, index) => {
    const record = asRecord(item);
    const number = issueNumbers[index];
    if (hasId(record) && typeof number === 'number' && !issueById.has(record!.id as string)) issueById.set(record!.id as string, number);
  });
  return items.map((item, index) => {
    const record = asRecord(item);
    const number = issueNumbers[index];
    const dependsOnIssues: number[] = [];
    for (const dependency of planItemDependencies(record)) {
      const prerequisite = issueById.get(dependency);
      if (prerequisite !== undefined && prerequisite !== number && !dependsOnIssues.includes(prerequisite)) dependsOnIssues.push(prerequisite);
    }
    return {
      index,
      itemId: hasId(record) ? record!.id as string : null,
      issueNumber: typeof number === 'number' ? number : null,
      dependsOnIssues,
    };
  });
}

/** Serialized form of a `plan_issues.depends_on_issues` value. */
export function serializeDependsOnIssues(numbers: readonly number[]): string {
  return JSON.stringify([...numbers]);
}

/** Reads a stored `plan_issues.depends_on_issues` value; rows from before the column read as no prerequisites. */
export function parseDependsOnIssues(value: unknown): number[] {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed.filter((entry): entry is number => Number.isSafeInteger(entry) && entry > 0) : [];
}

/**
 * Ids and dependencies for a plan a model just wrote (generation or
 * refinement), which is repaired instead of rejected: a malformed or repeated
 * id is replaced by a fresh one so it cannot capture another item's
 * dependents, items without an id get one, and references that name no item,
 * the item itself, or close a cycle are dropped. Entries reachable through
 * another entry of the same item are dropped too, so each item lists only its
 * direct prerequisites. Valid ids are kept as given. Plans a user saves are not
 * reduced; they are validated and stored as written.
 */
export function preparePlanItemsFromModel<T>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const taken = new Set(items.map(asRecord).filter(hasId).map(item => item!.id as string));
  const withUniqueIds = items.map(item => {
    const record = asRecord(item);
    if (!record) return item;
    const id = record.id;
    if (typeof id === 'string' && id.trim() && id.length <= PLAN_ITEM_ID_MAX_LENGTH && !seen.has(id)) {
      seen.add(id);
      return item;
    }
    if (id === undefined) return item;
    const fresh = generatePlanItemId(taken);
    taken.add(fresh);
    seen.add(fresh);
    return { ...record, id: fresh } as T;
  });
  return reducePlanItemDependencies(prunePlanItemDependencies(assignPlanItemIds(withUniqueIds)));
}

/** A plan issue row as returned by the API: its plan item id and prerequisite issue numbers parsed. */
export function withPlanIssueDependencies<T extends object>(row: T):
  Omit<T, 'plan_item_id' | 'depends_on_issues'> & { plan_item_id: string | null; depends_on_issues: number[] } {
  const record = row as { plan_item_id?: unknown; depends_on_issues?: unknown };
  return {
    ...row,
    plan_item_id: typeof record.plan_item_id === 'string' && record.plan_item_id ? record.plan_item_id : null,
    depends_on_issues: parseDependsOnIssues(record.depends_on_issues),
  };
}
