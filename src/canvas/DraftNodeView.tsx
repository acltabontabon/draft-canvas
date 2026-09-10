import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Handle, NodeResizer, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { maxSizeFor, minSizeFor } from '../document/factory';
import { explainNodeTier, lensNodeTier, type ExplainTier } from '../document/flow';
import type { DraftNode } from '../document/types';
import { CODE_LAYOUT, describeContext, describeNode, naturalCodeSize } from '../nodes/describe';
import { HANDLE_ANCHORS } from '../edges/routing';
import { beginClipScope, emitDisplayList } from '../render/svg/emit';
import { FONTS, LINE_HEIGHTS, cssFont } from '../render/text/fonts';
import { lensFlow, useEditorStore, type EditorStore } from '../store/editorStore';
import { accentOf, type Theme } from '../render/theme/tokens';
import { edgeIndex, selectNode } from '../store/selectors';
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
  const [resizing, setResizing] = useState(false);
  const [copied, setCopied] = useState(false);
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
    // oxlint-disable-next-line set-state-in-effect -- one-shot external command, see comment above.
    if (mode !== 'present') setEditing(true);
  }, [editRequested, mode]);

  useLayoutEffect(() => {
    if (!editing) return;
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  const stopEditing = useCallback(() => setEditing(false), []);

  /**
   * React Flow updates `width`/`height` on this node live, once per frame,
   * while `NodeResizer` is dragging — that live value is what must drive the
   * visible content. Reading `node.width/height` from the committed document
   * here instead is the bug this fixes: the store is only written once the
   * gesture ends, so the content would stay frozen at the old size for the
   * whole drag and jump on release.
   */
  const effectiveWidth = Math.round(width ?? node?.width ?? 0);
  const effectiveHeight = Math.round(height ?? node?.height ?? 0);
  const liveNode: DraftNode | null = !node
    ? null
    : effectiveWidth === node.width && effectiveHeight === node.height
      ? node
      : { ...node, width: effectiveWidth, height: effectiveHeight };

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
  const shapes = useMemo(() => {
    if (!liveNode) return [];
    beginClipScope(liveNode.id);
    return emitDisplayList(describeNode(liveNode, describeContext(theme, preset)));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see comment above.
  }, [liveNode, theme, preset]);

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

  if (!node) return null;

  const isCode = node.type === 'code';

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
    } else if (value !== (node.text ?? '')) {
      updateNodeText(node.id, value);
    }
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

      {editing && (
        <textarea
          ref={editorRef}
          className={isCode ? 'dc-node-editor dc-node-editor-code' : 'dc-node-editor'}
          defaultValue={isCode ? (node.code ?? '') : (node.text ?? '')}
          spellCheck={false}
          style={editorStyle(node.type, isCode)}
          onBlur={(event) => {
            commit(event.currentTarget.value);
            stopEditing();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              stopEditing();
              return;
            }
            // Plain Enter commits a label; code cards need it for new lines.
            if (event.key === 'Enter' && !event.shiftKey && !isCode) {
              event.preventDefault();
              commit(event.currentTarget.value);
              stopEditing();
            }
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
            style={
              anchor.side === 'top' || anchor.side === 'bottom'
                ? { left: `${anchor.offset * 100}%` }
                : { top: `${anchor.offset * 100}%` }
            }
            isConnectable={!readOnly}
          />
        ),
      )}
    </div>
  );
});

/**
 * The editor overlays the text it replaces, matching its font and metrics so
 * that committing an edit does not make the text visibly jump.
 */
function editorStyle(type: string, isCode: boolean): React.CSSProperties {
  if (isCode) {
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
  if (type === 'note') {
    return {
      font: cssFont(FONTS.noteBody),
      lineHeight: `${FONTS.noteBody.size * LINE_HEIGHTS.body}px`,
      top: 26,
      left: 13,
      right: 10,
      bottom: 6,
      textAlign: 'left',
    };
  }
  if (type === 'text') {
    return {
      font: cssFont(FONTS.freeText),
      lineHeight: `${FONTS.freeText.size * LINE_HEIGHTS.body}px`,
      inset: 0,
      textAlign: 'left',
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
  return explainNodeTier(flow, edgeIndex(state.document.edges).values(), id, state.flowPlayback.step);
}

/** Whether this node belongs to the selected (not presented) flow's lens —
 *  suppressed whenever Presentation or Focus already own the dimming. */
function lensMemberFor(state: EditorStore, id: string): boolean {
  const flow = lensFlow(state);
  return flow ? lensNodeTier(flow, edgeIndex(state.document.edges).values(), id) === 'member' : false;
}

/** A member node's ring colour while lensed, if its flow has one set — mirrors the accent tint
 *  member edges already wear (`DraftEdgeView.tsx`'s `lensAccent`). Undefined (falling back to a
 *  neutral border token in CSS) when the flow has no accent, or the node isn't a member. */
function lensAccentFor(state: EditorStore, theme: Theme, id: string): string | undefined {
  const flow = lensFlow(state);
  if (!flow?.accent) return undefined;
  const isMember = lensNodeTier(flow, edgeIndex(state.document.edges).values(), id) === 'member';
  return isMember ? accentOf(theme, flow.accent).chip : undefined;
}

export type { DraftNodeData };
