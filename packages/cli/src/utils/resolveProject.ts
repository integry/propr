/**
 * Project Resolution Utility
 *
 * Provides a utility function to resolve the target project by checking
 * command options first, then falling back to the configured default project.
 */

import { parseProjectSlug } from "@propr/shared";
import type { Command } from "commander";
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
  const parts = parseProjectSlug(project);
  return parts ? `${parts.owner}/${parts.repo}` : null;
}

/**
 * Checks whether a project value is in owner/repo form without path traversal
 * or empty segments.
 */
export function isValidProjectSlug(project: string): boolean {
  return normalizeProjectSlug(project) !== null;
}

function normalizeResolvedProject(project: string): string {
  const normalized = normalizeProjectSlug(project);
  if (normalized === null) {
    throw new ProjectResolutionError(
      `Invalid project "${project}". Expected owner/repo format.`
    );
  }
  return normalized;
}

/**
 * Returns a normalized explicitly supplied project, without consulting config.
 * This is used by commands where project is an optional filter or assertion.
 */
export function resolveOptionalProject(
  options: ProjectOptions
): string | undefined {
  if (options.project === undefined) {
    return undefined;
  }
  return normalizeResolvedProject(options.project);
}

/**
 * Configures Commander so a project may be supplied either before the command
 * tree (global form) or on a leaf command (nested form).
 *
 * Commander otherwise lets the root option consume a same-named nested option.
 * Positional parsing preserves option ownership, and the pre-action hook applies
 * the documented precedence: nested option, then global option. The configured
 * default remains the final fallback in {@link resolveProject}.
 */
export function configureProjectOptionInheritance(program: Command): void {
  program.enablePositionalOptions();
  program.hook("preAction", (_hookCommand, actionCommand) => {
    if (actionCommand.getOptionValue("project") !== undefined) {
      return;
    }

    const globalProject = program.getOptionValue("project");
    if (globalProject !== undefined) {
      actionCommand.setOptionValueWithSource("project", globalProject, "cli");
    }
  });
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
  const explicitProject = resolveOptionalProject(options);
  if (explicitProject !== undefined) {
    return explicitProject;
  }

  // Fall back to the configured default project
  const defaultProject = configManager.getDefaultProject();

  if (defaultProject) {
    return normalizeResolvedProject(defaultProject);
  }

  // No project could be resolved - throw a helpful error
  throw new ProjectResolutionError(
    "No project specified. Use the -p/--project flag or set a default project with 'propr use <project>'."
  );
}
