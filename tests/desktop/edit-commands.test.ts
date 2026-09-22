import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchEditCommand } from '../../src/desktop/commands';

let heard: KeyboardEvent[];
const listen = (event: Event) => heard.push(event as KeyboardEvent);

beforeEach(() => {
  heard = [];
  window.addEventListener('keydown', listen);
  // jsdom has no `execCommand`.
  document.execCommand = vi.fn(() => true);
});

afterEach(() => {
  window.removeEventListener('keydown', listen);
  document.body.innerHTML = '';
});

describe('the native Edit menu', () => {
  it('sends Undo to the editor as the keys would', () => {
    dispatchEditCommand('undo');
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ key: 'z', ctrlKey: true, shiftKey: false });
  });

  it('sends Redo as Shift+Z, which the editor already takes for redo', () => {
    dispatchEditCommand('redo');
    expect(heard[0]).toMatchObject({ key: 'z', ctrlKey: true, shiftKey: true });
  });

  it('sends Select All the same way', () => {
    dispatchEditCommand('select-all');
    expect(heard[0]).toMatchObject({ key: 'a', ctrlKey: true });
  });

  it('leaves a text field to the browser’s own editing', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    dispatchEditCommand('undo');
    dispatchEditCommand('select-all');

    expect(heard).toEqual([]);
    expect(document.execCommand).toHaveBeenNthCalledWith(1, 'undo');
    expect(document.execCommand).toHaveBeenNthCalledWith(2, 'selectAll');
  });
});
