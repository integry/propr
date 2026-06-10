export class ParseStateError extends Error {
  constructor(value: string) {
    super(`expected on/off (or enable/disable, true/false), got '${value}'`);
    this.name = "ParseStateError";
  }
}

export function parseOnOffState(value: string): boolean {
  const v = value.toLowerCase();
  if (v === "on" || v === "enable" || v === "true") return true;
  if (v === "off" || v === "disable" || v === "false") return false;
  throw new ParseStateError(value);
}
