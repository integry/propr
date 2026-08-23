export function trimPathSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) start++;
  while (end > start && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(start, end);
}
