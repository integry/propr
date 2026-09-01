import { isProxy } from 'node:util/types';

export const CANONICAL_JSON_MAX_DEPTH = 64;
export const CANONICAL_JSON_MAX_NODES = 4_096;
export const CANONICAL_JSON_MAX_BYTES = 65_536;

/** Raised when a value or stored token stream is outside the lossless JSON domain. */
export class StrictJsonBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictJsonBoundaryError';
  }
}

export function canonicalizeRuntimeJson(value: unknown): string {
  try {
    const budget = new CanonicalJsonBudget();
    const node = inspectRuntimeValue(value, new WeakSet<object>(), budget, 0);
    return renderCanonicalJson(node);
  } catch (error) {
    if (error instanceof StrictJsonBoundaryError) throw error;
    throw new StrictJsonBoundaryError('Event payload could not be inspected safely');
  }
}

export function canonicalizeStoredJson(source: string): string {
  try {
    if (utf8ExceedsLimit(source, CANONICAL_JSON_MAX_BYTES)) {
      unsupported('Stored event payload exceeds the canonical JSON byte limit');
    }
    return renderCanonicalJson(new StoredJsonParser(source).parse());
  } catch (error) {
    if (error instanceof StrictJsonBoundaryError) throw error;
    throw new StrictJsonBoundaryError('Stored event payload is not valid lossless JSON');
  }
}

type CanonicalJsonNode =
  | { kind: 'scalar'; text: string }
  | { kind: 'array'; items: CanonicalJsonNode[] }
  | { kind: 'object'; entries: CanonicalJsonEntry[] };

interface CanonicalJsonEntry { key: string; encodedKey: string; value: CanonicalJsonNode }

class CanonicalJsonBudget {
  private nodes = 0;
  private bytes = 0;

  takeNode(): void {
    this.nodes += 1;
    if (this.nodes > CANONICAL_JSON_MAX_NODES) {
      unsupported('Event payload exceeds the canonical JSON node limit');
    }
  }

  requireNodeCapacity(count: number): void {
    if (count > CANONICAL_JSON_MAX_NODES - this.nodes) {
      unsupported('Event payload exceeds the canonical JSON node limit');
    }
  }

  enterContainer(depth: number): void {
    if (depth > CANONICAL_JSON_MAX_DEPTH) {
      unsupported('Event payload exceeds the canonical JSON depth limit');
    }
  }

  takeBytes(count: number): void {
    if (count > CANONICAL_JSON_MAX_BYTES - this.bytes) {
      unsupported('Event payload exceeds the canonical JSON byte limit');
    }
    this.bytes += count;
  }
}

function inspectRuntimeValue(
  value: unknown,
  ancestors: WeakSet<object>,
  budget: CanonicalJsonBudget,
  containerDepth: number
): CanonicalJsonNode {
  budget.takeNode();
  if (value === null) return scalarNode('null', budget);
  if (typeof value === 'boolean') return scalarNode(value ? 'true' : 'false', budget);
  if (typeof value === 'string') return stringNode(value, budget);
  if (typeof value === 'number') return scalarNode(canonicalNumber(value), budget);
  if (typeof value !== 'object') unsupported('Event payload contains an unsupported value');
  if (isProxy(value)) unsupported('Event payload cannot contain proxy objects');
  if (ancestors.has(value)) unsupported('Event payload cannot contain cycles');

  const depth = containerDepth + 1;
  budget.enterContainer(depth);

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? inspectRuntimeArray(value, ancestors, budget, depth)
      : inspectRuntimeObject(value, ancestors, budget, depth);
  } finally {
    ancestors.delete(value);
  }
}

function inspectRuntimeArray(
  value: unknown[],
  ancestors: WeakSet<object>,
  budget: CanonicalJsonBudget,
  depth: number
): CanonicalJsonNode {
  budget.requireNodeCapacity(value.length);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string'
    || (key !== 'length' && !isArrayIndex(key, value.length)))) {
    unsupported('Event payload arrays cannot contain extra properties');
  }
  budget.takeBytes(2 + Math.max(0, value.length - 1));
  const items: CanonicalJsonNode[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) unsupported('Event payload arrays must be dense');
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      unsupported('Event payload arrays must contain ordinary values');
    }
    items.push(inspectRuntimeValue(descriptor.value, ancestors, budget, depth));
  }
  return { kind: 'array', items };
}

