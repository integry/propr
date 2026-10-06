export const SUMMARY_TREE_ROUTE_PATH = '/api/summaries/:owner/:repo/tree/*path';
export const SUMMARY_PATH_ROUTE_PATH = '/api/summaries/:owner/:repo/summary/*path';

export function trimPathSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) start++;
  while (end > start && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(start, end);
}
