import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionLibraryServer } from '@propr/shared';
import { ExtensionServerForm } from './ExtensionServerForm';
import { ExtensionSkillForm } from './ExtensionSkillForm';

vi.mock('../../../api/extensionProfilesApi', () => ({
  discoverExtensionTools: vi.fn(), listGithubSkillRefs: vi.fn(), resolveGithubSkillRef: vi.fn(), importGithubSkill: vi.fn(), importArchiveSkill: vi.fn(),
  checkExtensionOAuth: vi.fn(), resolveExtensionPackage: vi.fn(),
}));

const choices = { agents: ['claude-main'], codexAgents: [], repositories: ['example/docs'], unavailable: false };
const docs: ExtensionLibraryServer = { kind: 'https', name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search'], capability: 'read', authentication: 'none', repositories: [], agents: [], autoApply: true };
const browser: ExtensionLibraryServer = {
  kind: 'package', name: 'browser', ecosystem: 'npm', package: '@example/browser-mcp', version: '1.4.2', integrity: `sha512-${'A'.repeat(86)}==`, enabled: true, tools: ['navigate'],
  capability: 'read', args: [], env: [], secretEnv: [], repositories: [], agents: [], autoApply: true,
};
const bundle = { id: '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e', instanceId: 'instance', name: 'Documentation review', digest: 'd'.repeat(64), files: 2, bytes: 2048, source: { kind: 'archive' as const, filename: 'review.tar' }, requirements: [], createdAt: 0, auditActor: '1' };

const serverEditor = (initial: ExtensionLibraryServer) => {
  const onCancel = vi.fn();
  render(<ExtensionServerForm initial={initial} servers={[initial]} catalog={[]} choices={choices} onSave={vi.fn()} onCancel={onCancel} />);
  return { form: screen.getByTestId('extension-server-form'), onCancel };
};
const skillEditor = () => {
  const onCancel = vi.fn();
  render(<ExtensionSkillForm initial={{ bundleId: bundle.id, enabled: true, repositories: [], agents: [], autoApply: false }} bundle={bundle} available={[]}
    choices={choices} onImported={() => {}} onSave={vi.fn()} onCancel={onCancel} />);
  return { form: screen.getByTestId('extension-skill-form'), onCancel };
};

/** Escape and then Cancel each ask first and keep the typed entry; only a confirmed discard closes the form. */
function expectGuarded(form: HTMLElement, field: HTMLElement, value: string, onCancel: ReturnType<typeof vi.fn>) {
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: 'Escape' });
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Keep editing' }));
  expect(onCancel).not.toHaveBeenCalled();
  expect(field).toHaveValue(value);
  fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Discard' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
}

describe('Typed entries not yet added count as typed content', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['Other tool', 'fetch_page'],
    ['Other repository (owner/name)', 'acme/website'],
    ['Other agent', 'reviewer'],
  ])('an unchanged server editor asks before discarding a pending %s', (label, value) => {
    const { form, onCancel } = serverEditor(docs);
    fireEvent.click(within(form).getByText('Advanced'));
    expectGuarded(form, within(form).getByLabelText(label), value, onCancel);
  });

  it('an unchanged package server editor asks before discarding a pending secret variable name', () => {
    const { form, onCancel } = serverEditor(browser);
    expectGuarded(form, within(form).getByLabelText('New secret variable name'), 'API_TOKEN', onCancel);
  });

  it.each([
    ['Other repository (owner/name)', 'acme/website'],
    ['Other agent', 'reviewer'],
  ])('an unchanged skill editor asks before discarding a pending %s', (label, value) => {
    const { form, onCancel } = skillEditor();
    fireEvent.click(within(form).getByText('Advanced'));
    expectGuarded(form, within(form).getByLabelText(label), value, onCancel);
  });

  it('closes at once again once the pending entry is cleared', () => {
    const { form, onCancel } = serverEditor(docs);
    const tool = within(form).getByLabelText('Other tool');
    fireEvent.change(tool, { target: { value: 'fetch_page' } });
    fireEvent.change(tool, { target: { value: '  ' } });
    fireEvent.keyDown(tool, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
