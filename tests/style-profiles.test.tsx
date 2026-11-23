/**
 * A person's own styles: kept on this device, checked whenever they are read, never part of a
 * diagram until asked, and edited on a page that draws what it changes with the real renderer.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The same stand-in `personality-preference.test.tsx` uses: Node's own `localStorage` shadows jsdom's.
const preferences = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
  removePreference: (key: string) => void preferences.delete(key),
}));

const { createDocument, createNode } = await import('../src/document/factory');
const { addNodes } = await import('../src/document/operations');
const { CONTRAST, schemeTheme } = await import('../src/render/style/scheme');
const { paletteOf, STYLE_PALETTES } = await import('../src/render/style/palettes');
const { resolveStyle } = await import('../src/render/style/resolve');
const { renderDocumentSvg } = await import('../src/render/svg/document');
const { DARK, LIGHT } = await import('../src/render/theme/tokens');
const { contrast } = await import('../src/lib/colour');
const { __resetStyleDbForTests, readProfiles, readShapeStarts, writeProfile, writeShapeStarts } = await import('../src/storage/styleProfiles');
const { MAX_STYLE_FILE_BYTES, readStyleFile, serializeStyleFile, styleFileName } = await import('../src/document/styleFile');
const { setFileSaver } = await import('../src/export/download');
const { nodeCommands } = await import('../src/commands/registry');
const { stubContext } = await import('./commandStubs');
const { useGalleryStore } = await import('../src/store/galleryStore');
const { writeFile: writeGalleryFile } = await import('../src/gallery/cache');
const { vendoredCatalog, vendoredText } = await import('./fixtures/gallery');
const { __resetInteraction, fileOf, useEditorStore } = await import('../src/store/editorStore');
const { activeStyleOf, builtinProfileStyle, deviceStyle, shapeStartFields, shapeStartFrom, useStyleStore } = await import('../src/store/styleStore');
const { useUiStore } = await import('../src/store/uiStore');
const { AppearanceSettings } = await import('../src/ui/settings/AppearanceSettings');
const { StylePreview } = await import('../src/ui/settings/StylePreview');
const { PersonalityProvider } = await import('../src/ui/personality/PersonalityProvider');
type DocumentStyle = import('../src/document/style').DocumentStyle;

const BOLD: DocumentStyle = { v: 1, hand: { base: 'draft' }, general: { weight: 'bold' } };

function resetStores() {
  preferences.clear();
  globalThis.indexedDB = new IDBFactory();
  __resetStyleDbForTests();
  useStyleStore.setState({ profiles: [], activeId: null, starts: {}, loaded: false });
  __resetInteraction();
  useEditorStore.setState({
    document: addNodes(createDocument('Styled'), [createNode({ id: 'n', type: 'service', x: 0, y: 0, text: 'A' })]),
    path: [],
    outer: null,
    liveViewport: null,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
  });
  useUiStore.setState({ readOnly: null, toasts: [] });
}

beforeEach(resetStores);

describe('the palettes a style can pick', () => {
  it('each keep every one of their colours: none is unreadable enough to fall back', () => {
    for (const palette of STYLE_PALETTES) {
      if (!palette.schemes) continue;
      for (const [base, name] of [[LIGHT, 'light'], [DARK, 'dark']] as const) {
        const scheme = palette.schemes[name]!;
        const theme = schemeTheme(base, scheme);
        expect(theme.canvas, `${palette.id} ${name} canvas`).toBe(scheme.canvas);
        expect(theme.text, `${palette.id} ${name} text`).toBe(scheme.text);
        for (const [accent, colours] of Object.entries(scheme.accents ?? {})) {
          expect(theme.accents[accent as keyof typeof theme.accents], `${palette.id} ${name} ${accent}`).toEqual(colours);
          expect(contrast(colours.text, colours.fill), `${palette.id} ${name} ${accent} name`).toBeGreaterThanOrEqual(CONTRAST.label);
          expect(contrast(colours.line, scheme.canvas!), `${palette.id} ${name} ${accent} outline`).toBeGreaterThanOrEqual(CONTRAST.line);
        }
      }
    }
  });

  it('are written into a style as plain colours and recognised again from them', () => {
    expect(paletteOf({})?.id).toBe('builtin');
    for (const palette of STYLE_PALETTES) expect(paletteOf({ schemes: palette.schemes })?.id).toBe(palette.id);
    // Colours that are nobody's palette: a pack's own.
    expect(paletteOf({ schemes: { dark: { canvas: '#120c1f' } } })).toBeNull();
  });

  it('follow the device between light and dark', () => {
    for (const palette of STYLE_PALETTES) {
      if (!palette.schemes) continue;
      expect(resolveStyle({ v: 1, hand: { base: 'clean' }, schemes: palette.schemes }).pinned, palette.id).toBeUndefined();
    }
  });
});

describe('the styles kept on this device', () => {
  it('start with none, and the style in use is the built-in for the device’s drawing hand', () => {
    expect(activeStyleOf(useStyleStore.getState(), 'sketch')).toBe(builtinProfileStyle('sketch'));
    preferences.set('personality', 'draft');
    expect(deviceStyle()).toBe(builtinProfileStyle('draft'));
    preferences.set('personality', 'nonsense');
    expect(deviceStyle()).toBe(builtinProfileStyle('clean'));
  });

  it('keep a style made here, use it, and still have it after a reload', async () => {
    const id = useStyleStore.getState().add('  Mine  ', BOLD)!;
    expect(useStyleStore.getState().activeId).toBe(id);
    expect(deviceStyle()).toEqual({ ...BOLD, name: 'Mine' });
    useStyleStore.getState().update(id, (style) => ({ ...style, general: { weight: 'fine', corners: 'round' } }));
    useStyleStore.getState().rename(id, 'Harbour');
    await vi.waitFor(async () => expect((await readProfiles())[0]?.name).toBe('Harbour'));

    // What a fresh page would do.
    useStyleStore.setState({ profiles: [], loaded: false });
    await useStyleStore.getState().load();
    const [profile] = useStyleStore.getState().profiles;
    expect(profile).toMatchObject({ id, name: 'Harbour', style: { v: 1, name: 'Harbour', hand: { base: 'draft' }, general: { weight: 'fine', corners: 'round' } } });
    expect(useStyleStore.getState().activeId).toBe(id);
  });

  it('go back to the built-in styles when the one in use is deleted or gone', async () => {
    const id = useStyleStore.getState().add('Mine', BOLD)!;
    useStyleStore.getState().remove(id);
    expect(useStyleStore.getState().activeId).toBeNull();
    expect(preferences.has('style-profile')).toBe(false);
    await vi.waitFor(async () => expect(await readProfiles()).toEqual([]));

    // A preference naming a style this device no longer has.
    preferences.set('style-profile', 'p_goneForGood1');
    useStyleStore.setState({ profiles: [], activeId: 'p_goneForGood1', loaded: false });
    await useStyleStore.getState().load();
    expect(useStyleStore.getState().activeId).toBeNull();
  });

  it('check a stored style like one from a file', async () => {
    await writeProfile({ id: 'p_tampered01', name: 'Tampered', updatedAt: 1, style: { v: 1, hand: { base: 'scribble' }, general: { weight: 'huge', onload: 'alert(1)' } } as unknown as DocumentStyle });
    await writeProfile({ id: '../etc/passwd', name: 'Bad id', updatedAt: 2, style: BOLD });
    await writeProfile({ id: 'p_nostyle0001', name: 'No style', updatedAt: 3, style: 42 as unknown as DocumentStyle });
    expect(await readProfiles()).toEqual([{ id: 'p_tampered01', name: 'Tampered', updatedAt: 1, style: { v: 1, hand: { base: 'clean' } } }]);
  });

  it('change no diagram: a diagram takes a style only when given one', () => {
    useStyleStore.getState().add('Mine', BOLD);
    expect('style' in fileOf(useEditorStore.getState())).toBe(false);
    useEditorStore.getState().setDocumentStyle(deviceStyle());
    expect(fileOf(useEditorStore.getState()).style).toEqual({ ...BOLD, name: 'Mine' });
    // Changing the style afterwards leaves the diagram as it was.
    useStyleStore.getState().update(useStyleStore.getState().activeId!, (style) => ({ ...style, general: { weight: 'fine' } }));
    expect(fileOf(useEditorStore.getState()).style?.general).toEqual({ weight: 'bold' });
  });
});

describe('a style as a file', () => {
  it('comes back as it was written, and is the same bytes every time', () => {
    const text = serializeStyleFile('Harbour', { ...BOLD, schemes: STYLE_PALETTES[1]!.schemes });
    expect(serializeStyleFile('Harbour', { schemes: STYLE_PALETTES[1]!.schemes, general: { weight: 'bold' }, hand: { base: 'draft' }, v: 1 })).toBe(text);
    const read = readStyleFile(text);
    expect(read).toMatchObject({ ok: true, name: 'Harbour', repairs: [], style: { v: 1, name: 'Harbour', hand: { base: 'draft' }, general: { weight: 'bold' } } });
    expect(read.ok && read.style.schemes).toEqual(STYLE_PALETTES[1]!.schemes);
    expect(styleFileName('  My / style: v2?  ')).toBe('My-style-v2.draftstyle');
    expect(styleFileName('///')).toBe('style.draftstyle');
  });

  it('is checked like any style from outside, and says why a file is not one', () => {
    const hostile = JSON.stringify({
      format: 'draft-canvas-style',
      version: 1,
      name: 'Odd',
      style: { v: 1, hand: { base: 'sketch' }, general: { weight: 'bold', onclick: 'alert(1)' }, shapes: { service: { art: 'a000000000' } }, assets: [{ id: 'a000000000', w: 10, h: 10, paths: [{ d: 'M0 0<script>', fill: 'line' }] }] },
    });
    const read = readStyleFile(hostile);
    expect(read.ok && read.style).toEqual({ v: 1, name: 'Odd', hand: { base: 'sketch' }, general: { weight: 'bold' } });
    expect(read.ok && read.repairs.join(' ')).toContain('custom drawing');

    const error = (text: string) => {
      const result = readStyleFile(text);
      return result.ok ? null : result.error;
    };
    expect(error('not json')).toBe('That file isn’t a Draft Canvas style.');
    expect(error(JSON.stringify({ format: 'draft-canvas', version: 32, nodes: [] }))).toBe('That file isn’t a Draft Canvas style.');
    expect(error(JSON.stringify({ format: 'draft-canvas-style', version: 2, style: BOLD }))).toBe('That style was made by a newer Draft Canvas. Update to use it.');
    expect(error(JSON.stringify({ format: 'draft-canvas-style', version: 1, style: { v: 9 } }))).toBe('That file has no style in it that can be read.');
    expect(error('x'.repeat(MAX_STYLE_FILE_BYTES + 1))).toBe('That file is too large to be a style.');
  });
});

describe('how a new shape starts', () => {
  const gateway = { ...createNode({ id: 'g', type: 'service', x: 0, y: 0, text: 'Edge', serviceKind: 'gateway' }), accent: 'blue' as const };

  it('is what the person saved from a shape, for that type only', async () => {
    expect(shapeStartFields('service')).toEqual({});
    expect(shapeStartFrom(gateway)).toEqual({ accent: 'blue', kind: 'gateway' });
    useStyleStore.getState().setStart('service', shapeStartFrom(gateway));
    expect(shapeStartFields('service')).toEqual({ accent: 'blue', serviceKind: 'gateway' });
    expect(shapeStartFields('database')).toEqual({});

    // Still there after a reload.
    await vi.waitFor(async () => expect(await readShapeStarts()).toEqual({ service: { accent: 'blue', kind: 'gateway' } }));
    useStyleStore.setState({ starts: {}, loaded: false });
    await useStyleStore.getState().load();
    expect(shapeStartFields('service')).toEqual({ accent: 'blue', serviceKind: 'gateway' });

    useStyleStore.getState().setStart('service', null);
    expect(shapeStartFields('service')).toEqual({});
  });

  it('has nothing to keep from a shape that is exactly as its type starts', () => {
    for (const type of ['service', 'database', 'queue', 'actor', 'note', 'group'] as const) {
      expect(shapeStartFrom(createNode({ type, x: 0, y: 0 })), type).toBeNull();
    }
    expect(shapeStartFrom({ ...createNode({ type: 'actor', x: 0, y: 0 }), actorFrame: 'framed' })).toEqual({ frame: 'framed' });
  });

  it('keeps only a colour and a kind this version knows', async () => {
    await writeShapeStarts({ service: { accent: 'chartreuse', kind: 'teapot' }, database: { kind: 'cache', onload: 'alert(1)' }, rocket: { kind: 'x' } } as never);
    expect(await readShapeStarts()).toEqual({ database: { kind: 'cache' } });
  });

  it('is offered on a shape that differs from how its type starts, and taken back by name', () => {
    const ids = () => nodeCommands(stubContext(), gateway).map((command) => command.id);
    expect(ids()).toContain('save-shape-default');
    expect(ids()).not.toContain('reset-shape-default');
    expect(nodeCommands(stubContext(), gateway).find((command) => command.id === 'save-shape-default')!.title).toBe('Save as my default Service');
    expect(nodeCommands(stubContext(), createNode({ id: 'p', type: 'service', x: 0, y: 0 })).map((command) => command.id)).not.toContain('save-shape-default');

    const context = stubContext();
    void nodeCommands(context, gateway).find((command) => command.id === 'save-shape-default')!.run(context);
    expect(useStyleStore.getState().starts.service).toEqual({ accent: 'blue', kind: 'gateway' });
    // Saved already: nothing to save again, and a way back.
    expect(ids()).not.toContain('save-shape-default');
    expect(ids()).toContain('reset-shape-default');
    void nodeCommands(context, gateway).find((command) => command.id === 'reset-shape-default')!.run(context);
    expect(useStyleStore.getState().starts.service).toBeUndefined();
  });
});

describe('a style’s preview', () => {
  it('is the export renderer’s own drawing of a sample, in that style', () => {
    const { container } = render(<StylePreview style={BOLD} theme="light" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBeTruthy();
    // Heavier outlines than the built-in look draws, and its own arrowhead definitions.
    const plain = render(<StylePreview style={{ v: 1, hand: { base: 'draft' } }} theme="light" />).container.innerHTML;
    expect(container.innerHTML).not.toBe(plain);
    expect(container.innerHTML).toContain('<marker');
  });

  it('keeps its own arrowheads, so two on a page never share or clash', () => {
    const { container } = render(
      <>
        <StylePreview style={BOLD} theme="light" size="card" />
        <StylePreview style={{ v: 1, hand: { base: 'clean' }, connectors: { head: 'triangle' } }} theme="light" size="card" />
      </>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(ids.length).toBeGreaterThan(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('draws one shape on its own, as the renderer would in a diagram', () => {
    const node = createNode({ id: 'preview-shape', type: 'database', x: 0, y: 0, text: 'Name', accent: 'teal' });
    const expected = renderDocumentSvg(addNodes(createDocument('shape'), [node]), { style: resolveStyle(BOLD), theme: 'light', includeBackground: false, openPoints: false, padding: 22 }).svg;
    const { container } = render(<StylePreview style={BOLD} theme="light" shape={{ type: 'database' }} />);
    const strokes = (markup: string) => [...markup.matchAll(/stroke-width="([\d.]+)"/g)].map((match) => match[1]);
    expect(strokes(container.innerHTML)).toEqual(strokes(expected));
  });
});

describe('Settings → Appearance', () => {
  const page = (documentOpen = true) =>
    render(
      <PersonalityProvider>
        <AppearanceSettings documentOpen={documentOpen} />
      </PersonalityProvider>,
    );
  const choose = (group: string, option: string | RegExp) => fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }));
  const mine = (name: RegExp) => within(screen.getByRole('group', { name: 'My style' })).getByRole('radio', { name });

  it('lists the three built-in styles, with the device’s own in use', () => {
    preferences.set('personality', 'sketch');
    page();
    expect(mine(/^Clean/)).not.toBeChecked();
    expect(mine(/^Sketch/)).toBeChecked();
  });

  it('makes a built-in style the person’s own on the first change, and keeps what they change', async () => {
    page();
    await act(async () => choose('Line weight', 'Bold'));
    const [profile] = useStyleStore.getState().profiles;
    expect(profile).toMatchObject({ name: 'My style', style: { hand: { base: 'clean' }, general: { weight: 'bold' } } });
    expect(useStyleStore.getState().activeId).toBe(profile!.id);
    expect(mine(/^My style/)).toBeChecked();

    await act(async () => choose('Corners', 'Round'));
    await act(async () => choose('Arrowhead', 'Triangle'));
    await act(async () => choose('Drawing hand', 'Sketch'));
    expect(useStyleStore.getState().profiles).toHaveLength(1);
    expect(useStyleStore.getState().profiles[0]!.style).toMatchObject({ hand: { base: 'sketch' }, general: { weight: 'bold', corners: 'round' }, connectors: { head: 'triangle' } });
    // The device's drawing hand follows the style in use.
    expect(preferences.get('personality')).toBe('sketch');
    // Setting a value back to the built-in one removes it, so a style never keeps an empty setting.
    await act(async () => choose('Line weight', 'Regular'));
    expect(useStyleStore.getState().profiles[0]!.style.general).toEqual({ corners: 'round' });
  });

  it('gives one shape a look of its own, lets a kind differ again, and resets it', async () => {
    page();
    await act(async () => fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Shape' })).getByRole('radio', { name: /Data store/ })));
    await act(async () => choose('Data store: line weight', 'Bold'));
    expect(useStyleStore.getState().profiles[0]!.style.shapes).toEqual({ database: { weight: 'bold' } });

    await act(async () => fireEvent.change(screen.getByRole('combobox', { name: 'Kind of data store' }), { target: { value: 'cache' } }));
    await act(async () => choose('Cache data store: shadow', 'Off'));
    expect(useStyleStore.getState().profiles[0]!.style.shapes).toEqual({ database: { weight: 'bold' }, 'database:cache': { shadow: false } });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reset' })));
    expect(useStyleStore.getState().profiles[0]!.style.shapes).toEqual({ database: { weight: 'bold' } });
  });

  it('leaves a diagram with no style of its own without one: it is drawn in the style in use as it is', async () => {
    page();
    await act(async () => choose('Line weight', 'Bold'));
    expect('style' in fileOf(useEditorStore.getState())).toBe(false);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(screen.getByText(/Has no style of its own/)).toBeInTheDocument();

    // Until the style is kept with it, so it looks this way for everyone: one step, which undo takes back.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use my style' })));
    expect(fileOf(useEditorStore.getState()).style).toMatchObject({ name: 'My style', general: { weight: 'bold' } });
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    // Drawn in it now: that is said, and there is nothing left to press.
    expect(screen.queryByRole('button', { name: 'Use my style' })).toBeNull();
    expect(screen.getByText(/following your changes here/)).toBeInTheDocument();
    act(() => useEditorStore.getState().undo());
    expect('style' in fileOf(useEditorStore.getState())).toBe(false);
  });

  it('takes a diagram drawn in the style in use along with every change, as it is made', async () => {
    act(() => useEditorStore.getState().setDocumentStyle(builtinProfileStyle('clean')));
    useEditorStore.setState({ history: { past: [], future: [] } });
    page();
    expect(screen.getByText(/following your changes here/)).toBeInTheDocument();

    await act(async () => choose('Line weight', 'Bold'));
    expect(fileOf(useEditorStore.getState()).style).toMatchObject({ general: { weight: 'bold' } });
    await act(async () => choose('Corners', 'Round'));
    await act(async () => choose('Arrowhead', 'Triangle'));
    expect(fileOf(useEditorStore.getState()).style).toMatchObject({ general: { weight: 'bold', corners: 'round' }, connectors: { head: 'triangle' } });
    // A run of changes is one step back, not one per click.
    expect(useEditorStore.getState().history.past).toHaveLength(1);

    // Picking another style is a change like any other.
    await act(async () => fireEvent.click(mine(/^Sketch/)));
    expect(fileOf(useEditorStore.getState()).style).toEqual(builtinProfileStyle('sketch'));
    act(() => useEditorStore.getState().undo());
    expect(fileOf(useEditorStore.getState()).style).toEqual(builtinProfileStyle('clean'));
  });

  it('never touches a diagram that has a different look of its own, until asked', async () => {
    const theirs = { ...BOLD, name: 'Harbour' };
    act(() => useEditorStore.getState().setDocumentStyle(theirs));
    useEditorStore.setState({ history: { past: [], future: [] } });
    page();
    expect(screen.getByText(/Your changes here do not touch it/)).toBeInTheDocument();
    await act(async () => choose('Corners', 'Round'));
    await act(async () => fireEvent.click(mine(/^Sketch/)));
    expect(fileOf(useEditorStore.getState()).style).toEqual(theirs);
    expect(useEditorStore.getState().history.past).toHaveLength(0);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use my style' })));
    expect(fileOf(useEditorStore.getState()).style).toEqual(builtinProfileStyle('sketch'));
  });

  it('changes nothing in a shared, read-only diagram', async () => {
    act(() => useEditorStore.getState().setDocumentStyle(builtinProfileStyle('clean')));
    useUiStore.setState({ readOnly: { sharedTitle: 'Shared' } });
    page();
    await act(async () => choose('Line weight', 'Bold'));
    expect(fileOf(useEditorStore.getState()).style).toEqual(builtinProfileStyle('clean'));
  });

  it('offers to keep a diagram’s style that is not one of the person’s own', async () => {
    act(() => useEditorStore.getState().setDocumentStyle({ ...BOLD, name: 'Harbour' }));
    page();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add to my styles' })));
    expect(useStyleStore.getState().profiles[0]).toMatchObject({ name: 'Harbour', style: { general: { weight: 'bold' } } });
    expect(screen.queryByRole('button', { name: 'Add to my styles' })).toBeNull();
  });

  it('has nothing to say about a diagram on a shared, read-only one, or with none open', () => {
    useUiStore.setState({ readOnly: { sharedTitle: 'Shared' } });
    const shared = page();
    expect(screen.queryByText('This diagram')).toBeNull();
    shared.unmount();
    useUiStore.setState({ readOnly: null });
    page(false);
    expect(screen.getByText('Open a diagram to give it this style.')).toBeInTheDocument();
  });

  it('gives a shape a drawing of the person’s own from pasted SVG, and takes it away again', async () => {
    page();
    await act(async () => fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Shape' })).getByRole('radio', { name: /Data store/ })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Paste SVG' })));
    fireEvent.change(screen.getByRole('textbox', { name: 'SVG code' }), {
      target: { value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><script>alert(1)</script><path d="M20 10h60v80h-60z" fill="#fff" stroke="#111" stroke-width="4"/><text>rum</text></svg>' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use this' })));

    const style = () => useStyleStore.getState().profiles[0]!.style;
    const id = style().shapes?.database?.art;
    expect(id).toMatch(/^a[0-9a-z]{8,16}$/);
    expect(style().assets).toEqual([{ id, w: 100, h: 100, paths: [{ d: 'M20 10L80 10L80 90L20 90Z', fill: 'fill', stroke: 'line', sw: 4 }] }]);
    expect(JSON.stringify(style())).not.toMatch(/script|alert|rum/);
    expect(screen.getByRole('status')).toHaveTextContent('Text, images and effects were left out.');

    // Read the other way while the picture is still at hand: its own colours, a different drawing.
    await act(async () => fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Drawing colours' })).getByRole('radio', { name: 'Its own colours' })));
    expect(style().assets).toHaveLength(1);
    expect(style().assets![0]!.paths[0]).toMatchObject({ fill: '#ffffff', stroke: '#111111' });
    await act(async () => fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Drawing fit' })).getByRole('radio', { name: 'Fill the space' })));
    expect(style().shapes?.database).toMatchObject({ fit: 'stretch' });

    // One kind can keep the built-in drawing while the rest have the picture.
    await act(async () => fireEvent.change(screen.getByRole('combobox', { name: 'Kind of data store' }), { target: { value: 'cache' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use the built-in' })));
    expect(style().shapes?.['database:cache']).toEqual({ builtin: true });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Follow every data store' })));
    expect(style().shapes?.['database:cache']).toBeUndefined();

    await act(async () => fireEvent.change(screen.getByRole('combobox', { name: 'Kind of data store' }), { target: { value: '' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove' })));
    expect(style().shapes).toBeUndefined();
    // A drawing nothing uses does not stay in the style.
    expect(style().assets).toBeUndefined();
  });

  it('says why a picture cannot be used, and offers no drawing where one cannot go', async () => {
    page();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Paste SVG' })));
    fireEvent.change(screen.getByRole('textbox', { name: 'SVG code' }), { target: { value: '<p>not a picture</p>' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use this' })));
    expect(screen.getByRole('alert')).toHaveTextContent('This file isn’t an SVG picture.');
    expect(useStyleStore.getState().profiles).toEqual([]);

    await act(async () => fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Shape' })).getByRole('radio', { name: /Note/ })));
    expect(screen.queryByRole('button', { name: 'Paste SVG' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose SVG…' })).toBeNull();
  });

  it('brings a style in from a file and writes one out', async () => {
    page();
    const file = new File([serializeStyleFile('Harbour', { ...BOLD, hand: { base: 'sketch' } })], 'harbour.draftstyle', { type: 'application/json' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*=".draftstyle"]')!;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await vi.waitFor(() => expect(useStyleStore.getState().profiles).toHaveLength(1));
    });
    expect(useStyleStore.getState().profiles[0]).toMatchObject({ name: 'Harbour', style: { hand: { base: 'sketch' }, general: { weight: 'bold' } } });
    expect(mine(/^Harbour/)).toBeChecked();
    expect(preferences.get('personality')).toBe('sketch');

    const saved: { name: string; text: string }[] = [];
    setFileSaver(async (blob, name) => void saved.push({ name, text: await blob.text() }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
      await vi.waitFor(() => expect(saved).toHaveLength(1));
    });
    setFileSaver(null);
    expect(saved[0]!.name).toBe('Harbour.draftstyle');
    expect(readStyleFile(saved[0]!.text)).toMatchObject({ ok: true, name: 'Harbour', style: { general: { weight: 'bold' } } });

    // A file that is not a style says so and changes nothing.
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['{"format":"draft-canvas"}'], 'diagram.draftcanvas')] } });
      await vi.waitFor(() => expect(useUiStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true));
    });
    expect(useStyleStore.getState().profiles).toHaveLength(1);
  });

  it('offers the gallery’s style packs only once the person loads them, and adds one as a style of their own', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const view = page();
    // Nothing is read from anywhere until asked.
    expect(screen.getByRole('button', { name: 'Load style packs' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    view.unmount();

    // As the gallery holds them once loaded: listed, and their files checked into its cache.
    const catalog = vendoredCatalog();
    for (const entry of catalog.styles!) await writeGalleryFile(entry.sha256, vendoredText(entry));
    useGalleryStore.setState({ enabled: true, status: 'idle', failure: null, snapshot: { starters: [], styles: catalog.styles!.map((entry) => ({ ...entry, availability: 'ready' as const })), fetchedAt: Date.now() } });
    page();
    const packs = screen.getByRole('list');
    await vi.waitFor(() => expect(within(packs).getByRole('button', { name: 'Add High seas to my styles' })).toBeEnabled());
    expect(within(packs).getAllByRole('listitem')).toHaveLength(7);
    // A card is its picture, its name and Add; who drew it and under what is a hover away.
    expect(within(packs).getAllByRole('listitem')[0]).toHaveAttribute('title', expect.stringContaining('By Draft Canvas · Apache-2.0'));

    await act(async () => fireEvent.click(within(packs).getByRole('button', { name: 'Add High seas to my styles' })));
    const [profile] = useStyleStore.getState().profiles;
    expect(profile).toMatchObject({ name: 'High seas', style: { hand: { base: 'sketch' } } });
    expect(profile!.style.assets).toHaveLength(35);
    expect(mine(/^High seas/)).toBeChecked();
    expect(preferences.get('personality')).toBe('sketch');
    // It is theirs now: the pack says so, and changing the style does not change the pack.
    expect(within(packs).getByRole('button', { name: 'High seas is in your styles' })).toBeDisabled();
    await act(async () => choose('Line weight', 'Bold'));
    await vi.waitFor(() => expect(within(packs).getByRole('button', { name: 'Add High seas to my styles' })).toBeEnabled());
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    useGalleryStore.setState({ enabled: false, snapshot: null });
  });

  it('renames and deletes a style of the person’s own', async () => {
    const id = useStyleStore.getState().add('Mine', BOLD)!;
    page();
    const name = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Harbour' } });
    await act(async () => fireEvent.blur(name));
    expect(useStyleStore.getState().profiles[0]!.name).toBe('Harbour');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete style' })));
    expect(useStyleStore.getState().profiles.some((profile) => profile.id === id)).toBe(false);
    // Back on a built-in style: the one for the drawing hand this device prefers.
    expect(mine(/^Clean/)).toBeChecked();
  });
});
