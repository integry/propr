import crypto from 'node:crypto';
import { GOAL_ERROR_CODES, GOAL_NODE_KINDS, type GoalNodeKind } from '@propr/shared';
import { GoalError, boundedText } from './goalRepositorySupport.js';
import {
  GOAL_PLAN_MAX_DEPTH,
  GOAL_PLAN_MAX_ESTIMATE,
  GOAL_PLAN_MAX_NODES,
  GOAL_PLAN_SCHEMA_VERSION,
  type GoalPlanInput,
  type GoalPlanNodeInput,
  type ValidatedGoalPlan,
  type ValidatedGoalPlanNode,
} from './goalOrchestrationTypes.js';

const KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

export function deterministicGoalNodeId(goalId: string, key: string): string {
  return `gn_${crypto.createHash('sha256').update(`${goalId}\0${key}`).digest('hex').slice(0, 32)}`;
}

export function deterministicGoalBranch(goalId: string, key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'work';
  const digest = crypto.createHash('sha256').update(`${goalId}\0${key}`).digest('hex').slice(0, 10);
  return `propr/goal-${slug}-${digest}`;
}

export function validateGoalPlan(goalIdValue: string, input: GoalPlanInput): ValidatedGoalPlan {
  const goalId = boundedText(goalIdValue, 'goalId') as string;
  if (!input || typeof input !== 'object' || input.schemaVersion !== GOAL_PLAN_SCHEMA_VERSION) {
    invalid('Plan schemaVersion must be 1');
  }
  const baseBranch = branch(input.baseBranch, 'baseBranch');
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > GOAL_PLAN_MAX_NODES) {
    invalid(`Plan must contain between 1 and ${GOAL_PLAN_MAX_NODES} nodes`);
  }

  const byKey = new Map<string, GoalPlanNodeInput>();
  input.nodes.forEach((node, index) => {
    validateInputNode(node, index);
    if (byKey.has(node.key)) invalid(`Duplicate node key: ${node.key}`);
    byKey.set(node.key, node);
  });
  const singlePullRequestGoal = input.nodes.length === 1 && input.nodes[0].kind === 'implementation_pr'
    && input.nodes[0].parentKey == null;
  const roots = input.nodes.filter((node) => node.kind === 'root_epic');
  if (!singlePullRequestGoal && (roots.length !== 1 || roots[0].parentKey != null)) {
    invalid('Plan must contain exactly one parentless root epic, or one parentless implementation PR');
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (key: string): number => {
    const known = depths.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) invalid('Plan parent graph contains a cycle');
    visiting.add(key);
    const node = byKey.get(key)!;
    const depth = node.parentKey == null ? 0 : depthOf(requireNode(byKey, node.parentKey, `parent of ${key}`).key) + 1;
    visiting.delete(key);
    if (depth > GOAL_PLAN_MAX_DEPTH) invalid(`Plan hierarchy exceeds maximum depth ${GOAL_PLAN_MAX_DEPTH}`);
    depths.set(key, depth);
    return depth;
  };
  input.nodes.forEach((node) => {
    const depth = depthOf(node.key);
    if (node.kind !== 'root_epic' && !singlePullRequestGoal) {
      const parent = requireNode(byKey, node.parentKey, `parent of ${node.key}`);
      if (!legalParent(parent.kind, node.kind)) invalid(`Illegal ${parent.kind} -> ${node.kind} relationship for ${node.key}`);
      if (depth === 0) invalid(`Only the root epic may be parentless: ${node.key}`);
    }
  });

  validateDependencyGraph(input.nodes, byKey);

  // A stable topological/tree order makes retries and plan diffs reproducible,
  // independent of object ordering produced by an LLM.
  const ordered = [...input.nodes].sort((left, right) => {
    const depth = depthOf(left.key) - depthOf(right.key);
    return depth || left.key.localeCompare(right.key);
  });
  const nodeIdByKey = new Map(ordered.map((node) => [node.key, deterministicGoalNodeId(goalId, node.key)]));
  const headByKey = new Map(ordered.map((node) => [node.key, deterministicGoalBranch(goalId, node.key)]));
  const nodes: ValidatedGoalPlanNode[] = ordered.map((node, orderIndex) => {
    const parent = node.parentKey == null ? null : byKey.get(node.parentKey)!;
    const integrationParent = parent == null
      ? null
      : parent.kind === 'implementation_issue'
        ? (parent.parentKey == null ? null : byKey.get(parent.parentKey)!)
        : parent;
    return {
      nodeId: nodeIdByKey.get(node.key)!,
      key: node.key,
      kind: node.kind,
      title: node.title.trim(),
      parentNodeId: node.parentKey == null ? null : nodeIdByKey.get(node.parentKey)!,
      dependencyNodeIds: [...new Set(node.dependsOn ?? [])].sort().map((key) => nodeIdByKey.get(key)!),
      estimate: node.estimate,
      acceptanceCriteria: node.acceptanceCriteria.map((criterion) => criterion.trim()),
      depth: depthOf(node.key),
      orderIndex,
      baseBranch: integrationParent == null ? baseBranch : headByKey.get(integrationParent.key)!,
      headBranch: headByKey.get(node.key)!,
      noCode: node.noCode === true,
    };
  });
  const canonical = JSON.stringify({ schemaVersion: 1, goalId, baseBranch, nodes });
  return {
    schemaVersion: GOAL_PLAN_SCHEMA_VERSION,
    goalId,
    baseBranch,
    nodes,
    hash: crypto.createHash('sha256').update(canonical).digest('hex'),
  };
}

