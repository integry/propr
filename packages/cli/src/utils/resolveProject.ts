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
