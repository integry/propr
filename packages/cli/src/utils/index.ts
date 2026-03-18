/**
 * CLI Utilities Module
 *
 * Exports utility functions for common CLI operations.
 */

export {
  resolveProject,
  ProjectOptions,
  ProjectResolutionError,
} from "./resolveProject.js";

export {
  formatOutput,
  printOutput,
  readJsonInput,
  validateJsonFields,
  isPlainObject,
  FormatOutputOptions,
  JsonInputError,
} from "./io.js";
