export interface GoalCheckpointDeclaration {
  checkpointReady: true;
  message: string;
  include?: string[];
  exclude?: string[];
  summary?: string;
}

export interface RejectedGoalCheckpointDeclaration {
  checkpointReady: true;
  rejected: true;
  error: string;
  message?: string;
  include?: string[];
  exclude?: string[];
  summary?: string;
}

export type ParsedGoalCheckpointDeclaration = GoalCheckpointDeclaration | RejectedGoalCheckpointDeclaration;

export interface ParsedGoalCheckpointOutput {
  declaration: ParsedGoalCheckpointDeclaration;
  /** Agent narration with the declaration (and a declaration-only Markdown fence) removed. */
  remainder: string;
}

interface JsonObjectSource {
  value: unknown;
  start: number;
  end: number;
}

function jsonObjects(text: string): JsonObjectSource[] {
  const values: JsonObjectSource[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          values.push({ value: JSON.parse(text.slice(start, index + 1)), start, end: index + 1 });
        } catch { /* Ignore non-JSON prose. */ }
        start = -1;
      }
    }
  }
  return values;
}

function optionalPaths(value: unknown, field: 'include' | 'exclude'): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000
    || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Checkpoint ${field} must be a non-empty array of at most 1000 file paths when provided`);
  }
  const paths = [...new Set(value as string[])];
  const invalid = paths.find(file => file.trim() !== file || file.includes('\\') || file.includes('\0')
    || file.includes('\n') || file.includes('\r') || file.startsWith('/')
    || file.split('/').some(part => part === '' || part === '.' || part === '..' || part === '.git'));
  if (invalid) {
    throw new Error(`Checkpoint ${field} path must be a normalized repository-relative file: ${JSON.stringify(invalid)}`);
  }
  return paths;
}

function rejectedDeclaration(candidate: Record<string, unknown>, error: unknown): RejectedGoalCheckpointDeclaration {
  const stringPaths = (value: unknown): string[] | undefined => Array.isArray(value)
    && value.every(item => typeof item === 'string') ? value as string[] : undefined;
  return {
    checkpointReady: true,
    rejected: true,
    error: (error as Error).message,
    ...(typeof candidate.message === 'string' ? { message: candidate.message.trim() } : {}),
    ...(stringPaths(candidate.include) ? { include: stringPaths(candidate.include) } : {}),
    ...(stringPaths(candidate.exclude) ? { exclude: stringPaths(candidate.exclude) } : {}),
    ...(typeof candidate.summary === 'string' ? { summary: candidate.summary.trim() } : {}),
  };
}

function declarationRemainder(text: string, source: JsonObjectSource): string {
  let removalStart = source.start;
  let removalEnd = source.end;
  const prefix = text.slice(0, source.start);
  const suffix = text.slice(source.end);
  const opening = prefix.match(/(?:^|\n)[ \t]*(`{3,}|~{3,})[^\r\n]*\r?\n[ \t]*$/);
  const closing = suffix.match(/^[ \t]*\r?\n[ \t]*(`{3,}|~{3,})[ \t]*(?:\r?\n|$)/);
  if (opening && closing
    && opening[1][0] === closing[1][0]
    && closing[1].length >= opening[1].length) {
    removalStart = opening.index! + (opening[0].startsWith('\n') ? 1 : 0);
    removalEnd += closing[0].length;
  }
  const before = text.slice(0, removalStart);
  const after = text.slice(removalEnd);
  const beforeWithoutSpace = before.replace(/[ \t]+$/, '');
  const afterWithoutSpace = after.replace(/^[ \t]+/, '');
  const hadAdjacentSpace = beforeWithoutSpace !== before || afterWithoutSpace !== after;
  const joinsInlineText = hadAdjacentSpace
    && !/[\r\n]$/.test(beforeWithoutSpace)
    && !/^[\r\n]/.test(afterWithoutSpace);
  return `${beforeWithoutSpace}${joinsInlineText ? ' ' : ''}${afterWithoutSpace}`.trim();
}

/** Parse the last structured checkpoint declaration and retain any narration around it. */
export function parseGoalCheckpointOutput(text: string | undefined): ParsedGoalCheckpointOutput | null {
  if (!text) return null;
  const source = jsonObjects(text).reverse().find(item => {
    const value = item.value;
    return Boolean(value && typeof value === 'object'
      && !Array.isArray(value)
      && (value as Record<string, unknown>).checkpointReady === true);
  });
  if (!source) return null;
  const candidate = source.value as Record<string, unknown>;
  let declaration: ParsedGoalCheckpointDeclaration;
  try {
    if (typeof candidate.message !== 'string' || !candidate.message.trim() || candidate.message.length > 500) {
      throw new Error('Checkpoint message must be a non-empty string of at most 500 characters');
    }
    if (candidate.summary != null
      && (typeof candidate.summary !== 'string' || !candidate.summary.trim() || candidate.summary.length > 4_000)) {
      throw new Error('Checkpoint summary must be a non-empty string of at most 4000 characters when provided');
    }
    const include = optionalPaths(candidate.include, 'include');
    const exclude = optionalPaths(candidate.exclude, 'exclude');
    const overlap = include?.find(file => exclude?.includes(file));
    if (overlap) throw new Error(`Checkpoint file cannot be both included and excluded: ${overlap}`);
    declaration = {
      checkpointReady: true,
      message: candidate.message.trim(),
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
      ...(typeof candidate.summary === 'string' ? { summary: candidate.summary.trim() } : {}),
    };
  } catch (error) {
    declaration = rejectedDeclaration(candidate, error);
  }
  return { declaration, remainder: declarationRemainder(text, source) };
}

/** Parse the last structured checkpoint declaration in an agent's turn output. */
export function parseGoalCheckpointDeclaration(
  text: string | undefined,
): ParsedGoalCheckpointDeclaration | null {
  return parseGoalCheckpointOutput(text)?.declaration ?? null;
}