function inspectRuntimeObject(
  value: object,
  ancestors: WeakSet<object>,
  budget: CanonicalJsonBudget,
  depth: number
): CanonicalJsonNode {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    unsupported('Event payload objects must be plain objects');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string')) {
    unsupported('Event payload objects can only have string keys');
  }
  budget.requireNodeCapacity(ownKeys.length);
  budget.takeBytes(2 + Math.max(0, ownKeys.length - 1));
  const entries = (ownKeys as string[]).sort().map((key): CanonicalJsonEntry => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      unsupported('Event payload objects must contain ordinary enumerable values');
    }
    const encodedKey = encodeJsonString(key, budget);
    budget.takeBytes(1);
    return {
      key,
      encodedKey,
      value: inspectRuntimeValue(descriptor.value, ancestors, budget, depth),
    };
  });
  return { kind: 'object', entries };
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value) || Object.is(value, -0)
    || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    unsupported('Event payload contains a number that cannot be preserved exactly');
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) unsupported('Event payload contains an unsupported number');
  return serialized;
}

function unsupported(message: string): never { throw new StrictJsonBoundaryError(message); }

function scalarNode(text: string, budget: CanonicalJsonBudget): CanonicalJsonNode {
  budget.takeBytes(Buffer.byteLength(text, 'utf8'));
  return { kind: 'scalar', text };
}

function stringNode(value: string, budget: CanonicalJsonBudget): CanonicalJsonNode {
  return { kind: 'scalar', text: encodeJsonString(value, budget) };
}

function encodeJsonString(value: string, budget: CanonicalJsonBudget): string {
  budget.takeBytes(2);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      budget.takeBytes(2);
    } else if (code <= 0x1f) {
      budget.takeBytes(6);
    } else if (code >= 0xd800 && code <= 0xdbff
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      budget.takeBytes(4);
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      budget.takeBytes(6);
    } else if (code <= 0x7f) {
      budget.takeBytes(1);
    } else if (code <= 0x7ff) {
      budget.takeBytes(2);
    } else {
      budget.takeBytes(3);
    }
  }
  return JSON.stringify(value);
}

function utf8ExceedsLimit(value: string, limit: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 3;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > limit) return true;
  }
  return false;
}

function renderCanonicalJson(root: CanonicalJsonNode): string {
  const chunks: string[] = [];
  renderNode(root, chunks);
  return chunks.join('');
}

function renderNode(node: CanonicalJsonNode, chunks: string[]): void {
  if (node.kind === 'scalar') {
    chunks.push(node.text);
    return;
  }
  if (node.kind === 'array') {
    chunks.push('[');
    node.items.forEach((item, index) => {
      if (index > 0) chunks.push(',');
      renderNode(item, chunks);
    });
    chunks.push(']');
    return;
  }
  chunks.push('{');
  node.entries.forEach((entry, index) => {
    if (index > 0) chunks.push(',');
    chunks.push(entry.encodedKey, ':');
    renderNode(entry.value, chunks);
  });
  chunks.push('}');
}

class StoredJsonParser {
  private index = 0;
  private readonly budget = new CanonicalJsonBudget();

  constructor(private readonly source: string) {}

