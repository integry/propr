export function parseOnOffState(value: string): boolean {
  const v = value.toLowerCase();
  if (v === "on" || v === "enable" || v === "true") return true;
  if (v === "off" || v === "disable" || v === "false") return false;
  throw new Error(`expected 'on' or 'off', got '${value}'`);
}
