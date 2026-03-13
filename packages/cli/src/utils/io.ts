/**
 * I/O Utilities Module
 *
 * Provides utilities for JSON input/output operations to support
 * programmatic integrations in CI/CD pipelines and scripts.
 */

import { createReadStream, existsSync } from "fs";
import { readFile } from "fs/promises";
import { createInterface } from "readline";

/**
 * Options for formatting output.
 */
export interface FormatOutputOptions {
  /** Whether to output as JSON (bypasses table/human-readable formatting) */
  json?: boolean;
  /** Number of spaces for JSON indentation (default: 2) */
  indent?: number;
}

/**
 * Formats data for output based on the specified options.
 * When JSON mode is enabled, outputs raw JSON.stringify result.
 * Otherwise, returns null to indicate human-readable formatting should be used.
 *
 * @param data - The data to format.
 * @param options - Formatting options.
 * @returns The formatted JSON string if json mode is enabled, or null if human-readable formatting should be used.
 *
 * @example
 * ```typescript
 * const result = formatOutput(data, { json: options.json });
 * if (result !== null) {
 *   console.log(result);
 *   return;
 * }
 * // Continue with human-readable formatting...
 * ```
 */
export function formatOutput(
  data: unknown,
  options: FormatOutputOptions = {}
): string | null {
  const { json = false, indent = 2 } = options;

  if (!json) {
    return null;
  }

  return JSON.stringify(data, null, indent);
}

/**
 * Prints data to stdout, using JSON format if specified.
 * This is a convenience wrapper that handles the output directly.
 *
 * @param data - The data to output.
 * @param isJson - Whether to output as JSON.
 * @returns True if JSON was output (caller should return early), false otherwise.
 *
 * @example
 * ```typescript
 * if (printOutput(data, options.json)) {
 *   return;
 * }
 * // Continue with human-readable formatting...
 * ```
 */
export function printOutput(data: unknown, isJson: boolean): boolean {
  if (isJson) {
    console.log(JSON.stringify(data, null, 2));
    return true;
  }
  return false;
}

/**
 * Error thrown when JSON input operations fail.
 */
export class JsonInputError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "JsonInputError";
  }
}

/**
 * Reads and parses JSON from a file or stdin.
 *
 * @param filePath - Path to the JSON file, or "-" to read from stdin.
 * @returns A promise resolving to the parsed JSON data.
 * @throws {JsonInputError} If the file doesn't exist, can't be read, or contains invalid JSON.
 *
 * @example
 * ```typescript
 * // Read from file
 * const config = await readJsonInput("./config.json");
 *
 * // Read from stdin
 * const data = await readJsonInput("-");
 * ```
 */
export async function readJsonInput<T = unknown>(filePath: string): Promise<T> {
  try {
    let content: string;

    if (filePath === "-") {
      // Read from stdin
      content = await readFromStdin();
    } else {
      // Read from file
      if (!existsSync(filePath)) {
        throw new JsonInputError(`File not found: ${filePath}`);
      }
      content = await readFile(filePath, "utf-8");
    }

    // Trim whitespace
    content = content.trim();

    if (!content) {
      throw new JsonInputError("Empty input: no JSON data provided");
    }

    try {
      return JSON.parse(content) as T;
    } catch (parseError) {
      throw new JsonInputError(
        `Invalid JSON: ${(parseError as Error).message}`,
        parseError as Error
      );
    }
  } catch (error) {
    if (error instanceof JsonInputError) {
      throw error;
    }
    throw new JsonInputError(
      `Failed to read input: ${(error as Error).message}`,
      error as Error
    );
  }
}

/**
 * Reads all data from stdin until EOF.
 *
 * @returns A promise resolving to the stdin content as a string.
 */
async function readFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Check if stdin is a TTY (interactive terminal)
    if (process.stdin.isTTY) {
      reject(
        new JsonInputError(
          "No input provided. Use a file path or pipe JSON data to stdin."
        )
      );
      return;
    }

    const chunks: string[] = [];

    const rl = createInterface({
      input: process.stdin,
      terminal: false,
    });

    rl.on("line", (line) => {
      chunks.push(line);
    });

    rl.on("close", () => {
      resolve(chunks.join("\n"));
    });

    rl.on("error", (error) => {
      reject(new JsonInputError(`Failed to read stdin: ${error.message}`, error));
    });

    // Set a timeout for stdin reading (10 seconds)
    const timeout = setTimeout(() => {
      rl.close();
      reject(new JsonInputError("Timeout reading from stdin"));
    }, 10000);

    rl.on("close", () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * Validates that an object has the required fields.
 *
 * @param data - The object to validate.
 * @param requiredFields - Array of required field names.
 * @throws {JsonInputError} If any required field is missing.
 *
 * @example
 * ```typescript
 * const input = await readJsonInput("./agent.json");
 * validateJsonFields(input, ["alias", "type", "models"]);
 * ```
 */
export function validateJsonFields(
  data: unknown,
  requiredFields: string[]
): void {
  if (typeof data !== "object" || data === null) {
    throw new JsonInputError("Input must be a JSON object");
  }

  const obj = data as Record<string, unknown>;
  const missingFields = requiredFields.filter(
    (field) => !(field in obj) || obj[field] === undefined
  );

  if (missingFields.length > 0) {
    throw new JsonInputError(
      `Missing required fields: ${missingFields.join(", ")}`
    );
  }
}

/**
 * Type guard to check if a value is a plain object.
 *
 * @param value - The value to check.
 * @returns True if the value is a plain object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
