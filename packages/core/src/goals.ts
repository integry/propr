import type { VisualPreviewSettings } from './config/configManager.js';
import { buildVisualPreviewPrompt } from './services/visualPreviewService.js';

export type GoalDesiredState = 'running' | 'paused' | 'cancelled';
export type GoalResultState = 'completed' | 'failed' | 'cancelled';
export const GOAL_LAUNCH_STRATEGIES = ['direct', 'orchestrate'] as const;
export type GoalLaunchStrategy = typeof GOAL_LAUNCH_STRATEGIES[number];
/** A task is a one-off direct goal: implement, validate, publish, and stop. */
export const GOAL_KINDS = ['goal', 'task'] as const;
export type GoalKind = typeof GOAL_KINDS[number];

export const GOAL_CONTINUE_INPUT = 'ProPR has acknowledged any checkpoint request from the previous turn. Continue working toward the goal.';
export const NATIVE_GOAL_COMMAND_PREFIX = '/goal ';
export const CODEX_GOAL_OBJECTIVE_MAX_LENGTH = 4_000;
export const CODEX_GOAL_USER_OBJECTIVE_MAX_LENGTH = CODEX_GOAL_OBJECTIVE_MAX_LENGTH
    - Array.from(NATIVE_GOAL_COMMAND_PREFIX).length;
export const DEFAULT_GOAL_CHECKPOINT_INTERVAL_MINUTES = 15;
export const MIN_GOAL_CHECKPOINT_INTERVAL_MINUTES = 5;
export const MAX_GOAL_CHECKPOINT_INTERVAL_MINUTES = 120;

/** Claude Code rejects `/goal` conditions longer than this many UTF-16 units. */
export const CLAUDE_GOAL_CONDITION_MAX_LENGTH = 4_000;

/**
 * Providers whose goal runs keep a live control plane: the provider owns the
 * goal loop, and ProPR steers input, checkpoints, pause, and cancel into the
 * running session instead of stopping and resuming whole invocations.
 */
const NATIVE_GOAL_AGENT_TYPES: ReadonlySet<string> = new Set(['codex', 'claude']);

export function hasNativeGoalControl(agentType: string | null | undefined): boolean {
    return Boolean(agentType && NATIVE_GOAL_AGENT_TYPES.has(agentType));
}

/** Maximum user objective length the provider's native goal command accepts, or null when unbounded. */
export function nativeGoalObjectiveMaxLength(agentType: string | null | undefined): number | null {
    if (agentType === 'codex') return CODEX_GOAL_USER_OBJECTIVE_MAX_LENGTH;
    if (agentType === 'claude') return CLAUDE_GOAL_CONDITION_MAX_LENGTH;
    return null;
}

/** Codex measures goal objectives as Unicode code points, not UTF-16 units. */
export function codexGoalPromptValidationError(prompt: string): string | null {
    return Array.from(prompt).length > CODEX_GOAL_OBJECTIVE_MAX_LENGTH
        ? `Final Codex goal prompt must be at most ${CODEX_GOAL_OBJECTIVE_MAX_LENGTH} Unicode characters`
        : null;
}

/** Claude measures the `/goal` condition (the text after the command) in UTF-16 units. */
export function claudeGoalPromptValidationError(prompt: string): string | null {
    const condition = prompt.startsWith(NATIVE_GOAL_COMMAND_PREFIX)
        ? prompt.slice(NATIVE_GOAL_COMMAND_PREFIX.length)
        : prompt;
    return condition.trim().length > CLAUDE_GOAL_CONDITION_MAX_LENGTH
        ? `Claude goal objective must be at most ${CLAUDE_GOAL_CONDITION_MAX_LENGTH} characters`
        : null;
}

export function nativeGoalPromptValidationError(agentType: string, prompt: string): string | null {
    if (agentType === 'codex') return codexGoalPromptValidationError(prompt);
    if (agentType === 'claude') return claudeGoalPromptValidationError(prompt);
    return null;
}

const launchInstructions: Record<GoalLaunchStrategy, string> = {
    direct: [
        'Launch strategy — Agent implements directly:',
        'Implement the goal yourself in the prepared worktree. ProPR creates the draft PR before execution and owns all commits and pushes.',
        'Do not run Git commands, change branches, rewrite .git metadata, or create another implementation PR.',
    ].join('\n'),
    orchestrate: [
        'Launch strategy — Agent orchestrates through ProPR:',
        'Drive delivery by deciding the decomposition and hierarchy yourself, creating GitHub issues, and starting and monitoring their implementation through ProPR.',
        'For a large delivery, organize the work into an epic PR and, when useful, sub-epic and issue PRs. You—not a ProPR planner—own every planning and hierarchy decision.',
    ].join('\n'),
};

