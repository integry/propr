/**
 * Whole-line selection for bounded repository file reads.
 */

import { RepositoryRetrievalError } from './repositoryRetrievalTypes.js';

export function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface LineRange {
  filePath: string;
  startLine: number;
  rangeEnd: number;
}

export interface LineLimits {
  maxLines: number;
  maxBytes: number;
  maxBytesLimit: number;
  encodedByteLimit?: number;
}

/** Selects whole lines from `startLine` until a limit or `rangeEnd` is reached. */
export function selectLines(lines: string[], { filePath, startLine, rangeEnd }: LineRange, limits: LineLimits) {
  const { maxLines, maxBytes, maxBytesLimit, encodedByteLimit } = limits;
  const selected: string[] = [];
  let returnedBytes = 0;
  let encodedBytes = 0;
  let truncated = false;

  for (let lineNo = startLine; lineNo <= rangeEnd; lineNo++) {
    if (selected.length >= maxLines) {
      truncated = true;
      break;
    }
    const line = lines[lineNo - 1];
    const lineBytes = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
    // JSON escapes the newline separator as two bytes.
    const lineEncodedBytes = encodedByteLimit === undefined ? 0
      : Buffer.byteLength(JSON.stringify(line), 'utf8') - 2 + (selected.length > 0 ? 2 : 0);
    const overBytes = returnedBytes + lineBytes > maxBytes;
    const overEncoded = encodedByteLimit !== undefined && encodedBytes + lineEncodedBytes > encodedByteLimit;
    if (overBytes || overEncoded) {
      if (selected.length === 0) {
        // Returning part of the line would leave no cursor for the rest of it.
        if (encodedByteLimit !== undefined && lineEncodedBytes > encodedByteLimit) {
          throw new RepositoryRetrievalError(
            `Line ${lineNo} of "${filePath}" is ${lineEncodedBytes} bytes once JSON-encoded, more than the ${encodedByteLimit}-byte response limit, so it cannot be read at any maxBytes`,
            413,
          );
        }
        const hint = lineBytes <= maxBytesLimit
          ? `; request it with maxBytes of at least ${lineBytes}`
          : `, which exceeds the ${maxBytesLimit}-byte read limit`;
        throw new RepositoryRetrievalError(
          `Line ${lineNo} of "${filePath}" is ${lineBytes} bytes and does not fit in maxBytes (${maxBytes})${hint}`,
          413,
        );
      }
      truncated = true;
      break;
    }
    selected.push(line);
    returnedBytes += lineBytes;
    encodedBytes += lineEncodedBytes;
  }

  return { selected, returnedBytes, truncated };
}
