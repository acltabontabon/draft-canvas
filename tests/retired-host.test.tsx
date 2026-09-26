import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { isRetiredHostVisit } from '../src/lib/retiredHost';
import { RetiredHostNotice } from '../src/ui/RetiredHostNotice';

describe('the page an un-updated VS Code extension frames', () => {
  it('is recognised by the one URL parameter the extension ever set, framed or not', () => {
    window.history.replaceState(null, '', '/?host=vscode');
    expect(isRetiredHostVisit()).toBe(true);
    window.history.replaceState(null, '', '/?host=other');
    expect(isRetiredHostVisit()).toBe(false);
    window.history.replaceState(null, '', '/');
    expect(isRetiredHostVisit()).toBe(false);
  });

  it('says what happened and where the file opens, and opens no storage of its own', () => {
    const opened: string[] = [];
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: { open: (name: string) => void opened.push(name) },
    });
    try {
      render(<RetiredHostNotice />);
      expect(screen.getByRole('heading', { name: /has been retired/ })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Download the desktop app' })).toHaveAttribute('href', expect.stringContaining('releases/latest'));
      expect(screen.getByRole('link', { name: 'Open the web editor' })).toHaveAttribute('href', './');
      expect(screen.getByRole('link', { name: 'How to move a diagram' })).toHaveAttribute('href', expect.stringContaining('vscode-retired'));
      expect(opened).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: original });
    }
  });
});
