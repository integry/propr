// Eight standard passes cover every supported output spelling. The terminal
// classifiers retain the accepted arbitrary-depth decomposed-octet behavior
// without making the emitted decoder attacker-controlled.
export const MAX_PERCENT_DECODE_PASSES = 8;
const MAX_DISTRIBUTED_ASCII_DECODE_PASSES = 3;

export interface MappedCharacter {
  character: string;
  rawEnd: number;
  rawStart: number;
}

export interface DecodedPublicStringView {
  characters: MappedCharacter[];
  residualPercentEncoding: boolean;
  value: string;
}

export interface SensitiveRawSpan {
  end: number;
  start: number;
}

interface ClassifiedCharacter {
  character: string;
  end: number;
}

interface ClassifiedPublicStringView {
  changed: boolean;
  characters: MappedCharacter[];
}

function isHexCharacter(character: string | undefined): boolean {
  return character !== undefined && /^[0-9a-f]$/iu.test(character);
}

function readEventuallyEncodedHexCharacter(
  value: string,
  index: number
): ClassifiedCharacter | undefined {
  if (isHexCharacter(value[index])) return { character: value[index]!, end: index + 1 };
  if (value[index] !== '%') return undefined;
  let octetIndex = index + 1;
  while (value.slice(octetIndex, octetIndex + 2).toLowerCase() === '25') octetIndex += 2;
  const octet = value.slice(octetIndex, octetIndex + 2);
  if (!/^[0-9a-f]{2}$/iu.test(octet)) return undefined;
  const character = String.fromCharCode(Number.parseInt(octet, 16));
  return isHexCharacter(character) ? { character, end: octetIndex + 2 } : undefined;
}

/**
 * Read one eventual octet through contiguous or decomposed percent nesting.
 * Each input character is inspected only within its component, so arbitrary
 * residual depth remains linear without adding attacker-controlled passes.
 */
export function readClassifiedCharacter(
  value: string,
  index: number
): ClassifiedCharacter | undefined {
  if (value[index] !== '%') return value[index] === undefined
    ? undefined
    : { character: value[index]!, end: index + 1 };
  let highIndex = index + 1;
  while (value.slice(highIndex, highIndex + 2).toLowerCase() === '25') highIndex += 2;
  const high = readEventuallyEncodedHexCharacter(value, highIndex);
  if (high === undefined) return undefined;
  const low = readEventuallyEncodedHexCharacter(value, high.end);
  if (low === undefined) return undefined;
  return {
    character: String.fromCharCode(Number.parseInt(`${high.character}${low.character}`, 16)),
    end: low.end,
  };
}

function classifyPublicStringView(
  characters: MappedCharacter[]
): ClassifiedPublicStringView {
  const value = characters.map(({ character }) => character).join('');
  const classified: MappedCharacter[] = [];
  let changed = false;
  for (let index = 0; index < characters.length;) {
    const character = readClassifiedCharacter(value, index);
    if (character !== undefined && character.end > index + 1) {
      classified.push({
        character: character.character,
        rawEnd: characters[character.end - 1]!.rawEnd,
        rawStart: characters[index]!.rawStart,
      });
      index = character.end;
      changed = true;
    } else {
      classified.push(characters[index]!);
      index += 1;
    }
  }
  return { changed, characters: classified };
}

/** Build one bounded decoded inspection view while retaining exact raw spans. */
export function decodePublicStringView(value: string): DecodedPublicStringView {
  let rawIndex = 0;
  let characters: MappedCharacter[] = [];
  for (const character of value) {
    characters.push({
      character,
      rawEnd: rawIndex + character.length,
      rawStart: rawIndex,
    });
    rawIndex += character.length;
  }
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    const decoded: MappedCharacter[] = [];
    let changed = false;
    for (let index = 0; index < characters.length; index += 1) {
      const current = characters[index]!;
      const high = characters[index + 1];
      const low = characters[index + 2];
      if (current.character === '%' && isHexCharacter(high?.character)
        && isHexCharacter(low?.character)) {
        decoded.push({
          character: String.fromCharCode(Number.parseInt(
            `${high!.character}${low!.character}`,
            16
          )),
          rawEnd: low!.rawEnd,
          rawStart: current.rawStart,
        });
        index += 2;
        changed = true;
      } else {
        decoded.push(current);
      }
    }
    characters = decoded;
    if (!changed) break;
  }

  // A recursively encode-all-ASCII spelling distributes each next percent
  // octet across the output of the preceding classification. Close that
  // supported grammar with a fixed number of mapped passes. One additional
  // non-emitting probe detects candidates that would otherwise disappear at
  // this terminal budget, allowing the caller to fail closed. Both bounds are
  // constants, so classification remains O(D * N) time and O(N) memory.
  for (let pass = 0; pass < MAX_DISTRIBUTED_ASCII_DECODE_PASSES; pass += 1) {
    const classified = classifyPublicStringView(characters);
    characters = classified.characters;
    if (!classified.changed) break;
  }
  const residualPercentEncoding = classifyPublicStringView(characters).changed;
  return {
    characters,
    residualPercentEncoding,
    value: characters.map(({ character }) => character).join(''),
  };
}

export function rawSpanForDecodedRange(
  decoded: DecodedPublicStringView,
  originalLength: number,
  startIndex: number,
  endIndex: number
): SensitiveRawSpan {
  return {
    end: endIndex === decoded.characters.length
      ? originalLength
      : decoded.characters[endIndex]!.rawStart,
    start: decoded.characters[startIndex]!.rawStart,
  };
}
