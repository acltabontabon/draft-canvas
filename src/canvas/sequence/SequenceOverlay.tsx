import { memo, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { findItem, itemsAt, sequenceOf, type SeqSlot } from '../../document/sequenceModel';
import type { DraftNode, SeqItem } from '../../document/types';
import { moveProblem } from '../../sequence/check';
import { itemRange, type SequenceEditTarget, type SequenceFocus } from '../../sequence/focus';
import {
  columnNear,
  hitSequence,
  participantGapX,
  participantIndexAt,
  slotAt,
  slotFor,
  type Rect,
  type SequenceLayout,
  type SlotLayout,
} from '../../sequence/layout';
import { nextFor } from '../../sequence/suggest';
import { sequenceActions } from '../../store/sequenceActions';
import { useUiStore } from '../../store/uiStore';
import { SequenceEditors } from './SequenceEditors';
import './sequence.css';

/**
 * The hands of a sequence: everything that can be taken hold of inside one.
 *
 * The picture itself is the display list (`nodes/sequence.ts`), the same one an export draws. This
 * sits over it and adds nothing to it but what a person is doing right now — what is selected, where
 * a message being drawn would land, the field being typed into. It is laid out from the very same
 * geometry, so a target is always exactly over the thing it is for.
 *
 * Mounted only while the sequence is under the pointer, selected or being dropped onto: a diagram
 * with a dozen sequences in it carries none of this for the eleven nobody is touching.
 *
 * Nothing here moves the sequence. Pressing on a participant, a message or a lifeline starts
 * something of the sequence's own (`nodrag`); pressing anywhere else on it moves the whole shape,
 * as with any other.
 */

type Held =
  | { what: 'lifeline'; id: string }
  | { what: 'item'; id: string }
  | { what: 'participant'; id: string };

type Gesture =
  /** A message being drawn from a lifeline. `to` is null past the last lifeline: a new participant. */
  | { kind: 'draw'; from: string; to: string | null; slot: SlotLayout | null; x: number }
  /** A message, note or fragment being moved to another place in the order. */
  | { kind: 'item'; id: string; slot: SlotLayout | null; problem: string | null }
  /** A participant being moved along the row. */
  | { kind: 'participant'; id: string; index: number; x: number };

const DRAG_THRESHOLD_PX = 4;
/** Past the last head by this much, a message is being drawn to someone new. */
const NEW_PARTICIPANT_REACH = 44;

const box = (rect: Rect, grow = 0): CSSProperties => ({ left: rect.x - grow, top: rect.y - grow, width: rect.w + grow * 2, height: rect.h + grow * 2 });

interface Props {
  node: DraftNode;
  layout: SequenceLayout;
  readOnly: boolean;
  selected: boolean;
}

export const SequenceOverlay = memo(function SequenceOverlay({ node, layout, readOnly, selected }: Props) {
  const nodeId = node.id;
  const sequence = sequenceOf(node);
  const focus = useUiStore((state) => (state.sequenceFocus?.nodeId === nodeId ? state.sequenceFocus : null));
  const editing = useUiStore((state) => (state.sequenceEdit?.nodeId === nodeId ? state.sequenceEdit.target : null));
  const dropIndex = useUiStore((state) => (state.sequenceDropTarget?.nodeId === nodeId ? state.sequenceDropTarget.index : null));

  const rootRef = useRef<HTMLDivElement>(null);
  const held = useRef<(Held & { x: number; y: number }) | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  /** The click that follows a drag belongs to the drag: it selects nothing. */
  const dragged = useRef(false);
  /** Where a shift-click's range starts. */
  const anchor = useRef<string | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<{ participantId: string; slot: SlotLayout } | null>(null);

  const setGesture = (next: Gesture | null) => {
    gestureRef.current = next;
    setGestureState(next);
  };

  /** A pointer position in the sequence's own coordinates, whatever the canvas is zoomed to. */
  const local = (clientX: number, clientY: number): { x: number; y: number } => {
    const root = rootRef.current;
    if (!root) return { x: 0, y: 0 };
    const rect = root.getBoundingClientRect();
    const scale = rect.width / Math.max(1, node.width) || 1;
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };

  const end = () => {
    held.current = null;
    if (gestureRef.current) {
      setGesture(null);
      useUiStore.getState().setInteractionActive(false);
    }
  };

  // Escape lets go of whatever is being dragged, and so does the sequence going away mid-drag.
  useEffect(() => {
    if (!gesture) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      dragged.current = true;
      end();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `end` only touches refs and the store.
  }, [gesture !== null]);
  useEffect(
    () => () => {
      if (gestureRef.current) useUiStore.getState().setInteractionActive(false);
    },
    [],
  );

  /* ------------------------------------------------------------------ gestures -- */

  const press = (event: PointerEvent<HTMLElement>, what: Held) => {
    if (readOnly || event.button !== 0 || editing) return;
    held.current = { ...what, x: event.clientX, y: event.clientY };
    dragged.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const track = (event: PointerEvent<HTMLElement>) => {
    const start = held.current;
    if (!start) return;
    if (!gestureRef.current && Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD_PX) return;
    // A menu opened under a long press: the press was for the menu.
    if (useUiStore.getState().contextMenu) return end();
    if (!gestureRef.current) {
      useUiStore.getState().setInteractionActive(true);
      setHover(null);
    }
    const point = local(event.clientX, event.clientY);
    if (start.what === 'lifeline') {
      const last = layout.columns[layout.columns.length - 1];
      const beyond = !!last && point.x > last.head.x + last.head.w + NEW_PARTICIPANT_REACH;
      setGesture({ kind: 'draw', from: start.id, to: beyond ? null : (columnNear(layout, point.x)?.id ?? start.id), slot: slotAt(layout, point.x, point.y), x: point.x });
    } else if (start.what === 'item') {
      let slot = slotAt(layout, point.x, point.y);
      const moving = findItem(sequence, start.id)?.item;
      // Not into itself, and not to where it already is.
      if (slot && moving && slot.operandId !== null && moving.t === 'fragment' && holds(moving, slot.operandId)) slot = null;
      const at = findItem(sequence, start.id)?.at;
      if (slot && at && (at.operand?.id ?? null) === slot.operandId && (slot.index === at.index || slot.index === at.index + 1)) slot = null;
      setGesture({ kind: 'item', id: start.id, slot, problem: slot ? moveProblem(sequence, start.id, { operandId: slot.operandId, index: slot.index }) : null });
    } else {
      setGesture({ kind: 'participant', id: start.id, index: participantIndexAt(layout, point.x), x: point.x });
    }
  };

  const release = (event: PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const done = gestureRef.current;
    if (!done) {
      held.current = null;
      return;
    }
    dragged.current = true;
    end();
    if (done.kind === 'draw') {
      if (!done.slot) return;
      const slot: SeqSlot = { operandId: done.slot.operandId, index: done.slot.index };
      if (done.to === null) {
        sequenceActions.edit(nodeId, { kind: 'new-participant', index: sequence.participants.length, message: { from: done.from, slot } });
      } else {
        sequenceActions.addMessage(nodeId, { from: done.from, to: done.to }, slot);
      }
    } else if (done.kind === 'item') {
      if (!done.slot) return;
      if (done.problem) useUiStore.getState().notify(done.problem);
      else sequenceActions.moveItem(nodeId, done.id, { operandId: done.slot.operandId, index: done.slot.index });
    } else {
      const from = sequence.participants.findIndex((participant) => participant.id === done.id);
      const to = done.index > from ? done.index - 1 : done.index;
      if (from >= 0 && to !== from) sequenceActions.moveParticipant(nodeId, done.id, to);
    }
  };

  const gestures = (what: Held) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => press(event, what),
    onPointerMove: track,
    onPointerUp: release,
    onPointerCancel: end,
    onLostPointerCapture: () => {
      if (gestureRef.current) end();
    },
  });

  /* ----------------------------------------------------------------- selecting -- */

  const pick = (event: MouseEvent, kind: SequenceFocus['kind'], id: string) => {
    event.stopPropagation();
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    let ids = [id];
    if (kind === 'item' && event.shiftKey && focus?.kind === 'item' && anchor.current) {
      ids = itemRange(sequence, anchor.current, id);
    } else if (kind === 'participant' && (event.shiftKey || event.metaKey || event.ctrlKey) && focus?.kind === 'participant') {
      ids = focus.ids.includes(id) ? focus.ids.filter((other) => other !== id) : [...focus.ids, id];
    } else {
      anchor.current = kind === 'item' ? id : null;
    }
    sequenceActions.select(nodeId, kind, ids);
  };

  const open = (event: MouseEvent, target: SequenceEditTarget) => {
    event.stopPropagation();
    if (readOnly) return;
    sequenceActions.edit(nodeId, target);
  };

  /** A right-click on something not yet selected selects it first; the menu is then about it. */
  const menu = (kind: SequenceFocus['kind'], id: string) => () => {
    if (!(focus?.kind === kind && focus.ids.includes(id))) sequenceActions.select(nodeId, kind, [id]);
  };

  const targetProps = (kind: SequenceFocus['kind'], id: string, edit: SequenceEditTarget | null) => ({
    onClick: (event: MouseEvent) => pick(event, kind, id),
    onDoubleClick: (event: MouseEvent) => (edit ? open(event, edit) : event.stopPropagation()),
    onContextMenu: menu(kind, id),
  });

  const isFocused = (kind: SequenceFocus['kind'], id: string): boolean => focus?.kind === kind && focus.ids.includes(id);
  const nameOf = (participantId: string): string => sequence.participants.find((participant) => participant.id === participantId)?.name.trim() || 'Unnamed participant';

  /* ------------------------------------------------------------------- drawing -- */

  const columnX = (id: string | null): number | null => layout.columns.find((column) => column.id === id)?.x ?? null;

  // What usually comes next, offered as a ghost where it would go: Tab takes it, ] and [ turn it
  // over. Only at the end of a list, where there is room for it and "next" means something.
  const ghostIndex = useUiStore((state) => state.sequenceGhost);
  const ghostsOn = useUiStore((state) => state.continuationsEnabled);
  const offers = !readOnly && ghostsOn && focus && !gesture && !editing ? nextFor(sequence, focus) : [];
  const offer = offers.length > 0 ? offers[ghostIndex % offers.length]! : null;
  const offerSlot = offer && (itemsAt(sequence, offer.slot.operandId)?.length ?? -1) === offer.slot.index ? slotFor(layout, offer.slot.operandId, offer.slot.index) : null;
  const heads = layout.columns.filter((column) => !column.created);
  const headRowMiddle = heads.length > 0 ? Math.max(...heads.map((column) => column.head.y + column.head.h)) - 22 : layout.bodyTop;
  const quiet = gesture !== null || editing !== null;

  return (
    <div
      ref={rootRef}
      className="dc-seq-overlay"
      data-selected={selected ? 'true' : undefined}
      data-dragging={gesture ? gesture.kind : undefined}
      style={{ width: node.width, height: node.height }}
    >
      {/* Groups: their caption is the handle. */}
      {layout.groups.map((group) => (
        <div
          key={group.id}
          className="dc-seq-target dc-seq-group nodrag nopan"
          data-focused={isFocused('group', group.id) ? 'true' : undefined}
          role="button"
          aria-label={`Group ${sequence.groups?.find((entry) => entry.id === group.id)?.name || 'unnamed'}`}
          style={{ left: group.box.x, top: group.box.y, width: group.box.w, height: 18 }}
          {...targetProps('group', group.id, { kind: 'group', id: group.id })}
        />
      ))}

      {/* Fragments: the tab, and the frame's own line. Their middle belongs to what they hold. */}
      {layout.fragments.map((frame) => (
        <div key={frame.id} className="dc-seq-frame" data-focused={isFocused('item', frame.id) ? 'true' : undefined} style={box(frame.box)}>
          <div
            className="dc-seq-target dc-seq-frame-tab nodrag nopan"
            role="button"
            aria-label={`${frame.operator} fragment`}
            style={{ left: 0, top: 0, width: frame.tab.w, height: frame.tab.h }}
            {...targetProps('item', frame.id, frame.operator === 'ref' ? { kind: 'reference', id: frame.id } : null)}
            {...gestures({ what: 'item', id: frame.id })}
          />
          {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
            <div key={side} className="dc-seq-target dc-seq-frame-edge nodrag nopan" data-side={side} {...targetProps('item', frame.id, null)} />
          ))}
          {frame.operator === 'ref' && (
            <div
              className="dc-seq-target nodrag nopan"
              style={{ left: 0, top: frame.tab.h, width: frame.box.w, height: frame.box.h - frame.tab.h }}
              {...targetProps('item', frame.id, { kind: 'reference', id: frame.id })}
              {...gestures({ what: 'item', id: frame.id })}
            />
          )}
          {frame.operands.map((branch, at) => {
            const top = at === 0 ? 0 : (branch.separatorY ?? frame.box.y) - frame.box.y;
            const left = at === 0 ? frame.tab.w : 0;
            return (
              <div
                key={branch.id}
                className="dc-seq-target dc-seq-branch nodrag nopan"
                data-focused={isFocused('operand', branch.id) ? 'true' : undefined}
                role="button"
                aria-label={branch.guard ? `Branch ${branch.guard.layout.lines.map((line) => line.text).join(' ')}` : 'Branch'}
                style={{ left, top, width: frame.box.w - left, height: at === 0 ? frame.tab.h + 4 : 20 }}
                {...targetProps('operand', branch.id, { kind: 'guard', id: branch.id })}
              />
            );
          })}
        </div>
      ))}

      {/* Messages and notes. */}
      {layout.messages.map((message) => (
        <div
          key={message.id}
          className="dc-seq-target dc-seq-message nodrag nopan"
          data-focused={isFocused('item', message.id) ? 'true' : undefined}
          data-moving={gesture?.kind === 'item' && gesture.id === message.id ? 'true' : undefined}
          role="button"
          aria-label={`Message from ${nameOf(message.from)} to ${nameOf(message.to)}${message.label ? `: ${message.label.layout.lines.map((line) => line.text).join(' ')}` : ''}`}
          style={box(message.box, 3)}
          {...targetProps('item', message.id, { kind: 'message', id: message.id })}
          {...gestures({ what: 'item', id: message.id })}
        />
      ))}
      {layout.notes.map((note) => (
        <div
          key={note.id}
          className="dc-seq-target dc-seq-note nodrag nopan"
          data-focused={isFocused('item', note.id) ? 'true' : undefined}
          role="button"
          aria-label="Note"
          style={box(note.box)}
          {...targetProps('item', note.id, { kind: 'note', id: note.id })}
          {...gestures({ what: 'item', id: note.id })}
        />
      ))}

      {/* Lifelines, above the messages that cross them: a drag from one starts a message. */}
      {!readOnly &&
        layout.columns.map((column) => (
          <div
            key={column.id}
            className="dc-seq-lifeline nodrag nopan"
            style={{ left: column.x - 7, top: column.lifeTop, width: 14, height: Math.max(0, column.lifeBottom - column.lifeTop) }}
            onPointerMove={(event) => {
              if (held.current) return track(event);
              const point = local(event.clientX, event.clientY);
              const slot = slotAt(layout, column.x, point.y);
              if (slot && !(hover?.participantId === column.id && hover.slot === slot)) setHover({ participantId: column.id, slot });
            }}
            onPointerLeave={() => setHover(null)}
            onPointerDown={(event) => press(event, { what: 'lifeline', id: column.id })}
            onPointerUp={release}
            onPointerCancel={end}
            onClick={(event) => {
              // A click with no drag selects whatever the lifeline was pressed through.
              const point = local(event.clientX, event.clientY);
              const under = hitSequence(layout, point.x, point.y);
              if (under.kind === 'message' || under.kind === 'note') pick(event, 'item', under.id);
              else pick(event, 'participant', column.id);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            onContextMenu={menu('participant', column.id)}
          />
        ))}

      {/* Heads. */}
      {layout.columns.map((column) => (
        <div
          key={column.id}
          className="dc-seq-target dc-seq-head nodrag nopan"
          data-focused={isFocused('participant', column.id) ? 'true' : undefined}
          data-moving={gesture?.kind === 'participant' && gesture.id === column.id ? 'true' : undefined}
          role="button"
          aria-label={`Participant ${nameOf(column.id)}`}
          style={box(column.head, 2)}
          {...targetProps('participant', column.id, { kind: 'participant', id: column.id })}
          {...gestures({ what: 'participant', id: column.id })}
        />
      ))}

      {/* A place to add a participant: between any two, and at either end. */}
      {!readOnly && !quiet && layout.columns.length > 0 &&
        Array.from({ length: layout.columns.length + 1 }, (_, index) => (
          <button
            key={index}
            type="button"
            className="dc-seq-add nodrag nopan"
            aria-label={index === layout.columns.length ? 'Add a participant at the end' : `Add a participant before ${nameOf(layout.columns[index]!.id)}`}
            title="Add a participant"
            style={{ left: participantGapX(layout, index) - 9, top: headRowMiddle - 9 }}
            onClick={(event) => open(event, { kind: 'new-participant', index })}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        ))}
      {!readOnly && !quiet && layout.columns.length === 0 && (
        <button
          type="button"
          className="dc-seq-empty nodrag nopan"
          style={{ left: node.width / 2, top: Math.max(node.height / 2, layout.bodyTop + 30) }}
          onClick={(event) => open(event, { kind: 'new-participant', index: 0 })}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          Add a participant
        </button>
      )}

      {/* Where a message started from here would go. */}
      {hover && !quiet && (
        <span className="dc-seq-dot" style={{ left: columnX(hover.participantId) ?? 0, top: hover.slot.y }} aria-hidden="true" />
      )}

      {offer && offerSlot && (
        <>
          <DrawPreview ghost from={columnX(offer.from) ?? 0} to={columnX(offer.to) ?? 0} self={offer.from === offer.to} fresh={false} y={offerSlot.y + 6} width={node.width} height={node.height} />
          <span className="dc-seq-ghost-hint" style={{ left: ((columnX(offer.from) ?? 0) + (columnX(offer.to) ?? 0)) / 2 + (offer.from === offer.to ? 44 : 0), top: offerSlot.y + 14 }}>
            <kbd>Tab</kbd>
            {offer.title}
            {offers.length > 1 && <em>] for another</em>}
          </span>
        </>
      )}

      {/* What is being dragged, and where it would land. */}
      {gesture?.kind === 'draw' && gesture.slot && (
        <DrawPreview
          from={columnX(gesture.from) ?? 0}
          to={gesture.to === null ? gesture.x : (columnX(gesture.to) ?? gesture.x)}
          self={gesture.to === gesture.from}
          fresh={gesture.to === null}
          y={gesture.slot.y}
          width={node.width}
          height={node.height}
        />
      )}
      {gesture?.kind === 'item' && gesture.slot && (
        <div className="dc-seq-insert" data-refused={gesture.problem ? 'true' : undefined} style={{ left: gesture.slot.x1 + 6, top: gesture.slot.y, width: Math.max(20, gesture.slot.x2 - gesture.slot.x1 - 12) }}>
          {gesture.problem && <span className="dc-seq-reason">{gesture.problem}</span>}
        </div>
      )}
      {gesture?.kind === 'participant' && (
        <div className="dc-seq-stand" style={{ left: participantGapX(layout, gesture.index), top: layout.bodyTop - 60, height: Math.max(40, layout.bodyBottom - layout.bodyTop + 60) }} aria-hidden="true" />
      )}
      {dropIndex !== null && (
        <div className="dc-seq-stand" data-drop="true" style={{ left: participantGapX(layout, dropIndex), top: Math.max(8, layout.bodyTop - 70), height: Math.max(60, layout.bodyBottom - layout.bodyTop + 70) }}>
          <span className="dc-seq-reason">Add as participant</span>
        </div>
      )}

      {editing && <SequenceEditors node={node} layout={layout} target={editing} />}
    </div>
  );
});

