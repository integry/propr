import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ModelSelector, { type AgentModelOption } from './ModelSelector';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

const options: AgentModelOption[] = Array.from({ length: 12 }, (_, index) => ({
  agentId: `agent-${index}`,
  agentAlias: `Agent ${index}`,
  modelId: `model-${index}`,
  modelName: `Model ${index}`,
}));

describe('ModelSelector keyboard navigation', () => {
  afterEach(() => {
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('scrolls to and selects an active option beyond the initial viewport', () => {
    const scrolledOptionIds: string[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(function scrollIntoView(this: HTMLElement) {
        scrolledOptionIds.push(this.id);
      }),
    });
    const onSelectedModelsChange = vi.fn();

    render(
      <ModelSelector
        options={options}
        selectedModels={[]}
        onSelectedModelsChange={onSelectedModelsChange}
        onClear={vi.fn()}
      />,
    );

    const combobox = screen.getByRole('combobox', { name: 'Search and add models to compare' });
    fireEvent.focus(combobox);
    for (let index = 0; index < 8; index += 1) {
      fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    }

    const activeOption = screen.getByRole('option', { name: /Model 8/ });
    expect(combobox).toHaveAttribute('aria-activedescendant', activeOption.id);
    expect(scrolledOptionIds.at(-1)).toBe(activeOption.id);

    fireEvent.keyDown(combobox, { key: 'Enter' });
    expect(onSelectedModelsChange).toHaveBeenCalledWith([
      { agentId: 'agent-8', modelId: 'model-8' },
    ]);
  });

  it('keeps options out of the tab order and closes the popup on Tab', () => {
    render(
      <ModelSelector
        options={options}
        selectedModels={[]}
        onSelectedModelsChange={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    const combobox = screen.getByRole('combobox', { name: 'Search and add models to compare' });
    fireEvent.focus(combobox);

    expect(screen.getAllByRole('option')[0]).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(combobox, { key: 'Tab' });
    expect(screen.queryByRole('listbox', { name: 'Available models' })).not.toBeInTheDocument();
  });

  it('retains combobox focus for pointer selection so Escape still closes the popup', () => {
    const onSelectedModelsChange = vi.fn();
    render(
      <ModelSelector
        options={options}
        selectedModels={[]}
        onSelectedModelsChange={onSelectedModelsChange}
        onClear={vi.fn()}
      />,
    );

    const combobox = screen.getByRole('combobox', { name: 'Search and add models to compare' });
    fireEvent.focus(combobox);
    const option = screen.getByRole('option', { name: /Model 2/ });
    fireEvent.pointerDown(option);
    fireEvent.click(option);

    expect(combobox).toHaveFocus();
    expect(onSelectedModelsChange).toHaveBeenCalledWith([
      { agentId: 'agent-2', modelId: 'model-2' },
    ]);
    expect(screen.getByRole('listbox', { name: 'Available models' })).toBeInTheDocument();

    fireEvent.keyDown(combobox, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Available models' })).not.toBeInTheDocument();
  });

  it('closes the popup when focus leaves the selector', () => {
    render(
      <>
        <ModelSelector
          options={options}
          selectedModels={[]}
          onSelectedModelsChange={vi.fn()}
          onClear={vi.fn()}
        />
        <button type="button">Outside selector</button>
      </>,
    );

    const combobox = screen.getByRole('combobox', { name: 'Search and add models to compare' });
    fireEvent.focus(combobox);
    fireEvent.blur(combobox, {
      relatedTarget: screen.getByRole('button', { name: 'Outside selector' }),
    });

    expect(screen.queryByRole('listbox', { name: 'Available models' })).not.toBeInTheDocument();
  });
});
