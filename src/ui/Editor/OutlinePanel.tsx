import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { CommandContext } from '../../commands/types';
import { canvasBounds } from '../../canvas/canvasFrame';
import { centerOf } from '../../lib/math';
import { motionMs } from '../../lib/motion';
import { useEditorStore } from '../../store/editorStore';
import { selectEdge, selectNode } from '../../store/selectors';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { buildOutline, rowKeyForSelection, type OutlineRow } from './outlineModel';

/**
 * The Outline — this view as a list.
 *
 * The canvas is a picture, and a picture is hard to walk with a keyboard or hear through a screen
 * reader. This is the same room as a tree: boundaries holding their members, every shape holding
 * the connectors that touch it, in reading order. It is a view of the selection, both ways — a row
 * chosen here is selected on the canvas (and brought on screen if it was off it), and a shape
 * clicked on the canvas lights its row — and Enter on a row does what Enter does on the canvas:
 * edits the element. Nothing here changes the document except through that one request.
 *
 * ARIA tree with a roving tab stop: one Tab stop for the whole list, arrows to move, Left/Right to
 * fold and unfold. Docked beside the canvas rather than floating over it, so it never covers the
 * shape it just selected.
 */
export function OutlinePanel({ buildCommandContext }: { buildCommandContext: () => CommandContext }) {
  const open = useUiStore((state) => state.outlinePanelOpen);
  const presenting = useEditorStore((state) => state.mode === 'present');
  if (!open || presenting) return null;
  return (
    <aside className="dc-outline" role="complementary" aria-label="Outline" data-dc-keyboard-region="">
      <div className="dc-outline-header">
        <strong className="dc-outline-title">Outline</strong>
        <Button variant="quiet" icon="close" aria-label="Close outline" onClick={() => useUiStore.getState().setOutlinePanelOpen(false)} />
      </div>
      <OutlineTree buildCommandContext={buildCommandContext} />
    </aside>
  );
}

function focusCanvas(): void {
  document.querySelector<HTMLElement>('.dc-canvas')?.focus();
}

