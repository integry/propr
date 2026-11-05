import { render, screen } from '@testing-library/react';
import { Zap } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { AgentConfirmDialog } from './Agents/AgentConfirmDialog';
import { CreationDialog } from './CreationDialog';

/** Inert itself or inside an inert region (jsdom keeps `inert` as a property only). */
const isInert = (element: Element | null): boolean => Boolean(element && ((element as HTMLElement).inert || isInert(element.parentElement)));

const shells = {
  creation: () => <CreationDialog title="New task" icon={Zap} description="Describe your task" closeLabel="Close task creation" onClose={vi.fn()}><textarea aria-label="Prompt" /></CreationDialog>,
  confirmation: () => <AgentConfirmDialog title="Cancel this run?" confirmLabel="Cancel run" cancelLabel="Keep run" onConfirm={vi.fn()} onCancel={vi.fn()}><p>Synthetic run</p></AgentConfirmDialog>,
};

describe.each(Object.entries(shells))('%s dialog shell', (_name, Dialog) => {
  it('makes the workspace inert, leaves desktop window chrome live and restores both on close', () => {
    const { rerender } = render(<div>
      <div data-window-chrome><button type="button">Close window</button></div>
      <main><button type="button">Opener</button></main>
    </div>);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    rerender(<div>
      <div data-window-chrome><button type="button">Close window</button></div>
      <main><button type="button">Opener</button></main>
      <Dialog />
    </div>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('.app-modal-layer')).not.toBeNull();
    expect(isInert(opener)).toBe(true);
    expect(isInert(screen.getByText('Close window'))).toBe(false);
    expect(isInert(dialog)).toBe(false);
    rerender(<div>
      <div data-window-chrome><button type="button">Close window</button></div>
      <main><button type="button">Opener</button></main>
    </div>);
    for (const element of Array.from(document.querySelectorAll('*'))) expect(isInert(element)).toBe(false);
    expect(opener).toHaveFocus();
  });
});
