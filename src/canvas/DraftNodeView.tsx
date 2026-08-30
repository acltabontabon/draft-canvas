import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, NodeResizer, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { minSizeFor } from '../document/factory';
import { explainNodeTier, type ExplainTier } from '../document/sequence';
import type { DraftNode } from '../document/types';
import { CODE_LAYOUT, describeContext, describeNode, naturalCodeSize } from '../nodes/describe';
import { HANDLE_SIDES, positionForSide } from '../edges/routing';
import { beginClipScope, emitDisplayList } from '../render/svg/emit';
import { FONTS, LINE_HEIGHTS, cssFont } from '../render/text/fonts';
import { useEditorStore, type EditorStore } from '../store/editorStore';
import { edgeIndex, selectNode } from '../store/selectors';
import { useUiStore } from '../store/uiStore';
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
  const updateNodeText = useEditorStore((state) => state.updateNodeText);
  const updateNodeById = useEditorStore((state) => state.updateNodeById);
  const theme = useThemeValue();
  const updateNodeInternals = useUpdateNodeInternals();
  // A boolean, not the id itself: every node's selector runs on every drag
  // frame, so only the two nodes whose armed state actually flips re-render.
  const isAttachTarget = useUiStore((state) => state.attachArmedTarget === id);
  const setOpenAttachmentPopover = useUiStore((state) => state.setOpenAttachmentPopover);
  const popoverOpen = useUiStore((state) => state.openAttachmentPopover === id);
  const editRequested = useUiStore((state) => state.editRequestId === id);

  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const [copied, setCopied] = useState(false);

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

  if (!node) return null;

  const isCode = node.type === 'code';
  const readOnly = mode === 'present';

  /**
   * React Flow updates `width`/`height` on this node live, once per frame,
   * while `NodeResizer` is dragging — that live value is what must drive the
   * visible content. Reading `node.width/height` from the committed document
   * here instead is the bug this fixes: the store is only written once the
   * gesture ends, so the content would stay frozen at the old size for the
   * whole drag and jump on release.
   */
  const effectiveWidth = Math.round(width ?? node.width);
  const effectiveHeight = Math.round(height ?? node.height);
  const liveNode: DraftNode =
    effectiveWidth === node.width && effectiveHeight === node.height
      ? node
      : { ...node, width: effectiveWidth, height: effectiveHeight };

  const shapes = (() => {
    beginClipScope(node.id);
    return emitDisplayList(describeNode(liveNode, describeContext(theme)));
  })();

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
  const attachmentCount = node.attachments?.length ?? 0;

  return (
    <div
      className="dc-node"
      data-type={node.type}
      data-selected={selected ? 'true' : undefined}
      data-explain-active={explainTier === 'active' ? 'true' : undefined}
      data-explain-shown={explainTier === 'shown' ? 'true' : undefined}
      data-focused={focused ? 'true' : undefined}
      data-editing={editing ? 'true' : undefined}
      data-attach-target={isAttachTarget ? 'true' : undefined}
      style={{ width: effectiveWidth, height: effectiveHeight }}
      onDoubleClick={beginEditing}
    >
      {!readOnly && (
        <NodeResizer
          isVisible={Boolean(selected)}
          minWidth={min.width}
          minHeight={min.height}
          lineClassName="dc-resize-line"
          handleClassName="dc-resize-handle"
          onResizeStart={() => {
            useEditorStore.getState().beginInteraction('Resize');
            setResizing(true);
          }}
          onResizeEnd={() => {
            useEditorStore.getState().endInteraction();
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
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
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
            setOpenAttachmentPopover(popoverOpen ? null : node.id);
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
      */}
      {HANDLE_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={positionForSide(side)}
          className="dc-handle"
          isConnectable={!readOnly}
        />
      ))}
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

/** This node's Explain Mode dimming tier — `hidden` whenever Explain is off. */
function explainTierFor(state: EditorStore, id: string): ExplainTier {
  if (!state.explain.active) return 'hidden';
  return explainNodeTier(edgeIndex(state.document.edges).values(), id, state.explain.step);
}

export type { DraftNodeData };
