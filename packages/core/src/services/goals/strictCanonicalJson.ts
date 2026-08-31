import { isProxy } from 'node:util/types';

/** Raised when a value or stored token stream is outside the lossless JSON domain. */
export class StrictJsonBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictJsonBoundaryError';
  }
}

export function canonicalizeRuntimeJson(value: unknown): string {
  try {
    return serializeRuntimeValue(value, new WeakSet<object>());
  } catch (error) {
    if (error instanceof StrictJsonBoundaryError) throw error;
    throw new StrictJsonBoundaryError('Event payload could not be inspected safely');
  }
}

export function canonicalizeStoredJson(source: string): string {
  try {
    return new StoredJsonParser(source).parse();
  } catch (error) {
    if (error instanceof StrictJsonBoundaryError) throw error;
    throw new StrictJsonBoundaryError('Stored event payload is not valid lossless JSON');
  }
}

function serializeRuntimeValue(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value !== 'object') unsupported('Event payload contains an unsupported value');
  if (isProxy(value)) unsupported('Event payload cannot contain proxy objects');
  if (ancestors.has(value)) unsupported('Event payload cannot contain cycles');

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, ancestors)
      : serializePlainObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value: unknown[], ancestors: WeakSet<object>): string {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string'
    || (key !== 'length' && !isArrayIndex(key, value.length)))) {
    unsupported('Event payload arrays cannot contain extra properties');
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) unsupported('Event payload arrays must be dense');
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      unsupported('Event payload arrays must contain ordinary values');
    }
    items.push(serializeRuntimeValue(descriptor.value, ancestors));
  }
  return `[${items.join(',')}]`;
}

function serializePlainObject(value: object, ancestors: WeakSet<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    unsupported('Event payload objects must be plain objects');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string')) {
    unsupported('Event payload objects can only have string keys');
  }
  const entries = (ownKeys as string[]).sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      unsupported('Event payload objects must contain ordinary enumerable values');
    }
    return `${JSON.stringify(key)}:${serializeRuntimeValue(descriptor.value, ancestors)}`;
  });
  return `{${entries.join(',')}}`;
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

function unsupported(message: string): never {
  throw new StrictJsonBoundaryError(message);
}

class StoredJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): string {
    this.skipWhitespace();
    const result = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) this.invalid();
    return result;
  }

  private parseValue(): string {
    const character = this.source[this.index];
    if (character === '"') return JSON.stringify(this.parseString());
    if (character === '[') return this.parseArray();
    if (character === '{') return this.parseObject();
    if (character === 't') return this.parseLiteral('true');
    if (character === 'f') return this.parseLiteral('false');
    if (character === 'n') return this.parseLiteral('null');
    if (character === '-' || isDigit(character)) return this.parseNumber();
    return this.invalid();
  }

  private parseArray(): string {
    this.index += 1;
    this.skipWhitespace();
    const items: string[] = [];
    if (this.consume(']')) return '[]';
    while (true) {
      items.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume(']')) return `[${items.join(',')}]`;
      if (!this.consume(',')) this.invalid();
      this.skipWhitespace();
    }
  }

  private parseObject(): string {
    this.index += 1;
    this.skipWhitespace();
    const entries: Array<[string, string]> = [];
    const keys = new Set<string>();
    if (this.consume('}')) return '{}';
    while (true) {
      if (this.source[this.index] !== '"') this.invalid();
      const key = this.parseString();
      if (keys.has(key)) unsupported('Stored event payload contains duplicate object keys');
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) this.invalid();
      this.skipWhitespace();
      entries.push([key, this.parseValue()]);
      this.skipWhitespace();
      if (this.consume('}')) {
        entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        return `{${entries.map(([name, value]) => `${JSON.stringify(name)}:${value}`).join(',')}}`;
      }
      if (!this.consume(',')) this.invalid();
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