  parse(): CanonicalJsonNode {
    this.skipWhitespace();
    const result = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) this.invalid();
    return result;
  }

  private parseValue(containerDepth: number): CanonicalJsonNode {
    this.budget.takeNode();
    const character = this.source[this.index];
    if (character === '"') return stringNode(this.parseString(), this.budget);
    if (character === '[') {
      const depth = containerDepth + 1;
      this.budget.enterContainer(depth);
      return this.parseArray(depth);
    }
    if (character === '{') {
      const depth = containerDepth + 1;
      this.budget.enterContainer(depth);
      return this.parseObject(depth);
    }
    if (character === 't') return scalarNode(this.parseLiteral('true'), this.budget);
    if (character === 'f') return scalarNode(this.parseLiteral('false'), this.budget);
    if (character === 'n') return scalarNode(this.parseLiteral('null'), this.budget);
    if (character === '-' || isDigit(character)) return scalarNode(this.parseNumber(), this.budget);
    return this.invalid();
  }

  private parseArray(depth: number): CanonicalJsonNode {
    this.index += 1;
    this.budget.takeBytes(2);
    this.skipWhitespace();
    const items: CanonicalJsonNode[] = [];
    if (this.consume(']')) return { kind: 'array', items };
    while (true) {
      items.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.consume(']')) return { kind: 'array', items };
      if (!this.consume(',')) this.invalid();
      this.budget.takeBytes(1);
      this.skipWhitespace();
    }
  }

  private parseObject(depth: number): CanonicalJsonNode {
    this.index += 1;
    this.budget.takeBytes(2);
    this.skipWhitespace();
    const entries: CanonicalJsonEntry[] = [];
    const keys = new Set<string>();
    if (this.consume('}')) return { kind: 'object', entries };
    while (true) {
      if (this.source[this.index] !== '"') this.invalid();
      const key = this.parseString();
      if (keys.has(key)) unsupported('Stored event payload contains duplicate object keys');
      keys.add(key);
      const encodedKey = encodeJsonString(key, this.budget);
      this.skipWhitespace();
      if (!this.consume(':')) this.invalid();
      this.budget.takeBytes(1);
      this.skipWhitespace();
      entries.push({ key, encodedKey, value: this.parseValue(depth) });
      this.skipWhitespace();
      if (this.consume('}')) {
        entries.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
        return { kind: 'object', entries };
      }
      if (!this.consume(',')) this.invalid();
      this.budget.takeBytes(1);
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.source.slice(start, this.index)) as string;
      }
      if (character === '\\') {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.index + 1, this.index + 5))) this.invalid();
          this.index += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) this.invalid();
        this.index += 1;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) this.invalid();
      this.index += 1;
    }
    return this.invalid();
  }

  private parseNumber(): string {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (!match) return this.invalid();
    const token = match[0];
    this.index += token.length;
    const value = Number(token);
    const canonical = canonicalNumber(value);
    if (!sameDecimalValue(token, canonical)) {
      unsupported('Stored event payload contains a numeric token that loses identity');
    }
    return canonical;
  }

  private parseLiteral(literal: string): string {
    if (!this.source.startsWith(literal, this.index)) return this.invalid();
    this.index += literal.length;
    return literal;
  }

  private skipWhitespace(): void {
    while (' \n\r\t'.includes(this.source[this.index] ?? '\0')) this.index += 1;
  }

  private consume(character: string): boolean {
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private invalid(): never {
    throw new StrictJsonBoundaryError('Stored event payload is malformed JSON');
  }
}

interface NormalizedDecimal {
  sign: 1 | -1;
  digits: string;
  power: number;
}

function sameDecimalValue(left: string, right: string): boolean {
  const first = normalizeDecimal(left);
  const second = normalizeDecimal(right);
  return first.sign === second.sign && first.digits === second.digits && first.power === second.power;
}

function normalizeDecimal(token: string): NormalizedDecimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/.exec(token);
  if (!match) unsupported('Stored event payload contains an invalid numeric token');
  const sign = match[1] === '-' ? -1 : 1;
  let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '');
  if (digits === '') return { sign, digits: '0', power: 0 };
  const exponentDigits = (match[5] ?? '0').replace(/^0+/, '') || '0';
  if (exponentDigits.length > 6) {
    unsupported('Stored event payload contains an unsupported numeric exponent');
  }
  const exponentSign = match[4] === '-' ? -1 : 1;
  let power = exponentSign * Number(exponentDigits) - (match[3]?.length ?? 0);
  const trailingZeros = digits.length - digits.replace(/0+$/, '').length;
  if (trailingZeros > 0) {
    digits = digits.slice(0, -trailingZeros);
    power += trailingZeros;
  }
  return { sign, digits, power };
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}
