import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Handle, NodeResizer, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { maxSizeFor, minSizeFor } from '../document/factory';
import { explainNodeTier, lensNodeTier, type ExplainTier } from '../document/flow';
import { normalizeNoteText } from '../document/noteText';
import { anchorBandOf } from '../document/queueGeometry';
import type { DraftNode } from '../document/types';
import {
  CODE_LAYOUT,
  NOTE_ACCENTS,
  NOTE_AUTO_MAX_HEIGHT,
  TEXT_AUTO_MAX_HEIGHT,
  describeContext,
  describeNode,
  fontForTextNode,
  naturalCodeSize,
  naturalNoteHeight,
  naturalTextHeight,
  noteLayout,
} from '../nodes/describe';
import { HANDLE_ANCHORS } from '../edges/routing';
import { beginClipScope, emitDisplayList } from '../render/svg/emit';
import { useSettle } from './useContinuation';
import { FONTS, LINE_HEIGHTS, cssFont } from '../render/text/fonts';
import { lensFlow, useEditorStore, type EditorStore } from '../store/editorStore';
import { accentOf, type Theme } from '../render/theme/tokens';
import { selectNode } from '../store/selectors';
import { useUiStore } from '../store/uiStore';
import { usePersonality } from '../ui/personality/usePersonality';
import { useThemeValue } from '../ui/theme/useTheme';
import { SvgSurface } from './SvgSurface';
import type { DraftNodeData } from './projection';

/**
 * One component renders every node type.
 *
 * The visual comes entirely from `describeNode`, so adding a node type means
 * writing one pure function — there is no per-type React component to keep in
 * step with the exporter. What lives here is only the interactive chrome:
 * connection handles, the resize frame, and the inline editor. None of that is
 * representable in a display list, which is exactly why it cannot leak into an
 * exported image.
 */
