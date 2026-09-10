import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SvgSurface } from '../src/canvas/SvgSurface';
import { decodeClipboard, encodeClipboard } from '../src/document/clipboardCodec';
import { createDocument, createNode, defaultSizeFor, minSizeFor } from '../src/document/factory';
import { DEFAULTS } from '../src/document/limits';
import { normalizeNoteText } from '../src/document/noteText';
import { addNodes, extractFragment } from '../src/document/operations';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { NOTE_AUTO_MAX_HEIGHT, describeContext, describeNode, naturalNoteHeight, noteLayout } from '../src/nodes/describe';
import { renderNodeSvgChildren } from '../src/render/svg/document';
import { layoutText } from '../src/render/text/layout';
import { FONTS } from '../src/render/text/fonts';
import { LIGHT } from '../src/render/theme/tokens';
import { __resetClipboardSync, __resetInteraction, useEditorStore } from '../src/store/editorStore';

const ctx = describeContext(LIGHT);

function textShapes(node: ReturnType<typeof createNode>) {
  return describeNode(node, ctx).shapes.filter((shape): shape is Extract<typeof shape, { t: 'text' }> => shape.t === 'text');
}

function renderNode(node: ReturnType<typeof createNode>) {
  return render(
    <div data-testid="host">
      <SvgSurface width={node.width} height={node.height}>
        {renderNodeSvgChildren(node, 'light')}
      </SvgSurface>
    </div>,
  );
}

describe('Note — what a plain note draws', () => {
  it('a plain note shows only its body: no kind tag, no placeholder in the display list', () => {
    const node = createNode({ type: 'note', x: 0, y: 0, text: 'Owned by Payments' });
    const texts = textShapes(node);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.layout.lines.map((l) => l.text)).toEqual(['Owned by Payments']);

    const empty = createNode({ type: 'note', x: 0, y: 0, text: '' });
    expect(textShapes(empty)).toHaveLength(0);
    renderNode(empty);
    expect(screen.getByTestId('host').textContent).not.toContain('Add a note');
  });

  it('question, warning and decision keep their uppercase tag above the body', () => {
    for (const [kind, tag] of [
      ['question', 'QUESTION'],
      ['warning', 'WARNING'],
      ['decision', 'DECISION'],
    ] as const) {
      const node = createNode({ type: 'note', x: 0, y: 0, text: 'Body', noteKind: kind });
      const lines = textShapes(node).flatMap((shape) => shape.layout.lines.map((l) => l.text));
      expect(lines).toEqual([tag, 'Body']);
    }
  });

  it('draws the body exactly where noteLayout says the editor will sit', () => {
    for (const kind of ['note', 'question'] as const) {
      const node = createNode({ type: 'note', x: 0, y: 0, text: 'Body', noteKind: kind });
      const body = textShapes(node).at(-1)!;
      const geo = noteLayout(node);
      expect(body.x).toBe(geo.left);
      expect(body.y).toBe(geo.top);
      expect(body.layout.lineHeight).toBe(geo.lineHeight);
      expect(body.font).toEqual(geo.font);
      expect(geo.tagShown).toBe(kind !== 'note');
    }
  });

  it('renders each line of multiline text as its own line, blank lines included', () => {
    const node = createNode({
      type: 'note',
      x: 0,
      y: 0,
      width: 260,
      height: 200,
      text: 'Retry strategy\n\n- 3 attempts\n- exponential backoff',
    });
    const [body] = textShapes(node);
    expect(body!.layout.lines.map((l) => l.text)).toEqual([
      'Retry strategy',
      '',
      '- 3 attempts',
      '- exponential backoff',
    ]);
    expect(body!.layout.truncated).toBe(false);
  });
});

