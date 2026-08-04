export interface ParsedSplitCommand {
  /** Whitespace-normalized natural-language guidance after `/split`. */
  instruction: string;
  validationError?: 'instruction_too_long';
}

export const MAX_SPLIT_INSTRUCTION_LENGTH = 8_000;
const SPLIT_COMMAND_PATTERN = /^\/split(?=$|[\t\r\n ])[\t\r\n ]*([\s\S]*)$/;

/**
 * Normalize guidance for persistence and idempotency comparisons.
 *
 * Case is preserved because it may be meaningful in identifiers or paths;
 * leading/trailing whitespace is removed and internal whitespace is collapsed.
 */
export function normalizeSplitInstruction(instruction: string): string {
  return instruction.trim().replace(/\s+/g, ' ');
}

/**
 * Parse a `/split` issue-comment command.
 *
 * The command must be the first bytes in the comment. This deliberately rejects
 * leading prose/whitespace, mentions such as `/splitter`, and a later `/split`
 * token so an ordinary discussion comment cannot accidentally start an
 * operation.
 */
export function parseSplitCommand(body: string | null | undefined): ParsedSplitCommand | null {
  if (!body) return null;

  const match = SPLIT_COMMAND_PATTERN.exec(body);
  if (!match) return null;

  const instruction = normalizeSplitInstruction(match[1] ?? '');
  if (instruction.length > MAX_SPLIT_INSTRUCTION_LENGTH) {
    return { instruction: '', validationError: 'instruction_too_long' };
  }
  return { instruction };
}