const taskStoppingRule = [
    'Scope policy — one-off task:',
    'This is a single task, not an open-ended goal. Implement the requested change, run the relevant checks, let ProPR publish the result, and then stop.',
    'Do not expand the assignment. If the request turns out to need substantially larger scope, do not start that extra work; deliver the requested change when it stands on its own, then report the larger scope and propose a plan or goal for it.',
].join('\n');

export interface NativeGoalPromptOptions {
    objective: string;
    kind?: GoalKind;
    launchStrategy: GoalLaunchStrategy;
    maxParallelTasks?: number | null;
    ultrafix?: boolean | null;
    checkpointIntervalMinutes?: number | null;
    visualPreviewSettings?: VisualPreviewSettings;
}

/** Build the bounded first user message that establishes the provider-native goal. */
export function buildNativeGoalCommand(options: Pick<NativeGoalPromptOptions, 'objective'>): string {
    return `${NATIVE_GOAL_COMMAND_PREFIX}${options.objective}`;
}

/** Build ProPR's launch policy for delivery as a separate same-session message. */
export function buildNativeGoalContext(options: NativeGoalPromptOptions): string {
    const parallelPolicy = options.maxParallelTasks == null
        ? 'Concurrency policy: No maximum parallel task count was selected. Decide and manage concurrency yourself; ProPR does not schedule a plan graph.'
        : `Concurrency policy: Run at most ${options.maxParallelTasks} implementation tasks in parallel. Decide what to parallelize and enforce this limit yourself; ProPR does not schedule a plan graph.`;
    const ultrafixPolicy = options.ultrafix
        ? 'Ultrafix policy: Enabled. Run Ultrafix as part of delivery before final completion.'
        : 'Ultrafix policy: Disabled. Do not run Ultrafix unless later steering input explicitly requests it.';
    const deliveryRequirements = options.launchStrategy === 'direct'
        ? [
            '- Finish with validated implementation files; ProPR publishes and validates the final checkpoint on its draft PR.',
            '- Report any GitHub artifact you intentionally create so ProPR can record it.',
        ]
        : [
            '- Finish with a draft PR containing the final implementation.',
            '- Track every GitHub issue and PR you create, validate that each artifact exists and is in the expected state, and report its URL so ProPR can record it.',
            '- Validate the final draft PR and its related artifacts before declaring the goal complete.',
        ];
    const checkpointPolicy = options.launchStrategy === 'direct'
        ? [
            `Checkpoint policy: Aim to produce a checkpoint approximately every ${options.checkpointIntervalMinutes ?? DEFAULT_GOAL_CHECKPOINT_INTERVAL_MINUTES} minutes, but only when a coherent set of changes is ready. This is a target cadence, not a timer or interruption.`,
            'When a checkpoint is ready, finish the turn with a JSON checkpoint request using this shape:',
            '{"checkpointReady":true,"message":"type(scope): meaningful description","include":["path/to/stable-file"],"exclude":["path/to/unfinished-file"],"summary":"What this checkpoint completes."}',
            'The message is required. Include and exclude are optional; use them to identify exact repository-relative files when parallel work is still in progress. Omit include to publish all current changes except excluded files.',
            'ProPR validates the paths, stages only that scope, commits, pushes, records the SHA, and then acknowledges the checkpoint. Unlisted parallel work remains untouched. Continue only after that acknowledgment.',
        ]
        : [];
    const context = [
        'Additional ProPR delivery context for the goal above:',
        '',
        launchInstructions[options.launchStrategy],
        ...(options.kind === 'task' ? [taskStoppingRule] : []),
        ...checkpointPolicy,
        parallelPolicy,
        ultrafixPolicy,
        'Delivery requirements:',
        ...deliveryRequirements,
    ].join('\n');
    const visualPreviewPrompt = options.visualPreviewSettings
        ? buildVisualPreviewPrompt(options.visualPreviewSettings)
        : '';
    if (!visualPreviewPrompt) return context;
    const timingPolicy = options.launchStrategy === 'direct'
        ? 'Goal preview timing: Use your discretion about when coherent visual evidence is ready. Generate or refresh it before a checkpoint whenever an in-progress preview would be useful; ProPR publishes current preview files to the already-open draft PR at checkpoint boundaries.'
        : 'Goal preview timing: Use your discretion about when coherent visual evidence is ready. ProPR publishes current preview files after the final goal PR is identified.';
    return `${context}${visualPreviewPrompt}\n${timingPolicy}`;
}

