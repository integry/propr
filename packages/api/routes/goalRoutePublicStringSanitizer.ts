import { findSensitiveFileUriSpans } from './goalRouteFileUriSanitizer.js';
import {
  decodePublicStringView,
  type SensitiveRawSpan,
} from './goalRoutePublicStringDecoder.js';
import { findSensitiveRawPathSpans } from './goalRouteRawPathSanitizer.js';

const SENSITIVE_PATH_REDACTION = '[REDACTED_SENSITIVE_PATH]';

function mergeOrderedSpans(
  fileSpans: SensitiveRawSpan[],
  pathSpans: SensitiveRawSpan[]
): SensitiveRawSpan[] {
  const merged: SensitiveRawSpan[] = [];
  let fileIndex = 0;
  let pathIndex = 0;
  while (fileIndex < fileSpans.length || pathIndex < pathSpans.length) {
    const fileSpan = fileSpans[fileIndex];
    const pathSpan = pathSpans[pathIndex];
    const next = pathSpan === undefined
      || (fileSpan !== undefined && fileSpan.start <= pathSpan.start)
      ? fileSpans[fileIndex++]!
      : pathSpans[pathIndex++]!;
    const previous = merged.at(-1);
    if (previous !== undefined && next.start <= previous.end) {
      previous.end = Math.max(previous.end, next.end);
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

/**
 * Classify file URIs before generic URI exemptions and raw paths from one
 * bounded raw-span-mapped view, then redact only the corresponding raw spans.
 */
export function redactPublicPathTokens(value: string, inputTruncated: boolean): string {
  const decoded = decodePublicStringView(value);
  const spans = mergeOrderedSpans(
    findSensitiveFileUriSpans(decoded, value, inputTruncated),
    findSensitiveRawPathSpans(decoded, value, inputTruncated)
  );
  if (spans.length === 0) return value;

  let result = '';
  let copiedThrough = 0;
  for (const span of spans) {
    result += `${value.slice(copiedThrough, span.start)}${SENSITIVE_PATH_REDACTION}`;
    copiedThrough = span.end;
  }
  return `${result}${value.slice(copiedThrough)}`;
}
