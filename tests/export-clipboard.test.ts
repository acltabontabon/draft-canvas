import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import type { DraftDocument } from '../src/document/types';

const downloadText = vi.fn(async () => {});
const downloadBlob = vi.fn(async () => {});
vi.mock('../src/export/download', () => ({ downloadText, downloadBlob }));

const { copySource, copySvg } = await import('../src/export/clipboard');

/**
 * Copy is the file export pointed at the clipboard. Where the browser has no clipboard to write —
 * no `clipboard.writeText`, no `execCommand` — the text is downloaded instead and the result says
 * which happened, so a toast never claims a copy that did not take place.
 */
function fixture(): DraftDocument {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
  return { ...createDocument('Copy me'), nodes: [a, b], edges: [createEdge({ source: a.id, target: b.id, label: 'Go' })] };
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExec = document.execCommand;

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

beforeEach(() => {
  downloadText.mockClear();
  downloadBlob.mockClear();
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  document.execCommand = originalExec;
});

describe('copySource', () => {
  it('writes the source text to the clipboard and reports it copied', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    setClipboard({ writeText });
    const result = await copySource(fixture(), 'mermaid-flowchart');
    expect(result).toEqual({ copied: true });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]![0]).toContain('flowchart LR');
    expect(downloadText).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when the async clipboard is refused', async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new Error('denied'); }) });
    document.execCommand = vi.fn(() => true);
    const result = await copySource(fixture(), 'structurizr');
    expect(result).toEqual({ copied: true });
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(downloadText).not.toHaveBeenCalled();
  });

  it('downloads the file when nothing can write the clipboard, and says so', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);
    const result = await copySource(fixture(), 'drawio');
    expect(result).toEqual({ copied: false, downloaded: true });
    expect(downloadText).toHaveBeenCalledOnce();
    const [text, fileName, mime] = downloadText.mock.calls[0]! as unknown as [string, string, string];
    expect(text).toContain('<mxfile');
    expect(fileName).toBe('copy-me.drawio');
    expect(mime).toBe('application/xml');
  });
});

describe('copySvg', () => {
  it('copies the rendered SVG text, with the document inside when asked', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    setClipboard({ writeText });
    const document = fixture();
    await copySvg(document, { editable: document });
    const svg = writeText.mock.calls[0]![0];
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<metadata id="draftcanvas">');
    await copySvg(document);
    expect(writeText.mock.calls[1]![0]).not.toContain('<metadata');
  });
});
