/**
 * Project Resolution Utility
 *
 * Provides a utility function to resolve the target project by checking
 * command options first, then falling back to the configured default project.
 */

import { ConfigManager } from "../config/index.js";

/**
 * Options object that may contain a project specification.
 */
export interface ProjectOptions {
  /**
   * The project specified via the -p/--project flag.
   */
  project?: string;
}

/**
 * Error thrown when no project can be resolved.
 */
export class ProjectResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectResolutionError";
  }
}

/**
 * Normalizes a project value to a trimmed owner/repo slug.
 *
 * Returns the trimmed slug when the value is in owner/repo form without path
 * traversal or empty segments, or null when the value is invalid. Callers must
 * persist and send the returned slug (not the raw input) so surrounding
 * whitespace never reaches config files or API requests.
 */
export function normalizeProjectSlug(project: string): string | null {
  const trimmed = project.trim();
  const parts = trimmed.split("/");
  const valid = parts.length === 2 && parts.every((part) => (
    part !== "." &&
    part !== ".." &&
    /^[A-Za-z0-9_.-]+$/.test(part)
  ));
  return valid ? trimmed : null;
}

/**
 * Checks whether a project value is in owner/repo form without path traversal
 * or empty segments.
 */
export function isValidProjectSlug(project: string): boolean {
  return normalizeProjectSlug(project) !== null;
}

/**
 * Resolves the target project by checking command options first,
 * then falling back to the configured default project.
 *
 * @param options - The command options that may contain a project flag.
 * @param configManager - The ConfigManager instance to retrieve the default project.
 * @returns The resolved project name (owner/repo format).
 * @throws {ProjectResolutionError} If no project is specified and no default is configured.
 *
 * @example
 * ```typescript
 * const configManager = await createConfigManager();
 * const project = resolveProject({ project: "owner/repo" }, configManager);
 * ```
 *
 * @example
 * ```typescript
 * // Falls back to default project from config
 * const configManager = await createConfigManager();
 * const project = resolveProject({}, configManager);
 * ```
 */
export function resolveProject(
  options: ProjectOptions,
  configManager: ConfigManager
): string {
  // First, check if a project was provided via the command options
  if (options.project) {
    return options.project;
  }

  // Fall back to the configured default project
  const defaultProject = configManager.getDefaultProject();

  if (defaultProject) {
    return defaultProject;
  }

  // No project could be resolved - throw a helpful error
  throw new ProjectResolutionError(
    "No project specified. Use the -p/--project flag or set a default project with 'propr use <project>'."
  );
}
