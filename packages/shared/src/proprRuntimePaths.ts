/**
 * ProPR runtime output inside a worktree. Commits never stage these paths, so
 * anything that reasons about a commit's contents (staging, the commit type)
 * must skip them too. One definition, shared by core staging and the worker.
 */
export const VISUAL_PREVIEW_DIRECTORY = '.propr/previews';
export const VISUAL_PREVIEW_SOURCE_DIRECTORY = '.propr/preview-src';

export const GENERATED_PROPR_RUNTIME_PATHS: readonly string[] = [
    '.propr/assets',
    '.propr/cache',
    '.propr/.cache',
    '.propr/node_modules',
    VISUAL_PREVIEW_DIRECTORY,
    VISUAL_PREVIEW_SOURCE_DIRECTORY,
];

/** Generated ProPR runtime output that commits never stage, so it is never publishable work. */
export function isGeneratedRuntimePath(file: string): boolean {
    return GENERATED_PROPR_RUNTIME_PATHS.some(generated => file === generated || file.startsWith(`${generated}/`));
}
