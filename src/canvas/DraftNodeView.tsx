import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, NodeResizer, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { CODE_LAYOUT, describeContext, describeNode } from '../nodes/describe';
import { HANDLE_SIDES, positionForSide } from '../edges/routing';
import { beginClipScope, emitDisplayList } from '../render/svg/emit';
import { FONTS, LINE_HEIGHTS, cssFont } from '../render/text/fonts';
import { useEditorStore, type EditorStore } from '../store/editorStore';
import { edgeIndex, selectNode } from '../store/selectors';
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
export const DraftNodeView = memo(function DraftNodeView({ id, selected }: NodeProps) {
  const node = useEditorStore((state) => selectNode(state.document, id));
  const mode = useEditorStore((state) => state.mode);
  // A boolean, not an object: the selector runs for every node on every store
  // change, and only the two nodes whose value actually flips re-render.
  const explainActive = useEditorStore((state) => isExplainEndpoint(state, id));
  const updateNodeText = useEditorStore((state) => state.updateNodeText);
  const updateNodeById = useEditorStore((state) => state.updateNodeById);
  const theme = useThemeValue();
  const updateNodeInternals = useUpdateNodeInternals();

  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  // Handles move with the node's size, so React Flow has to re-measure them.
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, node?.width, node?.height, updateNodeInternals]);

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
  const shapes = (() => {
    beginClipScope(node.id);
    return emitDisplayList(describeNode(node, describeContext(theme)));
  })();

  const beginEditing = () => {
    if (readOnly) return;
    setEditing(true);
  };

  const commit = (value: string) => {
    if (isCode) {
      if (value !== (node.code ?? '')) {
        updateNodeById(node.id, { code: value }, 'Edit code');
      }
    } else if (value !== (node.text ?? '')) {
      updateNodeText(node.id, value);
    }
  };

  return (
    <div
      className="dc-node"
      data-type={node.type}
      data-selected={selected ? 'true' : undefined}
      data-explain-active={explainActive ? 'true' : undefined}
      data-editing={editing ? 'true' : undefined}
      style={{ width: node.width, height: node.height }}
      onDoubleClick={beginEditing}
    >
      {!readOnly && (
        <NodeResizer
          isVisible={Boolean(selected)}
          minWidth={48}
          minHeight={32}
          lineClassName="dc-resize-line"
          handleClassName="dc-resize-handle"
        />
      )}

      <SvgSurface className="dc-node-surface" width={node.width} height={node.height}>
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

/** True when this node is either end of the step currently being explained. */
function isExplainEndpoint(state: EditorStore, id: string): boolean {
  if (!state.explain.active) return false;
  for (const edge of edgeIndex(state.document.edges).values()) {
    if (edge.sequence === state.explain.step) {
      return edge.source === id || edge.target === id;
    }
  }
  return false;
}

export type { DraftNodeData };