function OutlineTree({ buildCommandContext }: { buildCommandContext: () => CommandContext }) {
  const room = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const rows = useMemo(() => buildOutline(room), [room]);
  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const treeRef = useRef<HTMLUListElement>(null);
  const { flowToScreenPosition, setCenter, getZoom } = useReactFlow();

  const hidden = useCallback(
    (row: OutlineRow): boolean => {
      for (let parent = row.parentKey; parent; parent = byKey.get(parent)?.parentKey ?? null) {
        if (collapsed.has(parent)) return true;
      }
      return false;
    },
    [byKey, collapsed],
  );
  const visible = useMemo(() => rows.filter((row) => !hidden(row)), [rows, hidden]);

  // The roving tab stop. It follows the canvas selection whenever that changes — a shape clicked on
  // the canvas is the one Tab then lands on — and otherwise stays where the arrows last put it.
  const [activeKey, setActiveKey] = useState<string | null>(() => rowKeyForSelection(selection, rows));
  const selectedKey = useMemo(() => rowKeyForSelection(selection, rows, activeKey), [selection, rows, activeKey]);
  // Adjusted during render, React's own pattern for state that follows a prop: the canvas selection
  // moved, so the stop moves with it — and whatever folded the row away unfolds, since a row the
  // canvas just selected must be reachable and visible.
  const [followed, setFollowed] = useState(selectedKey);
  if (selectedKey !== followed) {
    setFollowed(selectedKey);
    if (selectedKey) {
      setActiveKey(selectedKey);
      const row = byKey.get(selectedKey);
      if (row && hidden(row)) {
        const next = new Set(collapsed);
        for (let parent = row.parentKey; parent; parent = byKey.get(parent)?.parentKey ?? null) next.delete(parent);
        setCollapsed(next);
      }
    }
  }
  const current = activeKey && byKey.has(activeKey) && !hidden(byKey.get(activeKey)!) ? activeKey : (visible[0]?.key ?? null);

  // Keep the selected row in view as the canvas selection moves — nearest edge, never a jump.
  useEffect(() => {
    if (!selectedKey) return;
    treeRef.current?.querySelector<HTMLElement>(`[data-outline-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey, visible]);

  const focusRow = useCallback((key: string) => {
    setActiveKey(key);
    treeRef.current?.querySelector<HTMLElement>(`[data-outline-key="${CSS.escape(key)}"]`)?.focus();
  }, []);

  /** Selects the row's element on the canvas and pans it on screen if it was off it — never zooms. */
  const select = useCallback(
    (row: OutlineRow) => {
      const editor = useEditorStore.getState();
      let center: { x: number; y: number } | null = null;
      if (row.kind === 'node') {
        const node = selectNode(editor.document, row.id);
        if (!node) return;
        editor.setSelection({ nodes: [row.id], edges: [] });
        center = centerOf(node);
      } else {
        const edge = selectEdge(editor.document, row.id);
        if (!edge) return;
        editor.setSelection({ nodes: [], edges: [row.id] });
        const source = selectNode(editor.document, edge.source);
        const target = selectNode(editor.document, edge.target);
        if (source && target) {
          const a = centerOf(source);
          const b = centerOf(target);
          center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        }
      }
      if (!center) return;
      const screen = flowToScreenPosition(center);
      const margin = 96;
      const { right, bottom } = canvasBounds();
      const left = document.querySelector('.dc-editor-canvas')?.getBoundingClientRect().left ?? 0;
      const onScreen = screen.x > left + margin && screen.x < right - margin && screen.y > margin && screen.y < bottom - margin;
      if (!onScreen) void setCenter(center.x, center.y, { zoom: getZoom(), duration: motionMs(200) });
    },
    [flowToScreenPosition, getZoom, setCenter],
  );

  const toggle = useCallback((key: string, open?: boolean) => {
    setCollapsed((currentSet) => {
      const next = new Set(currentSet);
      const shouldOpen = open ?? next.has(key);
      if (shouldOpen) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const edit = useCallback(
    (row: OutlineRow) => {
      select(row);
      buildCommandContext().ui.requestEdit(row.id);
    },
    [buildCommandContext, select],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!current) return;
    const row = byKey.get(current);
    if (!row) return;
    const index = visible.findIndex((candidate) => candidate.key === current);
    const go = (target: OutlineRow | undefined) => {
      if (!target) return;
      focusRow(target.key);
      select(target);
    };
    switch (event.key) {
      case 'ArrowDown':
        go(visible[index + 1]);
        break;
      case 'ArrowUp':
        go(visible[index - 1]);
        break;
      case 'Home':
        go(visible[0]);
        break;
      case 'End':
        go(visible.at(-1));
        break;
      case 'ArrowRight':
        if (row.childKeys.length === 0) break;
        if (collapsed.has(row.key)) toggle(row.key, true);
        else go(byKey.get(row.childKeys[0]!));
        break;
      case 'ArrowLeft':
        if (row.childKeys.length > 0 && !collapsed.has(row.key)) toggle(row.key, false);
        else if (row.parentKey) go(byKey.get(row.parentKey));
        break;
      case 'Enter':
        edit(row);
        break;
      case ' ':
        select(row);
        break;
      case 'Escape':
        useUiStore.getState().setOutlinePanelOpen(false);
        focusCanvas();
        break;
      default:
        return;
    }
    // Claimed here, so the window handler never also nudges the selection or drops a shape.
    event.preventDefault();
    event.stopPropagation();
  };

  if (rows.length === 0) {
    return <p className="dc-outline-empty dc-muted">Nothing in this view yet. Shapes appear here as they are added.</p>;
  }

  const selectedIds = new Set([...selection.nodes, ...selection.edges]);

  const renderRow = (row: OutlineRow) => {
    const isCollapsed = collapsed.has(row.key);
    const hasChildren = row.childKeys.length > 0;
    const onClick = (event: MouseEvent) => {
      event.stopPropagation();
      focusRow(row.key);
      select(row);
    };
    const onDoubleClick = (event: MouseEvent) => {
      event.stopPropagation();
      edit(row);
    };
    return (
      <li
        key={row.key}
        role="treeitem"
        aria-level={row.depth}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        aria-selected={selectedIds.has(row.id)}
        aria-label={row.reading}
        tabIndex={row.key === current ? 0 : -1}
        className="dc-outline-item"
        data-outline-key={row.key}
        data-kind={row.kind}
        data-selected={selectedIds.has(row.id) ? 'true' : undefined}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        <div className="dc-outline-row" style={{ paddingLeft: 4 + (row.depth - 1) * 14 }}>
          <span
            className="dc-outline-twisty"
            aria-hidden="true"
            data-foldable={hasChildren ? 'true' : undefined}
            onClick={
              hasChildren
                ? (event) => {
                    event.stopPropagation();
                    toggle(row.key);
                  }
                : undefined
            }
          >
            {hasChildren && <Icon name={isCollapsed ? 'forward' : 'down'} size={10} />}
          </span>
          {row.direction && (
            <span className="dc-outline-arrow" aria-hidden="true">
              {row.direction === 'out' ? '→' : row.direction === 'in' ? '←' : '—'}
            </span>
          )}
          <span className="dc-outline-name">{row.label}</span>
          {row.detail && <span className="dc-outline-detail">{row.detail}</span>}
        </div>
        {hasChildren && !isCollapsed && (
          <ul role="group" className="dc-outline-group">
            {row.childKeys.map((key) => byKey.get(key)).map((child) => child && renderRow(child))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="dc-outline-scroll">
      <ul ref={treeRef} role="tree" aria-label="Shapes and connectors in this view" className="dc-outline-tree" onKeyDown={onKeyDown}>
        {rows.filter((row) => row.parentKey === null).map(renderRow)}
      </ul>
    </div>
  );
}
