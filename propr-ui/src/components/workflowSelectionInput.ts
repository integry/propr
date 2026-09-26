import type { RepoWorkflow } from '../api/proprTypes';

/** CSV-style quoting preserves commas and quotes inside exact workflow names. */
export function formatWorkflowInput(selection: string[]): string {
  return selection.map(value => /[,"\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"` : value).join(', ');
}

/** Invalid quoting must never silently authorize a different selection. */
export function parseWorkflowInput(value: string): string[] | null {
  const selection: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  const append = () => {
    const workflow = field.trim();
    if (workflow && !selection.some(entry => entry.toLowerCase() === workflow.toLowerCase())) selection.push(workflow);
    field = '';
    closed = false;
  };
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (value[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (char === ',' || char === '\n' || char === '\r') append();
    else if (closed) {
      if (!/\s/.test(char)) return null;
    } else if (char === '"') {
      if (field.trim()) return null;
      field = '';
      quoted = true;
    } else field += char;
  }
  if (quoted) return null;
  append();
  return selection;
}

/** The identities the worker matches a stored entry against: ID, path, file name and display name, case-insensitively. */
export function workflowMatchesEntry(workflow: RepoWorkflow, entry: string): boolean {
  const normalized = entry.trim().toLowerCase();
  return [String(workflow.id), workflow.path, workflow.file, workflow.name].some(identity => identity.toLowerCase() === normalized);
}

/** Selecting stores the file name; deselecting removes every entry that identifies the workflow, whichever spelling it used. */
export function toggleWorkflowSelection(selection: string[], workflow: RepoWorkflow, selected: boolean): string[] {
  const others = selection.filter(entry => !workflowMatchesEntry(workflow, entry));
  return selected ? [...others, workflow.file] : others;
}