describe('Note — sizing', () => {
  it('starts compact: two lines tall by default, one line at minimum', () => {
    const geo = noteLayout({ noteKind: 'note' });
    expect(defaultSizeFor('note').height).toBe(DEFAULTS.noteHeight);
    expect(DEFAULTS.noteHeight).toBeGreaterThanOrEqual(Math.ceil(geo.top + 2 * geo.lineHeight + geo.bottom));
    expect(DEFAULTS.noteHeight).toBeLessThan(geo.top + 3 * geo.lineHeight + geo.bottom);
    expect(minSizeFor('note').height).toBeGreaterThanOrEqual(Math.ceil(geo.top + geo.lineHeight + geo.bottom));
  });

  it('naturalNoteHeight fits every line, floors at one line and caps at NOTE_AUTO_MAX_HEIGHT', () => {
    const node = { noteKind: 'note' as const, width: DEFAULTS.noteWidth };
    const geo = noteLayout(node);
    const oneLine = naturalNoteHeight(node, 'short', ctx);
    expect(oneLine).toBe(Math.ceil(geo.top + geo.lineHeight + geo.bottom));
    expect(naturalNoteHeight(node, '', ctx)).toBe(oneLine);

    const three = naturalNoteHeight(node, 'a\nb\nc', ctx);
    expect(three).toBe(Math.ceil(geo.top + 3 * geo.lineHeight + geo.bottom));

    const many = naturalNoteHeight(node, Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'), ctx);
    expect(many).toBe(NOTE_AUTO_MAX_HEIGHT);
  });

  it('a note sized by naturalNoteHeight shows every line it was sized for', () => {
    const text = Array.from({ length: 7 }, (_, i) => `line ${i}`).join('\n');
    const height = naturalNoteHeight({ noteKind: 'note', width: 200 }, text, ctx);
    const node = createNode({ type: 'note', x: 0, y: 0, width: 200, height, text });
    const [body] = textShapes(node);
    expect(body!.layout.lines).toHaveLength(7);
    expect(body!.layout.truncated).toBe(false);
  });

  it('a tagged kind needs more room than a plain note for the same text', () => {
    const plain = naturalNoteHeight({ noteKind: 'note', width: 200 }, 'x', ctx);
    const tagged = naturalNoteHeight({ noteKind: 'warning', width: 200 }, 'x', ctx);
    expect(tagged).toBeGreaterThan(plain);
  });

  it('a wider note wraps into fewer lines and therefore needs less height', () => {
    const text = 'Need to confirm the retry behaviour with the payments team before the migration';
    const narrow = naturalNoteHeight({ noteKind: 'note', width: 160 }, text, ctx);
    const wide = naturalNoteHeight({ noteKind: 'note', width: 480 }, text, ctx);
    expect(wide).toBeLessThan(narrow);
  });
});

describe('Note — text normalization at commit', () => {
  it('turns CRLF and CR into LF', () => {
    expect(normalizeNoteText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('turns tabs into two spaces and drops trailing whitespace per line', () => {
    expect(normalizeNoteText('\tindented  \nnext\t')).toBe('  indented\nnext');
  });

  it('drops trailing blank lines but keeps blank lines in the middle', () => {
    expect(normalizeNoteText('Retry strategy\n\n- 3 attempts\n\n\n')).toBe('Retry strategy\n\n- 3 attempts');
  });

  it('whitespace-only becomes the empty note', () => {
    expect(normalizeNoteText('  \n\t\n')).toBe('');
  });

  it('leaves leading indentation alone', () => {
    expect(normalizeNoteText('  - nested')).toBe('  - nested');
  });

  it('indentation at the start of a line is drawn; only wrapped continuation lines lose it', () => {
    const layout = layoutText('- item\n  - nested item that is long enough to wrap around', {
      font: FONTS.noteBody,
      maxWidth: 150,
      lineHeight: 18,
      measurer: ctx.measurer,
    });
    expect(layout.lines[0]!.text).toBe('- item');
    expect(layout.lines[1]!.text.startsWith('  - nested')).toBe(true);
    expect(layout.lines.length).toBeGreaterThan(2);
    expect(layout.lines[2]!.text.startsWith(' ')).toBe(false);
  });
});

describe('Note — layout treats CR and CRLF as line breaks', () => {
  it('never renders a stray carriage return as a glyph', () => {
    const layout = layoutText('one\r\ntwo\rthree', {
      font: FONTS.noteBody,
      maxWidth: 400,
      lineHeight: 18,
      measurer: ctx.measurer,
    });
    expect(layout.lines.map((l) => l.text)).toEqual(['one', 'two', 'three']);
  });
});

describe('Note — one undo step per edit, height included', () => {
  beforeEach(() => {
    __resetInteraction();
    __resetClipboardSync();
    useEditorStore.setState({
      document: createDocument('Notes'),
      selection: { nodes: [], edges: [] },
      history: { past: [], future: [] },
    });
  });

  it('updateNodeText commits text and a grown height as a single history entry', () => {
    const store = useEditorStore.getState();
    const node = store.addNode({ type: 'note', x: 0, y: 0, text: '' });
    const before = useEditorStore.getState().history.past.length;

    useEditorStore.getState().updateNodeText(node.id, 'a\nb\nc\nd', { height: 120 });

    const after = useEditorStore.getState();
    expect(after.document.nodes[0]!.text).toBe('a\nb\nc\nd');
    expect(after.document.nodes[0]!.height).toBe(120);
    expect(after.history.past).toHaveLength(before + 1);

    after.undo();
    expect(useEditorStore.getState().document.nodes[0]!.text).toBe('');
    expect(useEditorStore.getState().document.nodes[0]!.height).toBe(DEFAULTS.noteHeight);

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().document.nodes[0]!.height).toBe(120);
  });

  it('switching to a tagged kind grows a full note so no line turns into an ellipsis', () => {
    const store = useEditorStore.getState();
    const text = 'a\nb\nc';
    const height = naturalNoteHeight({ noteKind: 'note', width: DEFAULTS.noteWidth }, text, ctx);
    const node = store.addNode({ type: 'note', x: 0, y: 0, height, text });
    useEditorStore.getState().updateNodeById(node.id, { noteKind: 'question' }, 'Note kind');
    const after = useEditorStore.getState().document.nodes[0]!;
    expect(after.height).toBeGreaterThan(height);
    const [body] = describeNode(after, ctx).shapes.filter((s) => s.t === 'text').slice(-1);
    expect((body as { layout: { truncated: boolean } }).layout.truncated).toBe(false);

    // And never the other way: going back to plain leaves the (now larger) box alone.
    useEditorStore.getState().updateNodeById(node.id, { noteKind: 'note' }, 'Note kind');
    expect(useEditorStore.getState().document.nodes[0]!.height).toBe(after.height);
  });

  it('a height-less update leaves the box alone', () => {
    const store = useEditorStore.getState();
    const node = store.addNode({ type: 'note', x: 0, y: 0, height: 300, text: '' });
    useEditorStore.getState().updateNodeText(node.id, 'short');
    expect(useEditorStore.getState().document.nodes[0]!.height).toBe(300);
  });
});

describe('Note — multiline text survives every round trip', () => {
  const text = 'Retry strategy\n\n- 3 attempts\n- exponential backoff\n- send to DLQ after exhaustion';

  it('save and load', () => {
    const doc = addNodes(createDocument('Trip'), [createNode({ type: 'note', x: 0, y: 0, text })]);
    const back = deserializeDocument(serializeDocument(doc));
    if (!back.ok) throw new Error(back.error);
    expect(back.document.nodes[0]!.text).toBe(text);
  });

  it('copy and paste', () => {
    const doc = addNodes(createDocument('Trip'), [createNode({ type: 'note', x: 0, y: 0, text })]);
    const fragment = extractFragment(doc, [doc.nodes[0]!.id]);
    const back = decodeClipboard(encodeClipboard(fragment));
    expect(back?.nodes[0]!.text).toBe(text);
  });

  it('duplicate', () => {
    __resetInteraction();
    useEditorStore.setState({
      document: createDocument('Dup'),
      selection: { nodes: [], edges: [] },
      history: { past: [], future: [] },
    });
    const node = useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text });
    useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });
    useEditorStore.getState().duplicateSelection();
    const nodes = useEditorStore.getState().document.nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[1]!.text).toBe(text);
  });
});
