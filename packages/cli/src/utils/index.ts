/**
 * CLI Utilities Module
 *
 * Exports utility functions for common CLI operations.
 */

export {
  resolveProject,
  ProjectResolutionError,
} from "./resolveProject.js";
export type { ProjectOptions } from "./resolveProject.js";

export {
  formatOutput,
  printOutput,
  readJsonInput,
  validateJsonFields,
  isPlainObject,
  JsonInputError,
} from "./io.js";
export type { FormatOutputOptions } from "./io.js";

export { parseOnOffState, ParseStateError } from "./parseState.js";
export { confirm } from "./confirm.js";
