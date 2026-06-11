export class ParseStateError extends Error {
  constructor(value: string) {
    super(`expected on/off (or enable/disable, true/false, yes/no, 1/0), got '${value}'`);
    this.name = "ParseStateError";
  }
}

export function parseOnOffState(value: string): boolean {
  const v = value.toLowerCase();
  if (v === "on" || v === "enable" || v === "true" || v === "1" || v === "yes") return true;
  if (v === "off" || v === "disable" || v === "false" || v === "0" || v === "no") return false;
  throw new ParseStateError(value);
}
