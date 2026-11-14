import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EXTENSION_LIBRARY_LIMITS, type ExtensionLibraryServer } from '@propr/shared';
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

  it('reports the first overlapping combination the way a scan of every combination does', () => {
    // Reference: evaluate every repository and agent combination directly.
    const OTHER = Symbol('other');
    const reference = (items: ExtensionLibraryServer[], limit: number) => {
      const enabled = items.filter(item => item.enabled);
      if (enabled.length <= limit) return null;
      const allows = (entries: string[], value: string | symbol, fold: boolean) => !entries.length
        || (typeof value === 'string' && entries.some(entry => (fold ? entry.toLowerCase() === value.toLowerCase() : entry === value)));
      const repositories = [...new Set([...choices.repositories, ...enabled.flatMap(item => item.repositories)]), OTHER];
      const agents = [...new Set([...choices.agents, ...enabled.flatMap(item => item.agents)]), OTHER];
      let best: { count: number; repository: string; agent: string } | null = null;
      for (const repository of repositories) for (const agent of agents) {
        const count = enabled.filter(item => allows(item.repositories, repository, true) && allows(item.agents, agent, false)).length;
        if (count > (best?.count ?? limit)) {
          best = { count, repository: repository === OTHER ? 'one repository' : repository as string, agent: agent === OTHER ? 'one agent' : agent as string };
        }
      }
      return best;
    };
    let seed = 7;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const pick = (pool: string[]) => Array.from({ length: random(4) }, () => pool[random(pool.length)]);
    const repositoryPool = ['example/docs', 'Example/Docs', 'example/app', 'example/api', 'other/lib'];
    const agentPool = ['claude-main', 'codex-main', 'claude-review', 'Claude-Main'];
    for (let round = 0; round < 200; round++) {
      const items = Array.from({ length: 6 + random(30) }, (_, i) => server(`s${i}`, {
        enabled: random(5) > 0, repositories: [...new Set(pick(repositoryPool))], agents: [...new Set(pick(agentPool))],
      }));
      expect(runLimitExcess(items, choices, 8)).toEqual(reference(items, 8));
    }
    // Repository limits fold case: both spellings count toward one repository.
    const folded = [...Array.from({ length: 5 }, (_, i) => server(`u${i}`, { repositories: ['Example/Docs'] })), ...Array.from({ length: 4 }, (_, i) => server(`l${i}`, { repositories: ['example/docs'] }))];
    expect(runLimitExcess(folded, choices, 8)).toMatchObject({ count: 9, repository: 'example/docs' });
    // Agent aliases match exactly.
    const agentsSplit = [...Array.from({ length: 5 }, (_, i) => server(`a${i}`, { agents: ['claude-main'] })), ...Array.from({ length: 4 }, (_, i) => server(`b${i}`, { agents: ['Claude-Main'] }))];
    expect(runLimitExcess(agentsSplit, choices, 8)).toBeNull();
  });

  it('stays fast for the largest library with disjoint repository and agent limits', () => {
    const { servers, repositories, agents } = EXTENSION_LIBRARY_LIMITS;
    const items = Array.from({ length: servers }, (_, i) => server(`s${i}`, {
      repositories: Array.from({ length: repositories }, (_, r) => `org${i}/repo${r}`),
      agents: Array.from({ length: agents }, (_, a) => `agent-${i}-${a}`),
    }));
    const started = performance.now();
    expect(runLimitExcess(items, choices, 8)).toBeNull();
    // Every limit overlapping: all items apply to one listed combination.
    const shared = items.map(item => ({ ...item, repositories: [...item.repositories.slice(1), 'shared/repo'], agents: [...item.agents.slice(1), 'shared-agent'] }));
    expect(runLimitExcess(shared, choices, 8)).toEqual({ count: servers, repository: 'shared/repo', agent: 'shared-agent' });
    expect(performance.now() - started).toBeLessThan(500);
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
