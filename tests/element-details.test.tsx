import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElementInspectorPopover } from '../src/canvas/ElementInspectorPopover';
import { createDocument, createNode } from '../src/document/factory';
import { C4_TEXT_TYPES, type DraftNodeType } from '../src/document/types';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { stubContext } from './commandStubs';

const internal = vi.hoisted(() => ({
  width: 200,
  height: 100,
  internals: { positionAbsolute: { x: 300, y: 300 } },
}));

// jsdom has no canvas layout; keep placement fixed while exercising the real toolbar and store.
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useStore: (select: (state: { nodeLookup: Map<string, typeof internal> }) => unknown) =>
    select({ nodeLookup: new Map([['element', internal]]) }),
  useInternalNode: () => internal,
  useReactFlow: () => ({
    getInternalNode: () => internal,
    flowToScreenPosition: (point: { x: number; y: number }) => point,
  }),
}));
vi.mock('../src/canvas/useOverlayPosition', () => ({
  useOverlayPosition: () => ({ target: document.body, placement: 'above' }),
}));

beforeEach(() => {
  useEditorStore.getState().setDocument(createDocument('Details'), { resetHistory: true });
  useUiStore.setState({ depthTransition: null, editingTextId: null, interactionActive: false });
});

function mount(technology = '', type: DraftNodeType = 'service') {
  const node = { ...createNode({ id: 'element', type, x: 300, y: 300, text: 'Orders' }), technology };
  useEditorStore.getState().setDocument({ ...createDocument('Details'), nodes: [node] }, { resetHistory: true });
  useEditorStore.setState({ selection: { nodes: [node.id], edges: [] }, mode: 'edit' });
  render(<ElementInspectorPopover buildCommandContext={stubContext} />);
}

describe('element details shortcut', () => {
  it('shows the technology chip and opens details focused on Technology', () => {
    mount('Spring Boot 3');
    const chip = screen.getByRole('button', { name: 'Technology: Spring Boot 3, edit' });
    expect(chip).toHaveTextContent('Spring Boot 3');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Technology' })).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByRole('combobox', { name: 'Technology' })).toHaveFocus();
    expect(chip).toHaveAttribute('aria-expanded', 'true');
  });

  it.each(C4_TEXT_TYPES)('offers + Technology on an empty %s', (type) => {
    mount('', type);
    const chip = screen.getByRole('button', { name: 'Add technology' });
    expect(chip).toHaveTextContent('+ Technology');
    fireEvent.click(chip);
    expect(screen.getByRole('combobox', { name: 'Technology' })).toHaveFocus();
  });

  it('does not offer the chip on a non-C4 shape', () => {
    mount('', 'note');
    expect(screen.queryByRole('button', { name: 'Add technology' })).toBeNull();
  });

  it('commits custom technology with Enter, moves to Description, and keeps the value after Escape', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add technology' }));
    const field = screen.getByRole('combobox', { name: 'Technology' });
    fireEvent.change(field, { target: { value: 'Internal runtime' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    const description = screen.getByRole('textbox', { name: 'Description' });
    expect(description).toHaveFocus();
    expect(useEditorStore.getState().document.nodes[0]!.technology).toBe('Internal runtime');
    fireEvent.keyDown(description, { key: 'Escape' });
    expect(screen.queryByRole('combobox', { name: 'Technology' })).toBeNull();
    const chip = screen.getByRole('button', { name: 'Technology: Internal runtime, edit' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    expect(screen.getByRole('combobox', { name: 'Technology' })).toHaveValue('Internal runtime');
  });

  it('keeps arrows and Enter for suggestions before a second Enter moves to Description', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add technology' }));
    const field = screen.getByRole('combobox', { name: 'Technology' });
    fireEvent.change(field, { target: { value: 'sql' } });
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    const selected = options[1]!.textContent;
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field).toHaveValue(selected);
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('aria-expanded', 'false');
    expect(useEditorStore.getState().document.nodes[0]!.technology).toBe(selected);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveFocus();
    expect(useEditorStore.getState().history.past).toHaveLength(1);
  });

  it('dismisses suggestions with Escape before closing the panel without losing a committed value', () => {
    mount('Spring Boot 3');
    fireEvent.click(screen.getByRole('button', { name: 'Technology: Spring Boot 3, edit' }));
    const field = screen.getByRole('combobox', { name: 'Technology' });
    expect(field).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('combobox', { name: 'Technology' })).toBeNull();
    expect(useEditorStore.getState().document.nodes[0]!.technology).toBe('Spring Boot 3');
  });

  it('shows an undo without committing the old draft again on blur', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add technology' }));
    const field = screen.getByRole('combobox', { name: 'Technology' });
    fireEvent.change(field, { target: { value: 'Internal runtime' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    act(() => useEditorStore.getState().undo());
    expect(field).toHaveValue('');
    fireEvent.blur(field);
    expect(useEditorStore.getState().document.nodes[0]!.technology).toBe('');
    expect(useEditorStore.getState().history.past).toHaveLength(0);
  });

  it('still opens details from the More options menu', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const item = screen.getByRole('menuitem', { name: 'Edit details…' });
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    expect(screen.getByRole('combobox', { name: 'Technology' })).toHaveFocus();
  });
});
