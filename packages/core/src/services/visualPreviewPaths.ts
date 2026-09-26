export const VISUAL_PREVIEW_DIRECTORY = '.propr/previews';
export const VISUAL_PREVIEW_SOURCE_DIRECTORY = '.propr/preview-src';
export const VISUAL_PREVIEW_MANIFEST = `${VISUAL_PREVIEW_DIRECTORY}/manifest.json`;

/**
 * Worktree-local visual preview artifacts. These paths are runtime output and
 * must never be included in an implementation commit.
 */
export const VISUAL_PREVIEW_RUNTIME_DIRECTORIES = [
  VISUAL_PREVIEW_DIRECTORY,
  VISUAL_PREVIEW_SOURCE_DIRECTORY,
] as const;

function isDelimitedTokenStart(character: string): boolean {
  return ['<', '"', "'", '`'].includes(character);
}

function isDelimitedTokenEnd(delimiter: string, character: string): boolean {
  return delimiter === '<' ? character === '>' : character === delimiter;
}

function redactDelimitedTokens(text: string, containsRuntimePath: RegExp): string {
  const output: string[] = [];
  let tokenStart = -1;
  let delimiter = '';
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (tokenStart === -1) {
      if (isDelimitedTokenStart(character)) {
        tokenStart = index;
        delimiter = character;
      } else {
        output.push(character);
      }
      continue;
    }

    if (character === '\r' || character === '\n') {
      output.push(text.slice(tokenStart, index + 1));
      tokenStart = -1;
      delimiter = '';
      escaped = false;
      continue;
    }

    if (delimiter === '<' && character === '<') {
      output.push(text.slice(tokenStart, index));
      tokenStart = index;
      continue;
    }

    if (delimiter !== '<' && character === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (!isDelimitedTokenEnd(delimiter, character)) continue;

    const token = text.slice(tokenStart, index + 1);
    output.push(containsRuntimePath.test(token)
      ? `${delimiter}[local preview omitted]${character}`
      : token);
    tokenStart = -1;
    delimiter = '';
  }

  if (tokenStart !== -1) output.push(text.slice(tokenStart));
  return output.join('');
}

/** Remove runtime file references from public prose and persisted task output. */
export function redactVisualPreviewPaths(text: string): string {
  // Accept native, JSON-escaped, and URL-encoded separators. The staging root
  // deliberately has no .propr component after evidence leaves the worktree.
  const separator = String.raw`(?:[/\\]|%2f|%5c)`;
  const runtimeDirectory = String.raw`(?:\.propr${separator}+(?:previews|preview-src)|propr-previews)`;
  const runtime = String.raw`${runtimeDirectory}(?=${separator}|$|[\s\p{P}])`;
  const containsRuntimePath = new RegExp(runtime, 'iu');
  // Scan delimited tokens with a single forward pass. Quoted paths may contain
  // spaces and escaped delimiters without exposing the scanner to backtracking.
  return redactDelimitedTokens(text, containsRuntimePath)
    .replace(/[^\s<>"'`]+/g, value => containsRuntimePath.test(value) ? '[local preview omitted]' : value);
}

/** Apply path redaction to a public JSON projection without damaging JSON escapes. */
export function redactVisualPreviewValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined;

  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') return redactVisualPreviewPaths(item);
    if (Array.isArray(item)) return item.map(redact);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [
        redactVisualPreviewPaths(key),
        redact(nested),
      ]));
    }
    return item;
  };

  return redact(JSON.parse(serialized));
}