export interface GoalCheckpointDeclaration {
    checkpointReady: true;
    message: string;
    include?: string[];
    exclude?: string[];
    summary?: string;
}

export interface RejectedGoalCheckpointDeclaration {
    checkpointReady: true;
    rejected: true;
    error: string;
    message?: string;
    include?: string[];
    exclude?: string[];
    summary?: string;
}

function jsonObjects(text: string): unknown[] {
    const values: unknown[] = [];
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (start < 0) {
            if (character === '{') {
                start = index;
                depth = 1;
            }
            continue;
        }
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
            continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{') depth += 1;
        else if (character === '}') {
            depth -= 1;
            if (depth === 0) {
                try { values.push(JSON.parse(text.slice(start, index + 1))); } catch { /* ignore non-JSON prose */ }
                start = -1;
            }
        }
    }
    return values;
}

function optionalPaths(value: unknown, field: 'include' | 'exclude'): string[] | undefined {
    if (value == null) return undefined;
    if (!Array.isArray(value) || value.length === 0 || value.length > 1_000
        || value.some(item => typeof item !== 'string' || !item.trim())) {
        throw new Error(`Checkpoint ${field} must be a non-empty array of at most 1000 file paths when provided`);
    }
    const paths = [...new Set(value as string[])];
    const invalid = paths.find(file => file.trim() !== file || file.includes('\\') || file.includes('\0')
        || file.includes('\n') || file.includes('\r') || file.startsWith('/')
        || file.split('/').some(part => part === '' || part === '.' || part === '..' || part === '.git'));
    if (invalid) {
        throw new Error(`Checkpoint ${field} path must be a normalized repository-relative file: ${JSON.stringify(invalid)}`);
    }
    return paths;
}

function rejectedDeclaration(candidate: Record<string, unknown>, error: unknown): RejectedGoalCheckpointDeclaration {
    const stringPaths = (value: unknown): string[] | undefined => Array.isArray(value)
        && value.every(item => typeof item === 'string') ? value as string[] : undefined;
    return {
        checkpointReady: true,
        rejected: true,
        error: (error as Error).message,
        ...(typeof candidate.message === 'string' ? { message: candidate.message.trim() } : {}),
        ...(stringPaths(candidate.include) ? { include: stringPaths(candidate.include) } : {}),
        ...(stringPaths(candidate.exclude) ? { exclude: stringPaths(candidate.exclude) } : {}),
        ...(typeof candidate.summary === 'string' ? { summary: candidate.summary.trim() } : {}),
    };
}

/** Parse the last structured checkpoint declaration in an agent's turn output. */
export function parseGoalCheckpointDeclaration(
    text: string | undefined,
): GoalCheckpointDeclaration | RejectedGoalCheckpointDeclaration | null {
    if (!text) return null;
    const candidate = jsonObjects(text).reverse().find(value => {
        return Boolean(value && typeof value === 'object'
            && (value as Record<string, unknown>).checkpointReady === true);
    }) as Record<string, unknown> | undefined;
    if (!candidate) return null;
    try {
        if (typeof candidate.message !== 'string' || !candidate.message.trim() || candidate.message.length > 500) {
            throw new Error('Checkpoint message must be a non-empty string of at most 500 characters');
        }
        if (candidate.summary != null
            && (typeof candidate.summary !== 'string' || !candidate.summary.trim() || candidate.summary.length > 4_000)) {
            throw new Error('Checkpoint summary must be a non-empty string of at most 4000 characters when provided');
        }
        const include = optionalPaths(candidate.include, 'include');
        const exclude = optionalPaths(candidate.exclude, 'exclude');
        const overlap = include?.find(file => exclude?.includes(file));
        if (overlap) throw new Error(`Checkpoint file cannot be both included and excluded: ${overlap}`);
        return {
            checkpointReady: true,
            message: candidate.message.trim(),
            ...(include ? { include } : {}),
            ...(exclude ? { exclude } : {}),
            ...(typeof candidate.summary === 'string' ? { summary: candidate.summary.trim() } : {}),
        };
    } catch (error) {
        return rejectedDeclaration(candidate, error);
    }
}

export function goalJobId(goalId: string, generation: number): string {
    return `goal-${goalId}-${generation}`;
}

export function goalAttemptLabel(generation: number, claimId: string): string {
    return `${generation}:${claimId}`;
}

export function buildGoalPolicyEnvironment(launchStrategy?: GoalLaunchStrategy): Record<string, string> {
    return {
        PROPR_EXECUTION_MODE: 'goal',
        ...(launchStrategy ? { PROPR_GOAL_LAUNCH_STRATEGY: launchStrategy } : {}),
    };
}