function validateInputNode(node: GoalPlanNodeInput, index: number): void {
  if (!node || typeof node !== 'object') invalid(`Node ${index} must be an object`);
  if (typeof node.key !== 'string' || !KEY_PATTERN.test(node.key)) invalid(`Node ${index} has an invalid stable key`);
  if (!GOAL_NODE_KINDS.includes(node.kind)) invalid(`Node ${node.key} has an invalid kind`);
  boundedText(node.title, `nodes[${index}].title`, 1000);
  if (node.parentKey !== undefined && node.parentKey !== null && (typeof node.parentKey !== 'string' || !KEY_PATTERN.test(node.parentKey))) {
    invalid(`Node ${node.key} has an invalid parent key`);
  }
  if (!Number.isSafeInteger(node.estimate) || node.estimate < 0 || node.estimate > GOAL_PLAN_MAX_ESTIMATE) {
    invalid(`Node ${node.key} estimate must be between 0 and ${GOAL_PLAN_MAX_ESTIMATE}`);
  }
  if (!Array.isArray(node.acceptanceCriteria) || node.acceptanceCriteria.length < 1 || node.acceptanceCriteria.length > 50) {
    invalid(`Node ${node.key} must have between 1 and 50 acceptance criteria`);
  }
  node.acceptanceCriteria.forEach((criterion, criterionIndex) => boundedText(criterion, `${node.key}.acceptanceCriteria[${criterionIndex}]`, 1000));
  if (node.dependsOn !== undefined && (!Array.isArray(node.dependsOn) || node.dependsOn.some((key) => typeof key !== 'string'))) {
    invalid(`Node ${node.key} dependencies must be stable node keys`);
  }
}

function validateDependencyGraph(nodes: GoalPlanNodeInput[], byKey: Map<string, GoalPlanNodeInput>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (key: string): void => {
    if (visiting.has(key)) invalid('Plan dependency graph contains a cycle');
    if (visited.has(key)) return;
    visiting.add(key);
    const node = byKey.get(key)!;
    for (const dependencyKey of new Set(node.dependsOn ?? [])) {
      if (dependencyKey === key) invalid(`Node ${key} cannot depend on itself`);
      requireNode(byKey, dependencyKey, `dependency of ${key}`);
      walk(dependencyKey);
    }
    visiting.delete(key);
    visited.add(key);
  };
  nodes.forEach((node) => walk(node.key));
}

function legalParent(parent: GoalNodeKind, child: GoalNodeKind): boolean {
  if (child === 'root_epic') return false;
  if (child === 'sub_epic') return parent === 'root_epic' || parent === 'sub_epic';
  if (child === 'implementation_issue') return parent === 'root_epic' || parent === 'sub_epic';
  return parent === 'implementation_issue';
}

function requireNode(map: Map<string, GoalPlanNodeInput>, key: unknown, description: string): GoalPlanNodeInput {
  if (typeof key !== 'string') invalid(`Missing ${description}`);
  const node = map.get(key as string);
  if (!node) invalid(`Unknown ${description}: ${String(key)}`);
  return node;
}

function branch(value: unknown, field: string): string {
  const normalized = boundedText(value, field) as string;
  if (normalized.startsWith('/') || normalized.endsWith('/') || normalized.includes('..') || /[~^:?*\\\s]/.test(normalized)) {
    invalid(`${field} is not a valid Git branch name`);
  }
  return normalized;
}

function invalid(message: string): never {
  throw new GoalError(GOAL_ERROR_CODES.validation, message, 400);
}
