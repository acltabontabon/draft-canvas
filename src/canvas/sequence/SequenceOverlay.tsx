import { memo, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import { findItem, messagesOf, sequenceOf, type SeqSlot } from '../../document/sequenceModel';
import type { DraftNode, SeqItem } from '../../document/types';
import { sequenceArrowShapes, sequenceAttachmentChips } from '../../nodes/sequence';
import { describeContext, sequenceLayoutFor } from '../../nodes/describe';
import { emitDisplayList } from '../../render/svg/emit';
import { getMeasurer } from '../../render/text/measure';
import { LIGHT } from '../../render/theme/tokens';
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
import { useEditorStore } from '../../store/editorStore';
import { nodeIndex } from '../../store/selectors';
import { sequenceActions } from '../../store/sequenceActions';
import { useUiStore } from '../../store/uiStore';
import type { PersonalityPreset } from '../../theme/usePersonality';
import { SvgSurface } from '../SvgSurface';
import { SequenceEditors } from './SequenceEditors';
import './sequence.css';
import { DRAG_THRESHOLD_PX } from '../gestureThresholds';

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
  | { what: 'endpoint'; id: string; end: 'from' | 'to' }
  | { what: 'participant'; id: string };

type Point = { x: number; y: number };
type ParticipantDrop = { nodeId: string; participantId: string; offset: number };

type Gesture =
  /** A message being drawn from a lifeline. `to` is null past the last lifeline: a new participant. */
  | { kind: 'draw'; from: string; to: string | null; slot: SlotLayout | null; originY: number; pointer: Point; other: ParticipantDrop | null }
  /** A message, note or fragment being moved to another place in the order. */
  | { kind: 'item'; id: string; slot: SlotLayout | null; problem: string | null; offset: Point }
  | { kind: 'endpoint'; id: string; end: 'from' | 'to'; participant: string | null; pointer: Point }
  /** A participant being moved along the row. */
  | { kind: 'participant'; id: string; index: number; x: number };

const DROP_REACH = 20;
const NEW_PARTICIPANT_REACH = 180;

function participantAt(layout: SequenceLayout, { x, y }: Point) {
  const head = layout.columns.find((column) =>
    x >= column.head.x && x <= column.head.x + column.head.w && y >= column.head.y && y <= column.head.y + column.head.h,
  );
  if (head) return head;
  const column = columnNear(layout, x, DROP_REACH);
  return column && y >= column.lifeTop - DROP_REACH && y <= column.lifeBottom + DROP_REACH ? column : null;
}

const box = (rect: Rect, grow = 0): CSSProperties => ({ left: rect.x - grow, top: rect.y - grow, width: rect.w + grow * 2, height: rect.h + grow * 2 });

interface Props {
  node: DraftNode;
  layout: SequenceLayout;
  readOnly: boolean;
  selected: boolean;
  preset: PersonalityPreset;
}

export const SequenceOverlay = memo(function SequenceOverlay({ node, layout, readOnly, selected, preset }: Props) {
  const nodeId = node.id;
  const { screenToFlowPosition } = useReactFlow();
  const sequence = sequenceOf(node);
  const focus = useUiStore((state) => (state.sequenceFocus?.nodeId === nodeId ? state.sequenceFocus : null));
  const editing = useUiStore((state) => (state.sequenceEdit?.nodeId === nodeId ? state.sequenceEdit.target : null));
  const dropIndex = useUiStore((state) => (state.sequenceDropTarget?.nodeId === nodeId ? state.sequenceDropTarget.index : null));
  const dropStays = useUiStore((state) => state.sequenceDropTarget?.nodeId === nodeId && state.sequenceDropTarget.stays);
  const attachmentTarget = useUiStore((state) => state.sequenceAttachmentTarget?.nodeId === nodeId ? state.sequenceAttachmentTarget.messageId : null);
  const externalTarget = useUiStore((state) => state.sequenceLinkTarget?.nodeId === nodeId ? state.sequenceLinkTarget.participantId : null);

  const rootRef = useRef<HTMLDivElement>(null);
  const held = useRef<(Held & { client: Point; origin: Point }) | null>(null);
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
  const local = (clientX: number, clientY: number): Point => {
    const root = rootRef.current;
    if (!root) return { x: 0, y: 0 };
    const rect = root.getBoundingClientRect();
    const scale = rect.width / Math.max(1, node.width) || 1;
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };

  const end = () => {
    held.current = null;
    if (gestureRef.current) {
      if (gestureRef.current.kind === 'draw') useUiStore.getState().setSequenceLinkTarget(null);
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
      if (gestureRef.current?.kind === 'draw') useUiStore.getState().setSequenceLinkTarget(null);
      if (gestureRef.current) useUiStore.getState().setInteractionActive(false);
    },
    [],
  );

  /* ------------------------------------------------------------------ gestures -- */

  const press = (event: PointerEvent<HTMLElement>, what: Held) => {
    if (readOnly || event.button !== 0 || editing || useUiStore.getState().armed) return;
    held.current = {
      ...what,
      client: { x: event.clientX, y: event.clientY },
      origin: local(event.clientX, event.clientY),
    };
    dragged.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const track = (event: PointerEvent<HTMLElement>) => {
    const start = held.current;
    if (!start) return;
    if (!gestureRef.current && Math.hypot(event.clientX - start.client.x, event.clientY - start.client.y) < DRAG_THRESHOLD_PX) return;
    // A menu opened under a long press: the press was for the menu.
    if (useUiStore.getState().contextMenu) return end();
    if (!gestureRef.current) {
      useUiStore.getState().setInteractionActive(true);
      setHover(null);
    }
    const point = local(event.clientX, event.clientY);
    if (start.what === 'lifeline') {
      const hovered = document.elementFromPoint(event.clientX, event.clientY);
      const hoveredNode = hovered?.closest<HTMLElement>('.react-flow__node')?.dataset.id;
      const otherNode = hoveredNode && hoveredNode !== nodeId ? nodeIndex(useEditorStore.getState().document.nodes).get(hoveredNode) : undefined;
      let other: ParticipantDrop | null = null;
      if (otherNode?.type === 'sequence') {
        const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false });
        const x = flow.x - otherNode.x;
        const y = flow.y - otherNode.y;
        const targetLayout = sequenceLayoutFor(otherNode, describeContext(LIGHT));
        const column = participantAt(targetLayout, { x, y });
        if (column) {
          other = { nodeId: otherNode.id, participantId: column.id, offset: offsetOnLifeline(column, y) };
        }
      }
      useUiStore.getState().setSequenceLinkTarget(other);
      const last = layout.columns[layout.columns.length - 1];
      const column = hoveredNode && hoveredNode !== nodeId ? null : participantAt(layout, point);
      const beyond = !column && (hoveredNode === nodeId || (!hoveredNode && hovered?.classList.contains('react-flow__pane'))) && !!last && point.x > last.head.x + last.head.w
        && point.x <= layout.width + NEW_PARTICIPANT_REACH
        && point.y >= layout.bodyTop - DROP_REACH && point.y <= layout.bodyBottom + DROP_REACH;
      setGesture({
        kind: 'draw',
        from: start.id,
        to: column?.id ?? null,
        slot: column || beyond ? slotAt(layout, point.x, point.y) : null,
        originY: start.origin.y,
        pointer: point,
        other,
      });
    } else if (start.what === 'endpoint') {
      const participant = participantAt(layout, point)?.id ?? null;
      setGesture({ kind: 'endpoint', id: start.id, end: start.end, participant, pointer: point });
    } else if (start.what === 'item') {
      let slot = slotAt(layout, point.x, point.y);
      const moving = findItem(sequence, start.id)?.item;
      // Not into itself, and not to where it already is.
      if (slot && moving && slot.operandId !== null && moving.t === 'fragment' && holds(moving, slot.operandId)) slot = null;
      const at = findItem(sequence, start.id)?.at;
      if (slot && at && (at.operand?.id ?? null) === slot.operandId && (slot.index === at.index || slot.index === at.index + 1)) slot = null;
      setGesture({
        kind: 'item',
        id: start.id,
        slot,
        problem: slot ? moveProblem(sequence, start.id, { operandId: slot.operandId, index: slot.index }) : null,
        offset: { x: point.x - start.origin.x, y: point.y - start.origin.y },
      });
    } else {
      setGesture({ kind: 'participant', id: start.id, index: participantIndexAt(layout, point.x), x: point.x });
    }
  };

  const release = (event: PointerEvent<HTMLElement>) => {
    if (gestureRef.current) track(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const done = gestureRef.current;
    if (!done) {
      held.current = null;
      return;
    }
    dragged.current = true;
    end();
    if (done.kind === 'draw') {
      if (done.other) {
        const column = layout.columns.find((entry) => entry.id === done.from);
        if (column) sequenceActions.connectParticipants({ nodeId, participantId: done.from, offset: offsetOnLifeline(column, done.originY) }, done.other);
        return;
      }
      if (!done.slot) return;
      const slot: SeqSlot = { operandId: done.slot.operandId, index: done.slot.index };
      if (done.to === null) {
        sequenceActions.addMessageToNewParticipant(nodeId, done.from, slot);
      } else {
        sequenceActions.addMessage(nodeId, { from: done.from, to: done.to }, slot);
      }
    } else if (done.kind === 'endpoint') {
      if (done.participant) sequenceActions.setEnds(nodeId, done.id, { [done.end]: done.participant });
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
    // With a tool in hand the click is the tool's: it is being put down on the sequence, wherever on
    // it the pointer happens to be (`createAt`).
    if (useUiStore.getState().armed) return;
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

  /** A new participant stands at `index`. */
  const add = (event: MouseEvent, index: number) => {
    event.stopPropagation();
    if (!readOnly) sequenceActions.addDefaultParticipant(nodeId, index);
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

  const isFocused = (kind: SequenceFocus['kind'], id: string): boolean => !editing && focus?.kind === kind && focus.ids.includes(id);
  const nameOf = (participantId: string): string => sequence.participants.find((participant) => participant.id === participantId)?.name.trim() || 'Unnamed participant';

  /* ------------------------------------------------------------------- drawing -- */

  const columnX = (id: string | null): number | null => layout.columns.find((column) => column.id === id)?.x ?? null;

  // What usually comes next, offered as a ghost where it would go: Tab takes it, ] and [ turn it
  // over. Only at the end of a list, where there is room for it and "next" means something.
  const ghostIndex = useUiStore((state) => state.sequenceGhost);
  const ghostsOn = useUiStore((state) => state.continuationsEnabled);
  const offers = !readOnly && ghostsOn && focus && !gesture && !editing ? nextFor(sequence, focus) : [];
  const offer = offers.length > 0 ? offers[ghostIndex % offers.length]! : null;
  const offerSlot = offer ? slotFor(layout, offer.slot.operandId, offer.slot.index) : null;
  const attachments = new Map(messagesOf(sequence).flatMap((message) => message.attachments?.length ? [[message.id, message.attachments] as const] : []));
  const heads = layout.columns.filter((column) => !column.created);
  const headRowMiddle = heads.length > 0 ? Math.max(...heads.map((column) => column.head.y + column.head.h)) - 22 : layout.bodyTop;
  const quiet = gesture !== null || editing !== null;
  const selectedArrows = focus?.kind === 'item' && !editing
    ? layout.messages.filter((message) => focus.ids.includes(message.id))
    : [];
  const endpointMessage = !readOnly && selectedArrows.length === 1 ? selectedArrows[0] : undefined;
  const reconnecting = gesture?.kind === 'endpoint' ? gesture : null;
  const targetParticipant = externalTarget ?? reconnecting?.participant ?? (gesture?.kind === 'draw' && gesture.slot ? gesture.to : null);
  const reordering = gesture?.kind === 'item' ? layout.messages.find((message) => message.id === gesture.id) : undefined;
  const attachmentArrow = attachmentTarget ? layout.messages.find((message) => message.id === attachmentTarget) : undefined;
  const highlightedArrows = selectedArrows.filter((message) => reconnecting?.id !== message.id && reordering?.id !== message.id);

  const targetOnLifeline = (event: MouseEvent) => {
    const point = local(event.clientX, event.clientY);
    return hitSequence(layout, point.x, point.y);
  };

  return (
    <div
      ref={rootRef}
      className="dc-seq-overlay"
      data-selected={selected ? 'true' : undefined}
      data-dragging={gesture ? gesture.kind : undefined}
      style={{ width: node.width, height: node.height }}
    >
      {highlightedArrows.length > 0 && (
        <SvgSurface className="dc-seq-selected-arrows" width={node.width} height={node.height}>
          {emitDisplayList({
            width: node.width,
            height: node.height,
            shapes: highlightedArrows.flatMap((message) => sequenceArrowShapes(message, 'currentColor', `${node.id}:${message.id}`, preset)),
          })}
        </SvgSurface>
      )}
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
            <div key={side} className="dc-seq-target dc-seq-frame-edge nodrag nopan" data-side={side} {...targetProps('item', frame.id, null)} {...gestures({ what: 'item', id: frame.id })} />
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
          aria-description={sequence.numberMessages === false ? undefined : `Message ${message.number} of ${layout.messages.length}`}
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
            data-endpoint-target={targetParticipant === column.id ? 'true' : undefined}
            style={{ left: column.x - 7, top: column.lifeTop, width: 14, height: Math.max(0, column.lifeBottom - column.lifeTop) }}
            onPointerMove={(event) => {
              if (held.current) return track(event);
              const point = local(event.clientX, event.clientY);
              const hit = hitSequence(layout, point.x, point.y);
              const slot = hit.kind === 'lifeline' ? slotAt(layout, column.x, point.y) : null;
              if (slot && !(hover?.participantId === column.id && hover.slot === slot)) setHover({ participantId: column.id, slot });
              else if (!slot && hover) setHover(null);
            }}
            onPointerLeave={() => setHover(null)}
            onPointerDown={(event) => {
              const under = targetOnLifeline(event);
              if (under.kind === 'message' || under.kind === 'note') press(event, { what: 'item', id: under.id });
              else press(event, { what: 'lifeline', id: column.id });
            }}
            onPointerUp={release}
            onPointerCancel={end}
            onClick={(event) => {
              // A click with no drag selects whatever the lifeline was pressed through.
              const under = targetOnLifeline(event);
              if (under.kind === 'message' || under.kind === 'note' || under.kind === 'fragment') pick(event, 'item', under.id);
              else if (under.kind === 'operand') pick(event, 'operand', under.id);
              else pick(event, 'participant', column.id);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              const under = targetOnLifeline(event);
              if (under.kind === 'message' || under.kind === 'note') open(event, { kind: under.kind, id: under.id });
              if (under.kind === 'operand') open(event, { kind: 'guard', id: under.id });
            }}
            onContextMenu={(event) => {
              const under = targetOnLifeline(event);
              if (under.kind === 'message' || under.kind === 'note' || under.kind === 'fragment') menu('item', under.id)();
              else if (under.kind === 'operand') menu('operand', under.id)();
              else menu('participant', column.id)();
            }}
          />
        ))}

      {/* Heads. */}
      {layout.columns.map((column) => (
        <div
          key={column.id}
          className="dc-seq-target dc-seq-head nodrag nopan"
          data-focused={isFocused('participant', column.id) ? 'true' : undefined}
          data-endpoint-target={targetParticipant === column.id ? 'true' : undefined}
          data-moving={gesture?.kind === 'participant' && gesture.id === column.id ? 'true' : undefined}
          role="button"
          aria-label={`Participant ${nameOf(column.id)}`}
          style={box(column.head, 2)}
          {...targetProps('participant', column.id, { kind: 'participant', id: column.id })}
          {...gestures({ what: 'participant', id: column.id })}
        />
      ))}

      {/* A participant that stands for a shape on the canvas says so. */}
      {layout.columns.map((column) => {
        const ref = sequence.participants.find((participant) => participant.id === column.id)?.ref;
        if (!ref || !nodeIndex(useEditorStore.getState().document.nodes).has(ref)) return null;
        return (
          <span key={column.id} className="dc-seq-link" style={{ left: column.head.x - 5, top: column.head.y - 5 }} title="Stands for a shape on the canvas: renaming either renames both" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="10" height="10">
              <path d="M5 7.2 7 5.2M4.4 5.4 3.2 6.6a1.7 1.7 0 0 0 2.4 2.4l1.2-1.2M7.6 6.6l1.2-1.2a1.7 1.7 0 0 0-2.4-2.4L5.2 4.2" />
            </svg>
          </span>
        );
      })}

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
            onClick={(event) => add(event, index)}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        ))}
      {!readOnly && !quiet && layout.columns.length === 0 && (
        <button
          type="button"
          className="dc-seq-empty nodrag nopan"
          style={{ left: node.width / 2, top: Math.max(node.height / 2, layout.bodyTop + 30) }}
          onClick={(event) => add(event, 0)}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          Add a participant
        </button>
      )}

      {/* Where a message started from here would go. */}
      {hover && !quiet && (
        <span className="dc-seq-dot" style={{ left: columnX(hover.participantId) ?? 0, top: hover.slot.y }} aria-hidden="true" />
      )}

      {endpointMessage && !reordering && (['from', 'to'] as const).map((end) => (
        <span
          key={`${endpointMessage.id}:${end}`}
          className="dc-seq-endpoint nodrag nopan"
          data-end={end}
          title={end === 'from' ? 'Drag to change sender' : 'Drag to change receiver'}
          style={reconnecting?.end === end
            ? { left: reconnecting.pointer.x, top: reconnecting.pointer.y }
            : { left: end === 'from' ? endpointMessage.x1 : endpointMessage.x2, top: end === 'from' ? endpointMessage.y : endpointMessage.yEnd }}
          {...gestures({ what: 'endpoint', id: endpointMessage.id, end })}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ))}
      {endpointMessage && reconnecting && (
        <PointerArrow
          from={reconnecting.end === 'from' ? reconnecting.pointer : { x: endpointMessage.x1, y: endpointMessage.y }}
          to={reconnecting.end === 'to' ? reconnecting.pointer : { x: endpointMessage.x2, y: endpointMessage.yEnd }}
          width={node.width}
          height={node.height}
        />
      )}

      {offer && offerSlot && (
        <>
          <SuggestedArrow from={columnX(offer.from) ?? 0} to={columnX(offer.to) ?? 0} self={offer.from === offer.to} y={offerSlot.y + 6} width={node.width} height={node.height} />
          <button
            type="button"
            className="dc-seq-ghost-hint nodrag nopan"
            style={{ left: ((columnX(offer.from) ?? 0) + (columnX(offer.to) ?? 0)) / 2 + (offer.from === offer.to ? 44 : 0), top: offerSlot.y + 14 }}
            onClick={(event) => {
              if (useUiStore.getState().armed) return;
              event.stopPropagation();
              sequenceActions.addMessage(nodeId, offer, offer.slot);
            }}
          >
            <kbd aria-hidden="true">Tab</kbd>
            {offer.title}
          </button>
        </>
      )}

      {/* What is being dragged, and where it would land. */}
      {gesture?.kind === 'draw' && (
        <PointerArrow
          from={{ x: columnX(gesture.from) ?? 0, y: gesture.originY }}
          to={gesture.pointer}
          drop={gesture.slot && { x: columnX(gesture.to) ?? gesture.pointer.x, y: gesture.slot.y }}
          width={node.width}
          height={node.height}
        />
      )}
      {gesture?.kind === 'draw' && gesture.slot && !gesture.to && (
        <div className="dc-seq-add-target" style={{ left: gesture.pointer.x, top: gesture.slot.y }}>
          Add participant
        </div>
      )}
      {reordering && gesture?.kind === 'item' && (
        <SvgSurface className="dc-seq-selected-arrows" width={node.width} height={node.height} style={{ transform: `translate(${gesture.offset.x}px, ${gesture.offset.y}px)` }}>
          {emitDisplayList({
            width: node.width,
            height: node.height,
            shapes: sequenceArrowShapes(reordering, 'currentColor', `${node.id}:${reordering.id}`, preset),
          })}
        </SvgSurface>
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
          <span className="dc-seq-reason">{dropStays ? 'Add as participant · stays linked to this shape' : 'Move into the sequence'}</span>
        </div>
      )}

      {attachmentArrow && (
        <>
          <SvgSurface className="dc-seq-selected-arrows" width={node.width} height={node.height}>
            {emitDisplayList({ width: node.width, height: node.height, shapes: sequenceArrowShapes(attachmentArrow, 'currentColor', `${nodeId}:${attachmentArrow.id}`, preset) })}
          </SvgSurface>
          <div className="dc-seq-add-target" style={{ left: (attachmentArrow.x1 + attachmentArrow.x2) / 2, top: attachmentArrow.yEnd }} data-message-attach-target="">
            Attach to message
          </div>
        </>
      )}

      {!editing && layout.messages.flatMap((message) => {
        const cards = attachments.get(message.id);
        if (!cards) return [];
        return sequenceAttachmentChips(message, cards, layout.width, getMeasurer()).map((chip, index) => {
          const attachment = cards[index]!;
          return <button
            key={attachment.id}
            type="button"
            className="dc-seq-attachment-hit nodrag nopan"
            style={box(chip)}
            aria-label={`View attached ${attachment.type === 'code' ? 'code' : 'note'} for message ${message.number}`}
            tabIndex={focus?.kind === 'item' && focus.ids.includes(message.id) ? 0 : -1}
            onClick={(event) => {
              event.stopPropagation();
              sequenceActions.showAttachments(nodeId, message.id, attachment.id);
            }}
          />;
        });
      })}
      {editing && <SequenceEditors node={node} layout={layout} target={editing} />}
    </div>
  );
});