export const DraftNodeView = memo(function DraftNodeView({ id, selected, width, height }: NodeProps) {
  const node = useEditorStore((state) => selectNode(state.document, id));
  const mode = useEditorStore((state) => state.mode);
  // A string, not an object: the selector runs for every node on every store
  // change, and only the nodes whose tier actually flips re-render.
  const explainTier = useEditorStore((state) => explainTierFor(state, id));
  const focused = useEditorStore((state) => state.focus.active && state.focus.nodeIds.includes(id));
  const lensMember = useEditorStore((state) => lensMemberFor(state, id));
  const updateNodeText = useEditorStore((state) => state.updateNodeText);
  const updateNodeById = useEditorStore((state) => state.updateNodeById);
  const theme = useThemeValue();
  const lensAccent = useEditorStore((state) => lensAccentFor(state, theme, id));
  const { preset } = usePersonality();
  const updateNodeInternals = useUpdateNodeInternals();
  // A boolean, not the id itself: every node's selector runs on every drag
  // frame, so only the two nodes whose armed state actually flips re-render.
  const isAttachTarget = useUiStore((state) => state.attachArmedTarget === id);
  // Same boolean-not-id discipline as `isAttachTarget` — see its comment.
  const isReconnectTarget = useUiStore((state) => state.reconnectHoverTarget === id);
  const jumpFlash = useUiStore((state) => state.jumpFlashId === id);
  const settling = useSettle(id);
  // Which specific anchor (side + offset) a reconnect drag is currently
  // hovering, if any is on this node — null on every other node, so only the
  // one matching handle (see the render below) ever re-renders when this
  // changes. A plain string, not the `armedAnchor` object itself, so zustand's
  // default equality still skips a re-render when it hasn't actually changed.
  const armedAnchorKey = useUiStore((state) =>
    state.armedAnchor && state.armedAnchor.nodeId === id
      ? `${state.armedAnchor.side}:${state.armedAnchor.offset}`
      : null,
  );
  const setOpenAttachmentDetail = useUiStore((state) => state.setOpenAttachmentDetail);
  const popoverOpen = useUiStore(
    (state) => state.openAttachmentDetail?.hostKind === 'node' && state.openAttachmentDetail?.hostId === id,
  );
  const editRequested = useUiStore((state) => state.editRequestId === id);

  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * A note grows as it is typed into. The grown height lives here, not in the store, until the
   * edit commits: writing the document on every keystroke would autosave and re-project the whole
   * canvas per character for a box only this component can see change. It is grow-only and capped
   * (`NOTE_AUTO_MAX_HEIGHT`), and the commit persists it in the same undo step as the text.
   * Handles and incoming connectors follow at commit rather than per keystroke.
   */
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const [copied, setCopied] = useState(false);
  const isCode = node?.type === 'code';
  const isNote = node?.type === 'note';
  const isText = node?.type === 'text';
  const copiedTimeout = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimeout.current !== null) window.clearTimeout(copiedTimeout.current);
    },
    [],
  );

  // Handles move with the node's size, so React Flow has to re-measure them.
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, node?.width, node?.height, updateNodeInternals]);

  // `Enter` asks a node to start editing — there is no ref-based imperative
  // API into this memoized component, so a transient id in `uiStore` is the
  // simplest hook, cleared as soon as it has been acted on. Consuming a
  // one-shot external command, not deriving render state.
  useEffect(() => {
    if (!editRequested) return;
    useUiStore.getState().requestEdit(null);
    if (mode !== 'present') setEditing(true);
  }, [editRequested, mode]);

  useLayoutEffect(() => {
    if (!editing) return;
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    // Multi-line content is appended to far more often than replaced, and select-all on a
    // paragraph means the next keystroke wipes it. A single-line label is the opposite case —
    // still the common one for Text (a short heading or identifier), so only a Text node that
    // already has a second line gets the append-friendly treatment; a fresh or single-line one
    // keeps the quick "retype the whole thing" convenience of select-all.
    const alreadyMultiline = isText && (node?.text ?? '').includes('\n');
    if (isNote || isCode || alreadyMultiline) {
      const end = el.value.length;
      el.setSelectionRange(end, end);
    } else {
      el.select();
    }
    // A note whose text already overflows its box (sized down by hand, or grown past what a
    // narrower width can hold) opens tall enough to show all of it — see `liveHeight`.
    if ((isNote || isText) && node) {
      const grown = isText ? grownTextHeight(el, node.height) : grownNoteHeight(node, el, node.height);
      if (grown !== null) setLiveHeight(grown);
    }
    // Only the transition into editing matters; the node's own fields are read once, at that moment.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const stopEditing = useCallback(() => setEditing(false), []);

  // `liveHeight` is kept until the committed document has caught up with it, so the box never
  // dips back to its old height for the frame between the commit and React Flow re-projecting.
  useEffect(() => {
    if (liveHeight !== null && !editing && node && node.height >= liveHeight) {
      setLiveHeight(null);
    }
  }, [liveHeight, editing, node]);

  /**
   * React Flow updates `width`/`height` on this node live, once per frame,
   * while `NodeResizer` is dragging — that live value is what must drive the
   * visible content. Reading `node.width/height` from the committed document
   * here instead is the bug this fixes: the store is only written once the
   * gesture ends, so the content would stay frozen at the old size for the
   * whole drag and jump on release.
   */
  const effectiveWidth = Math.round(width ?? node?.width ?? 0);
  const effectiveHeight = Math.round(liveHeight ?? height ?? node?.height ?? 0);
  const liveNode: DraftNode | null = !node
    ? null
    : effectiveWidth === node.width && effectiveHeight === node.height
      ? node
      : { ...node, width: effectiveWidth, height: effectiveHeight };
  // Relative to the node box (y: 0) — the handles are positioned inside it.
  const handleBand = liveNode ? anchorBandOf({ type: liveNode.type, y: 0, height: effectiveHeight }) : undefined;
  // React Flow's `Handle` is memoized, so each keeps its style object until the band itself moves —
  // twelve fresh objects per node render would re-render every handle every time.
  const bandTop = handleBand?.top;
  const bandBottom = handleBand?.bottom;
  const handleStyles = useMemo(
    () =>
      new Map(
        HANDLE_ANCHORS.map((anchor) => [
          anchor.id,
          anchor.side === 'top' || anchor.side === 'bottom' || bandTop === undefined || bandBottom === undefined
            ? STATIC_HANDLE_STYLES.get(anchor.id)!
            : { top: `${bandTop + (bandBottom - bandTop) * anchor.offset}px` },
        ]),
      ),
    [bandTop, bandBottom],
  );

  /**
   * React Flow passes a fresh `positionAbsoluteX`/`positionAbsoluteY` prop into
   * every node component on every frame of a drag, even though this component
   * never reads them (position is applied by React Flow's own transform on the
   * wrapper div). `memo()` alone can't tell that change apart from one that
   * actually affects appearance, so without this `useMemo` the display list —
   * layout, text measurement, code tokenization lookups — would rebuild on
   * every dragged frame for content that never changed. Called unconditionally
   * (ahead of the `!node` early return below) because hooks can't be
   * conditional; it degrades to an empty list while there is no node.
   */
  // `liveNode` only changes identity when width/height actually change (see
  // the ternary above); that *is* the memoization the linter can't see through.
  // While a note is being edited its body belongs to the textarea alone: drawing the committed
  // text underneath as well would show two copies wherever the two wrap differently by a word.
  const editingNote = editing && isNote;
  const shapes = useMemo(() => {
    if (!liveNode) return [];
    beginClipScope(liveNode.id);
    const described = editingNote ? { ...liveNode, text: '' } : liveNode;
    return emitDisplayList(describeNode(described, describeContext(theme, preset)));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see comment above.
  }, [liveNode, theme, preset, editingNote]);

  // Doesn't depend on `node`, so — like `shapes` above — this is computed and its effect run
  // unconditionally, ahead of the `!node` early return below.
  const readOnly = mode === 'present';

  // `NodeResizer` below is only rendered while `!readOnly`, so switching to Presentation Mode
  // mid-resize (e.g. Cmd/Ctrl+Enter pressed without releasing the resize handle) unmounts it
  // without its own `onResizeEnd` ever firing. Without this, the interaction bracket it opened
  // (`beginInteraction`/`setInteractionActive`) would stay open indefinitely — silently turning
  // every document edit the user makes next into more of the same "in progress" gesture, with no
  // history entry created for any of them, until an unrelated resize happened to close it. This
  // finishes the gesture the same way `onResizeEnd` would.
  useEffect(() => {
    if (readOnly && resizing) {
      useEditorStore.getState().endInteraction();
      useUiStore.getState().setInteractionActive(false);
      setResizing(false);
    }
  }, [readOnly, resizing]);
  // Same bracket, closed from the other direction: the node itself unmounting mid-resize (deleted
  // by a key press, or by undo in another path) also skips `onResizeEnd`.
  useEffect(() => {
    if (!resizing) return;
    return () => {
      useEditorStore.getState().endInteraction();
      useUiStore.getState().setInteractionActive(false);
    };
  }, [resizing]);

  if (!node) return null;

  const beginEditing = () => {
    if (readOnly) return;
    setEditing(true);
  };

  const commit = (value: string) => {
    if (isCode) {
      if (value !== (node.code ?? '')) {
        // The rendered (non-editing) view clips to the card's own height —
        // unlike the textarea the user was just typing into, it cannot
        // scroll. Growing to fit avoids silently hiding lines the user just
        // pasted; never shrinking respects a card the user sized on purpose.
        const needed = naturalCodeSize(value, describeContext(theme)).height;
        const patch = needed > node.height ? { code: value, height: needed } : { code: value };
        updateNodeById(node.id, patch, 'Edit code');
      }
    } else if (isNote) {
      const text = normalizeNoteText(value);
      // Grow-only, like a code card: the box always ends up tall enough for what was typed, and
      // a box the user made bigger on purpose is never taken back. The live (DOM-measured)
      // height is folded in so the store never lands below what is already on screen.
      const needed = Math.max(naturalNoteHeight(node, text, describeContext(theme)), liveHeight ?? 0);
      const height = needed > node.height ? needed : undefined;
      if (text !== (node.text ?? '') || height !== undefined) {
        updateNodeText(node.id, text, height === undefined ? undefined : { height });
      }
    } else if (isText) {
      // Same grow-only contract as a note's box, above: never shrinks what's already on screen.
      const needed = Math.max(naturalTextHeight(node, value, describeContext(theme)), liveHeight ?? 0);
      const height = needed > node.height ? needed : undefined;
      if (value !== (node.text ?? '') || height !== undefined) {
        updateNodeText(node.id, value, height === undefined ? undefined : { height });
      }
      // Runs on every exit from editing, not just when something changed: a Text node that never
      // received a real commit (`textOrigin` still `'auto'`) and ends up empty here is removed
      // outright — the fix for a Text element that would otherwise become a permanently invisible,
      // selectable ghost the instant it's deselected. A node whose content was typed and later
      // deliberately cleared (`textOrigin: 'explicit'`) is left alone; see `finishTextEdit`.
      useEditorStore.getState().finishTextEdit(node.id, value);
    } else if (value !== (node.text ?? '')) {
      updateNodeText(node.id, value);
    }
  };

  const growToFit = (el: HTMLTextAreaElement) => {
    const grown = isText ? grownTextHeight(el, effectiveHeight) : grownNoteHeight(node, el, effectiveHeight);
    if (grown !== null) setLiveHeight(grown);
  };

  const min = minSizeFor(node.type);
  const max = maxSizeFor(node.type);
  const attachmentCount = node.attachments?.length ?? 0;

  return (
    <div
      className="dc-node"
      data-type={node.type}
      data-selected={selected ? 'true' : undefined}
      data-explain-active={explainTier === 'active' ? 'true' : undefined}
      data-explain-shown={explainTier === 'shown' ? 'true' : undefined}
      data-focused={focused ? 'true' : undefined}
      data-lens-member={lensMember ? 'true' : undefined}
      data-editing={editing ? 'true' : undefined}
      data-attach-target={isAttachTarget ? 'true' : undefined}
      data-reconnect-target={isReconnectTarget ? 'true' : undefined}
      data-jump-flash={jumpFlash ? 'true' : undefined}
      data-settle={settling ? 'true' : undefined}
      style={
        {
          width: effectiveWidth,
          height: effectiveHeight,
          ...(lensAccent ? { ['--dc-lens-accent']: lensAccent } : {}),
        } as CSSProperties
      }
      onDoubleClick={beginEditing}
    >
      {!readOnly && (
        <NodeResizer
          isVisible={Boolean(selected)}
          minWidth={min.width}
          minHeight={min.height}
          maxWidth={max?.width}
          maxHeight={max?.height}
          keepAspectRatio={node.type === 'ellipse'}
          lineClassName="dc-resize-line"
          handleClassName="dc-resize-handle"
          onResizeStart={() => {
            useEditorStore.getState().beginInteraction('Resize');
            useUiStore.getState().setInteractionActive(true);
            setResizing(true);
          }}
          onResizeEnd={() => {
            useEditorStore.getState().endInteraction();
            useUiStore.getState().setInteractionActive(false);
            setResizing(false);
          }}
        />
      )}

      {resizing && (
        <div className="dc-resize-indicator">
          {effectiveWidth} × {effectiveHeight}
        </div>
      )}

      {isCode && (
        <button
          type="button"
          className="dc-code-copy"
          title="Copy code"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void navigator.clipboard.writeText(node.code ?? '').then(() => {
              if (copiedTimeout.current !== null) window.clearTimeout(copiedTimeout.current);
              setCopied(true);
              copiedTimeout.current = window.setTimeout(() => {
                copiedTimeout.current = null;
                setCopied(false);
              }, 1200);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}

      {attachmentCount > 0 && (
        <button
          type="button"
          className="dc-attachment-badge"
          data-open={popoverOpen ? 'true' : undefined}
          title={`${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            // Presenting never opens the popover — editing attachments mid-presentation is exactly
            // what `AttachmentChip`'s own `editable` gate also exists to prevent; guarding here too
            // keeps the badge's own `data-open` state from claiming "open" for a popover that
            // `AttachmentPopover` itself refuses to render while presenting.
            if (mode === 'present') return;
            setOpenAttachmentDetail(popoverOpen ? null : { hostKind: 'node', hostId: node.id, attachmentId: null });
          }}
        >
          {'<>'} {attachmentCount}
        </button>
      )}

      <SvgSurface className="dc-node-surface" width={effectiveWidth} height={effectiveHeight}>
        {shapes}
      </SvgSurface>

      {isNote && !editing && !readOnly && !(node.text ?? '').trim() && (
        <div className="dc-note-placeholder" style={placeholderStyle(node)}>
          Add a note…
        </div>
      )}

      {editing && (
        // `nodrag`: React Flow's drag filter is class-based, so without it a mouse-drag to select
        // text moves the node instead. `nowheel`: same for scrolling a long editor, which would
        // otherwise pan the canvas.
        <textarea
          ref={editorRef}
          className={`dc-node-editor nodrag nowheel${isCode ? ' dc-node-editor-code' : ''}${isNote ? ' dc-node-editor-note' : ''}`}
          defaultValue={isCode ? (node.code ?? '') : (node.text ?? '')}
          placeholder={isNote ? 'Add a note…' : isText ? 'Type something…' : undefined}
          spellCheck={false}
          style={editorStyle(node, effectiveHeight >= NOTE_AUTO_MAX_HEIGHT)}
          onInput={isNote || isText ? (event) => growToFit(event.currentTarget) : undefined}
          onBlur={(event) => {
            commit(event.currentTarget.value);
            stopEditing();
          }}
          onKeyDown={(event) => {
            // First, always: the window-level shortcut handler is guarded by `isEditableTarget`,
            // but React Flow's own key bindings (Shift = box selection) are not guarded for a
            // modifier pressed inside an input.
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              // A note keeps what was typed — losing a paragraph of meeting notes to a reflexive
              // Escape is the worse failure. A label reverts, the convention for a rename field.
              if (isNote) commit(event.currentTarget.value);
              // Escape never commits for Text, so `finishTextEdit` is checked against the node's
              // already-committed text, not the discarded textarea value — a never-typed-into
              // Text node Escaped out of still gets cleaned up; real content Escape reverted away
              // from never does, since it's still sitting on the node untouched.
              if (isText) useEditorStore.getState().finishTextEdit(node.id, node.text ?? '');
              stopEditing();
              return;
            }
            // Bold/italic are whole-node toggles, not a rich-text selection format, so they apply
            // without touching editing state or the caret — the same reason there is no inline
            // formatting model to route a text selection through.
            if (isText && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
              event.preventDefault();
              useEditorStore.getState().updateNodeById(node.id, { textBold: !node.textBold }, 'Toggle bold');
              return;
            }
            if (isText && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
              event.preventDefault();
              useEditorStore.getState().updateNodeById(node.id, { textItalic: !node.textItalic }, 'Toggle italic');
              return;
            }
            if (event.key !== 'Enter') return;
            // Enter is a newline in every multi-line editor (code, note, text) — multiline is
            // first-class for Text, not a rare Shift+Enter escape hatch, so it gets the same
            // Cmd/Ctrl+Enter-commits convention Note already uses. A node/service/etc. label is
            // still single-line by convention: it commits on plain Enter and takes Shift+Enter for
            // a rare second line.
            if (isCode) return;
            if (isNote || isText ? !(event.metaKey || event.ctrlKey) : event.shiftKey) return;
            event.preventDefault();
            commit(event.currentTarget.value);
            stopEditing();
          }}
        />
      )}

      {/*
        Handles are rendered in every mode, including presentation. React Flow
        resolves an edge's endpoints through them, so a node without handles
        silently drops all of its connectors. They are hidden with CSS instead.

        Three per side (25%/50%/75%, see `HANDLE_ANCHORS`) rather than one at
        the midpoint — `position` still carries React Flow's own side
        classification, but a handle's precise place *along* that side has no
        equivalent in its `Position` enum, so it's set here via an inline
        percentage instead, layered on top of React Flow's own 50% centering
        transform.

        A Junction (`ellipse`) is a compact routing point, not a component —
        it keeps only the one midpoint anchor per side (offset 0.5) so its
        handles don't visually overwhelm a shape this small.

        A left/right handle sits on the node's anchor band (`anchorBandOf`: a
        queue-family node's tube glyph, the whole side for everything else) in
        pixels, so the dot the user sees is exactly where `edges/routing.ts`
        will land the connector drawn from it.
      */}
      {(node.type === 'ellipse' ? HANDLE_ANCHORS.filter((anchor) => anchor.offset === 0.5) : HANDLE_ANCHORS).map(
        (anchor) => (
          <Handle
            key={anchor.id}
            id={anchor.id}
            type="source"
            position={anchor.position}
            className="dc-handle"
            data-armed={armedAnchorKey === `${anchor.side}:${anchor.offset}` ? 'true' : undefined}
            style={handleStyles.get(anchor.id)}
            isConnectable={!readOnly}
          />
        ),
      )}
    </div>
  );
});

/**
 * The height a note needs for the text currently in its editor, measured from the textarea
 * itself (`scrollHeight` is the browser's own wrap, which is what the user is looking at), or
 * `null` when the box is already tall enough. Grow-only and capped; the one-pixel slack keeps a
 * fractional top inset (the tagged kinds) from rounding into a phantom pixel of growth.
 */
function grownNoteHeight(node: DraftNode, el: HTMLTextAreaElement, current: number): number | null {
  const geo = noteLayout(node);
  const needed = Math.ceil(geo.top + el.scrollHeight + geo.bottom);
  if (needed <= current + 1) return null;
  return Math.min(NOTE_AUTO_MAX_HEIGHT, needed);
}

/** Same idea as `grownNoteHeight`, without a note's padding geometry — a Text editor sits at
 *  `inset: 0` (see `editorStyle`), so the textarea's own `scrollHeight` already is the needed box
 *  height. */
function grownTextHeight(el: HTMLTextAreaElement, current: number): number | null {
  const needed = Math.ceil(el.scrollHeight);
  if (needed <= current + 1) return null;
  return Math.min(TEXT_AUTO_MAX_HEIGHT, needed);
}

/** Chrome, not appearance: the hint sits where the first line of text will, and is never exported. */
function placeholderStyle(node: DraftNode): React.CSSProperties {
  const geo = noteLayout(node);
  return {
    top: geo.top,
    left: geo.left,
    right: geo.right,
    font: cssFont(geo.font),
    lineHeight: `${geo.lineHeight}px`,
  };
}

/**
 * The editor overlays the text it replaces, matching its font and metrics so
 * that committing an edit does not make the text visibly jump.
 */
function editorStyle(node: DraftNode, atGrowthCap: boolean): React.CSSProperties {
  if (node.type === 'code') {
    return {
      font: cssFont(FONTS.code),
      lineHeight: `${FONTS.code.size * LINE_HEIGHTS.code}px`,
      top: CODE_LAYOUT.headerHeight + CODE_LAYOUT.paddingY,
      left: CODE_LAYOUT.paddingX,
      right: 4,
      bottom: 4,
      textAlign: 'left',
    };
  }
  if (node.type === 'note') {
    const geo = noteLayout(node);
    const accent = node.accent ?? NOTE_ACCENTS[node.noteKind ?? 'note'];
    return {
      font: cssFont(geo.font),
      lineHeight: `${geo.lineHeight}px`,
      top: geo.top,
      left: geo.left,
      right: geo.right,
      bottom: geo.bottom,
      textAlign: 'left',
      // The note's own fill (the same token `describe.ts` paints with), so entering edit mode
      // changes nothing but the caret.
      background: `var(--dc-accent-${accent}-fill)`,
      // Hidden until the box stops growing: a scrollbar would narrow the wrap width and reflow
      // the text the moment it appeared.
      overflowY: atGrowthCap ? 'auto' : 'hidden',
    };
  }
  if (node.type === 'text') {
    // Same role/bold/italic resolution `freeText` renders with (`fontForTextNode`), so committing
    // an edit never makes the text visibly jump — and the same `textAlign` value CSS and the SVG
    // shape's `text-anchor` mapping (`TEXT_ALIGN_ANCHOR` in `describe.ts`) both key off.
    const font = fontForTextNode(node);
    return {
      font: cssFont(font),
      lineHeight: `${font.size * LINE_HEIGHTS.body}px`,
      inset: 0,
      textAlign: node.textAlign ?? 'left',
    };
  }
  return {
    font: cssFont(FONTS.nodeLabel),
    lineHeight: `${FONTS.nodeLabel.size * LINE_HEIGHTS.label}px`,
    inset: '4px 10px',
    textAlign: 'center',
  };
}

/** This node's Presentation Mode dimming tier — `hidden` whenever playback is off. */
function explainTierFor(state: EditorStore, id: string): ExplainTier {
  if (!state.flowPlayback.active || !state.flowPlayback.flowId) return 'hidden';
  const flow = state.document.flows.find((f) => f.id === state.flowPlayback.flowId);
  return explainNodeTier(flow, state.document.edges, id, state.flowPlayback.step);
}

/** Whether this node belongs to the selected (not presented) flow's lens —
 *  suppressed whenever Presentation or Focus already own the dimming. */
function lensMemberFor(state: EditorStore, id: string): boolean {
  const flow = lensFlow(state);
  return flow ? lensNodeTier(flow, state.document.edges, id) === 'member' : false;
}

/** A member node's ring colour while lensed, if its flow has one set — mirrors the accent tint
 *  member edges already wear (`DraftEdgeView.tsx`'s `lensAccent`). Undefined (falling back to a
 *  neutral border token in CSS) when the flow has no accent, or the node isn't a member. */
function lensAccentFor(state: EditorStore, theme: Theme, id: string): string | undefined {
  const flow = lensFlow(state);
  if (!flow?.accent) return undefined;
  const isMember = lensNodeTier(flow, state.document.edges, id) === 'member';
  return isMember ? accentOf(theme, flow.accent).chip : undefined;
}

/** Handle positions that never depend on the node's own geometry, built once for every node. */
const STATIC_HANDLE_STYLES: ReadonlyMap<string, CSSProperties> = new Map(
  HANDLE_ANCHORS.map((anchor) => [
    anchor.id,
    anchor.side === 'top' || anchor.side === 'bottom' ? { left: `${anchor.offset * 100}%` } : { top: `${anchor.offset * 100}%` },
  ]),
);

export type { DraftNodeData };
