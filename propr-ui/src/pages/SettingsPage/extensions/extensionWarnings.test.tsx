import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ExtensionLibraryServer } from '@propr/shared';
import { itemNotes } from './extensionNotes';
import { CatalogServerDetails } from './ExtensionServerFields';
import { EMPTY_USAGE, appliesToCodex, extensionChoices, runLimitExcess } from './extensionUi';

const server = (name: string, patch: Partial<ExtensionLibraryServer> = {}) => ({
  kind: 'https', name, url: `https://${name}.example.com/mcp`, enabled: true, tools: [], capability: 'read', authentication: 'none',
  repositories: [], agents: [], autoApply: true, ...patch,
} as ExtensionLibraryServer);
const choices = extensionChoices({
  agents: [
    { alias: 'claude-main', kind: 'direct', type: 'claude', enabled: true, supportedModels: [] },
    { alias: 'codex-main', kind: 'direct', type: 'codex', enabled: true, supportedModels: [] },
  ],
  repositories: [{ name: 'example/docs', enabled: true }, { name: 'example/app', enabled: true }],
} as never);
const text = (notes: ReturnType<typeof itemNotes>) => { render(<ul>{notes.map((note, i) => <li key={i}>{note.text}</li>)}</ul>); return screen.getByRole('list').textContent ?? ''; };

describe('extension warnings', () => {
  it('reports when more than 8 enabled items can apply to one repository and agent', () => {
    const eight = Array.from({ length: 8 }, (_, i) => server(`s${i}`));
    expect(runLimitExcess(eight, choices, 8)).toBeNull();
    expect(runLimitExcess([...eight, server('off', { enabled: false })], choices, 8)).toBeNull();
    expect(runLimitExcess([...eight, server('docs-only', { repositories: ['example/docs'] })], choices, 8)).toMatchObject({ count: 9, repository: 'example/docs' });
    // Limits that never overlap stay within the per-run limit.
    const split = [...Array.from({ length: 5 }, (_, i) => server(`d${i}`, { repositories: ['example/docs'] })), ...Array.from({ length: 5 }, (_, i) => server(`a${i}`, { repositories: ['example/app'] }))];
    expect(runLimitExcess(split, choices, 8)).toBeNull();
  });

  it('flags items that reach a Codex agent', () => {
    expect(appliesToCodex(server('x'), choices.codexAgents)).toBe(true);
    expect(appliesToCodex(server('x', { agents: ['claude-main'] }), choices.codexAgents)).toBe(false);
    expect(appliesToCodex(server('x'), [])).toBe(false);
    expect(text(itemNotes(server('x'), { usage: EMPTY_USAGE, choices }))).toContain('--ignore-user-config');
  });

  it('notes migrated items, automations that add an item, and that they run without a disabled one', () => {
    const usage = { automations: [{ id: '1', name: 'Weekly', servers: ['x'], skills: [] }, { id: '2', name: 'Nightly', servers: ['x'], skills: [] }], importedFrom: { servers: { x: ['Docs'] }, skills: {} } };
    const notes = text(itemNotes(server('x', { enabled: false, autoApply: false, agents: ['claude-main'] }), { usage, choices }));
    expect(notes).toContain('Imported from profile “Docs”; not applied automatically.');
    expect(notes).toContain('Added by automations “Weekly”, “Nightly”, which currently run without it.');
  });

  it('reads no migration provenance for a server named like an inherited object property', () => {
    const notes = itemNotes(server('constructor', { autoApply: false, agents: ['claude-main'] }), { usage: EMPTY_USAGE, choices, secrets: {} });
    expect(text(notes)).not.toContain('Imported from');
  });

  it('notes migration provenance of a server named like an inherited object property', () => {
    const usage = { automations: [], importedFrom: JSON.parse('{"servers":{"constructor":["Docs"]},"skills":{}}') };
    expect(text(itemNotes(server('constructor', { autoApply: false, agents: ['claude-main'] }), { usage, choices }))).toContain('Imported from profile “Docs”; not applied automatically.');
  });

  it('falls back to the catalog secret status for a catalog server named like an inherited object property', () => {
    const catalogServer = { kind: 'catalog', name: 'constructor', catalogId: 'docs', digest: 'abc', enabled: true, tools: [], capability: 'read', repositories: [], agents: [], autoApply: true } as unknown as ExtensionLibraryServer;
    render(<CatalogServerDetails server={catalogServer} catalog={[{ id: 'docs', secrets: { configured: true } }] as never} secrets={{}} />);
    expect(screen.getByText('Operator secrets: configured')).toBeTruthy();
  });

  it('warns about a Bearer server without a stored token', () => {
    const notes = text(itemNotes(server('x', { authentication: 'bearer', agents: ['claude-main'] }), { usage: EMPTY_USAGE, choices, secrets: {} }));
    expect(notes).toContain('Bearer token not configured');
  });
});