function offsetOnLifeline(column: { lifeTop: number; lifeBottom: number }, y: number): number {
  return Math.max(0, Math.min(1, (y - column.lifeTop) / Math.max(1, column.lifeBottom - column.lifeTop)));
}

/** Whether a branch is somewhere inside an item: a fragment cannot be moved into itself. */
function holds(item: SeqItem, operandId: string): boolean {
  if (item.t !== 'fragment') return false;
  return item.operands.some((branch) => branch.id === operandId || branch.items.some((child) => holds(child, operandId)));
}

/** The cursor controls the loose end. The drop marker shows where the message would settle. */
function PointerArrow({ from, to, drop, width, height }: { from: Point; to: Point; drop?: Point | null; width: number; height: number }) {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const dx = (to.x - from.x) / length;
  const dy = (to.y - from.y) / length;
  const back = Math.min(length, 8);
  const x = to.x - back * dx;
  const y = to.y - back * dy;
  return (
    <svg className="dc-seq-draw" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={`M ${from.x} ${from.y} L ${to.x} ${to.y}`} />
      <path d={`M ${x + 4.5 * dy} ${y - 4.5 * dx} L ${to.x} ${to.y} L ${x - 4.5 * dy} ${y + 4.5 * dx}`} />
      {drop && <circle cx={drop.x} cy={drop.y} r={4} />}
    </svg>
  );
}

function SuggestedArrow({ from, to, self, y, width, height }: { from: number; to: number; self: boolean; y: number; width: number; height: number }) {
  const direction = to >= from ? 1 : -1;
  const d = self
    ? `M ${from} ${y - 6} H ${from + 30} V ${y + 10} H ${from + 6}`
    : `M ${from} ${y} H ${to - direction * 2}`;
  const head = self
    ? `M ${from + 13} ${y + 6} L ${from + 6} ${y + 10} L ${from + 13} ${y + 14}`
    : `M ${to - direction * 8} ${y - 4.5} L ${to} ${y} L ${to - direction * 8} ${y + 4.5}`;
  return (
    <svg className="dc-seq-draw" data-ghost="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} />
      <path d={head} />
    </svg>
  );
}
