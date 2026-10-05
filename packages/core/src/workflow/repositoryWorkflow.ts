import { isScalar, parseDocument } from 'yaml';
import { buildWorkflowWrapper, WORKFLOW_MARKER_TEMPLATE } from './workflowExecution.js';
import { RepositoryWorkflowPolicyError } from './workflowPolicyError.js';
import type { VisualPreviewSettings, VisualPreviewType } from '../config/configManager.js';

export { RepositoryWorkflowPolicyError };

export const WORKFLOW_PATH = '.propr/workflow.yml';
export const WORKFLOW_MAX_BYTES = 128 * 1024;
export const WORKFLOW_TIMEOUT_MS = 600_000;
export type WorkflowHook = 'after_create' | 'before_run' | 'after_run' | 'before_remove';
export interface RepositoryWorkflow {
    hooks?: Partial<Record<WorkflowHook, string>> & { timeout_ms?: number };
    instructions?: string;
    validation?: string[];
    previews?: { types?: VisualPreviewType[]; instructions?: string };
    limits?: { max_parallel_tasks?: number };
}
export interface ResolvedRepositoryWorkflow {
    revision: string;
    baseBranch: string;
    fileRevision: string;
    config: RepositoryWorkflow;
    instructionText?: string;
    timeoutMs: number;
    maxParallelTasks: number;
}

function invalid(message: string): never {
    throw new RepositoryWorkflowPolicyError(`Invalid ${WORKFLOW_PATH}: ${message}`);
}
function object(value: unknown, keys: string[], field: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be a mapping`);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!keys.includes(key)) invalid(`unknown field ${field}.${key}`);
    return record;
}
function string(value: unknown, field: string): void {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) invalid(`${field} must be a nonempty string without NUL bytes`);
}
function positiveInteger(value: unknown, field: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${field} must be a positive integer`);
}

function validatePreviews(value: unknown): void {
    const previews = object(value, ['types', 'instructions'], 'previews');
    if (previews.instructions !== undefined) string(previews.instructions, 'previews.instructions');
    if (previews.types !== undefined && (!Array.isArray(previews.types) || previews.types.some(type => !['image', 'video'].includes(type)) || new Set(previews.types).size !== previews.types.length)) {
        invalid('previews.types must contain unique image/video values');
    }
}

function parseWorkflowDocument(source: string): unknown {
    try {
        const document = parseDocument(source, { uniqueKeys: true });
        if (document.errors.length || document.warnings.length) throw document.errors[0] || document.warnings[0];
        // An empty or comment-only document (e.g. a scaffold with every section
        // commented out) is the empty policy; an explicit `null` value is not.
        const { contents } = document;
        const empty = contents === null || (isScalar(contents) && contents.value === null && !contents.source);
        return empty ? {} : document.toJS({ maxAliasCount: 0 });
    } catch (error) { invalid((error as Error).message); }
}

export function parseRepositoryWorkflow(source: string): RepositoryWorkflow {
    if (Buffer.byteLength(source) > WORKFLOW_MAX_BYTES) invalid('file exceeds 128 KiB');
    const value = parseWorkflowDocument(source);
    const config = object(value, ['hooks', 'instructions', 'validation', 'previews', 'limits'], 'workflow');
    if (config.hooks !== undefined) {
        const hooks = object(config.hooks, ['after_create', 'before_run', 'after_run', 'before_remove', 'timeout_ms'], 'hooks');
        for (const [key, value] of Object.entries(hooks)) {
            if (key === 'timeout_ms') positiveInteger(value, 'hooks.timeout_ms');
            else string(value, `hooks.${key}`);
        }
    }
    if (config.instructions !== undefined) {
        string(config.instructions, 'instructions');
        const path = config.instructions as string;
        if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
            invalid('instructions must be a repository-relative file path without traversal');
        }
    }
    if (config.validation !== undefined) {
        if (!Array.isArray(config.validation) || config.validation.length > 100) invalid('validation must be an array of at most 100 commands');
        config.validation.forEach((command, index) => string(command, `validation[${index}]`));
    }
    if (config.previews !== undefined) validatePreviews(config.previews);
    if (config.limits !== undefined) {
        const limits = object(config.limits, ['max_parallel_tasks'], 'limits');
        if (limits.max_parallel_tasks !== undefined) positiveInteger(limits.max_parallel_tasks, 'limits.max_parallel_tasks');
    }
    return config as RepositoryWorkflow;
}

export interface WorkflowSource {
    resolveRevision(branch: string): Promise<string>;
    readFile(path: string, revision: string): Promise<{ content: string; sha: string } | null>;
}

/** Read both files from one immutable base commit; never from the editable task checkout. */
export async function loadRepositoryWorkflow(source: WorkflowSource, baseBranch: string, defaults: {
    maxParallelTasks: number;
    timeoutMs?: number;
}): Promise<ResolvedRepositoryWorkflow | undefined> {
    // Instance settings are not repository policy; never attribute them to the workflow file.
    for (const [value, field] of [[defaults.maxParallelTasks, 'worker_concurrency'], [defaults.timeoutMs ?? WORKFLOW_TIMEOUT_MS, 'hook timeout']] as const) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid instance setting: ${field} must be a positive integer`);
    }
    const revision = await source.resolveRevision(baseBranch);
    const file = await source.readFile(WORKFLOW_PATH, revision);
    if (!file) return undefined;
    const config = parseRepositoryWorkflow(file.content);
    const instructions = config.instructions ? await source.readFile(config.instructions, revision) : undefined;
    if (config.instructions && !instructions) invalid(`instructions file '${config.instructions}' does not exist on ${baseBranch}`);
    if (instructions && Buffer.byteLength(instructions.content) > WORKFLOW_MAX_BYTES) invalid('instructions file exceeds 128 KiB');
    const workflow = {
        revision, baseBranch, fileRevision: file.sha, config, instructionText: instructions?.content,
        timeoutMs: Math.min(config.hooks?.timeout_ms ?? WORKFLOW_TIMEOUT_MS, defaults.timeoutMs ?? WORKFLOW_TIMEOUT_MS),
        maxParallelTasks: config.limits?.max_parallel_tasks === undefined ? 0 : Math.min(config.limits.max_parallel_tasks, defaults.maxParallelTasks),
    };
    // Validate the actual quoted argv, including all hooks, validation and wrapper overhead.
    buildWorkflowWrapper(workflow, WORKFLOW_MARKER_TEMPLATE);
    return workflow;
}

export function refineWorkflowPreviews(settings: VisualPreviewSettings, workflow?: ResolvedRepositoryWorkflow): VisualPreviewSettings {
    if (!workflow?.config.previews) return settings;
    const previews = workflow.config.previews;
    const types = previews.types ? settings.types.filter(type => previews.types!.includes(type)) : settings.types;
    return { ...settings, enabled: settings.enabled && types.length > 0, types,
        instructions: [settings.instructions, previews.instructions].filter(Boolean).join('\n\n') || undefined };
}

export function repositoryWorkflowPrompt(workflow?: ResolvedRepositoryWorkflow): string {
    if (!workflow) return '';
    const commands = workflow.config.validation ?? [];
    return [
        `Repository workflow: ${WORKFLOW_PATH} on ${workflow.baseBranch} at ${workflow.revision}.`,
        workflow.instructionText,
        commands.length ? `Before finishing, run these repository validation commands and report each command's result (passed, failed, or unable to run, with reason) in your completion summary:\n${commands.map(command => `- ${command}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
}