/** Whether a branch is somewhere inside an item: a fragment cannot be moved into itself. */
function holds(item: SeqItem, operandId: string): boolean {
  if (item.t !== 'fragment') return false;
  return item.operands.some((branch) => branch.id === operandId || branch.items.some((child) => holds(child, operandId)));
}

/** A message being drawn: its line, its head, and a tick where it would join the order. */
function DrawPreview({ from, to, self, fresh, ghost, y, width, height }: { from: number; to: number; self: boolean; fresh: boolean; ghost?: boolean; y: number; width: number; height: number }) {
  const direction = to >= from ? 1 : -1;
  const d = self
    ? `M ${from} ${y - 6} H ${from + 30} V ${y + 10} H ${from + 6}`
    : `M ${from} ${y} H ${to - direction * 2}`;
  const head = self
    ? `M ${from + 13} ${y + 6} L ${from + 6} ${y + 10} L ${from + 13} ${y + 14}`
    : `M ${to - direction * 8} ${y - 4.5} L ${to} ${y} L ${to - direction * 8} ${y + 4.5}`;
  return (
    <svg className="dc-seq-draw" data-ghost={ghost ? 'true' : undefined} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} />
      <path d={head} />
      {fresh && <circle cx={to} cy={y} r={4} />}
    </svg>
  );
}
