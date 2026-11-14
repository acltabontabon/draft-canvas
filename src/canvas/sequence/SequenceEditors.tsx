import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { findItem, findOperand, sequenceOf } from '../../document/sequenceModel';
import type { DraftNode, SeqParticipant } from '../../document/types';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { cssFont, FONTS, LINE_HEIGHTS, type FontSpec } from '../../render/text/fonts';
import type { SequenceEditTarget } from '../../sequence/focus';
import type { SequenceLayout } from '../../sequence/layout';
import { labelSuggestions } from '../../sequence/suggest';
import { useEditorStore } from '../../store/editorStore';
import { sequenceActions } from '../../store/sequenceActions';
import { participantOptions } from './participantOptions';

/**
 * The inline editors of a sequence: one field, placed exactly where the words it edits are drawn
 * and set in the same type, so starting to type moves nothing. Enter keeps what was typed, Escape
 * throws it away, and clicking elsewhere keeps it — the same three rules as every label on the canvas.
 */

interface FieldProps {
  style: CSSProperties;
  font: FontSpec;
  value: string;
  ariaLabel: string;
  placeholder?: string;
  multiline?: boolean;
  align?: 'left' | 'center';
  onCommit: (value: string, how: 'enter' | 'blur') => void;
  onCancel: () => void;
  /** Keys the field does not take itself: the option list of a new participant. */
  onKey?: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, value: string) => boolean;
  onChange?: (value: string) => void;
}

function Field({ style, font, value, ariaLabel, placeholder, multiline, align = 'center', onCommit, onCancel, onKey, onChange }: FieldProps) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const finish = (how: 'enter' | 'blur' | 'escape') => {
    if (done.current) return;
    done.current = true;
    if (how === 'escape') onCancel();
    else onCommit(ref.current?.value ?? '', how);
  };
  const shared = {
    ref,
    className: 'dc-seq-editor nodrag nopan nowheel',
    defaultValue: value,
    'aria-label': ariaLabel,
    placeholder,
    spellCheck: false,
    dir: 'auto' as const,
    style: { ...style, font: cssFont(font), lineHeight: `${font.size * LINE_HEIGHTS.label}px`, textAlign: align },
    onBlur: () => finish('blur'),
    onChange: onChange ? (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value) : undefined,
    onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onDoubleClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // Before anything else: the canvas's own shortcuts must not see keys typed into a field.
      event.stopPropagation();
      if (isImeKeyEvent(event)) return;
      if (onKey?.(event, event.currentTarget.value)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('escape');
      } else if (event.key === 'Enter' && !(multiline && event.shiftKey)) {
        event.preventDefault();
        finish('enter');
      }
    },
  };
  return multiline ? <textarea {...shared} rows={2} /> : <input {...shared} />;
}

/** A message's words, with previous labels available when the field is empty or on request. */
function MessageLabel({
  style,
  align,
  value,
  suggestions,
  onCommit,
  onCancel,
}: {
  style: CSSProperties;
  align: 'left' | 'center';
  value: string;
  suggestions: string[];
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState(value);
  const [picked, setPicked] = useState<number | null>(null);
  const search = typed === value ? '' : typed.trim().toLowerCase();
  const shown = suggestions.filter((suggestion) => suggestion.toLowerCase().startsWith(search) && suggestion !== typed);
  const { left, top, width, height } = style as { left: number; top: number; width: number; height: number };
  return (
    <div className="dc-seq-new nodrag nopan nowheel" style={{ left, top, width }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <Field
        style={{ width, height }}
        font={FONTS.sequenceMessage}
        align={align}
        value={value}
        ariaLabel="Message"
        placeholder="Message"
        onChange={(next) => {
          setTyped(next);
          setPicked(null);
        }}
        onCommit={(text, how) => onCommit(how === 'enter' && picked !== null && shown[picked] ? shown[picked] : text)}
        onCancel={onCancel}
        onKey={(event) => {
          if (shown.length === 0 || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return false;
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setPicked(picked === null ? (step === 1 ? 0 : shown.length - 1) : (picked + step + shown.length) % shown.length);
          return true;
        }}
      />
      {shown.length > 0 && (typed !== value || value === '' || picked !== null) && (
        <ul className="dc-seq-options" role="listbox" aria-label="Words to start from">
          {shown.map((suggestion, index) => (
            <li
              key={suggestion}
              role="option"
              aria-selected={index === picked}
              data-active={index === picked ? 'true' : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onCommit(suggestion)}
            >
              <span className="dc-seq-option-label">{suggestion}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Opens a normal text field; matching shapes and technologies are available once typing starts. */
function ParticipantName({ node, layout, participant }: { node: DraftNode; layout: SequenceLayout; participant: SeqParticipant }) {
  const sequence = sequenceOf(node);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const others = useMemo(() => ({ ...sequence, participants: sequence.participants.filter((entry) => entry.id !== participant.id) }), [sequence, participant.id]);
  const { options, preferred } = useMemo(() => participantOptions(query, useEditorStore.getState().document.nodes, others), [query, others]);
  const showOptions = query.trim() !== '' && (picked !== null || !options[preferred]?.key.startsWith('kind:'));
  const column = layout.columns.find((entry) => entry.id === participant.id);
  if (!column) return null;
  const width = Math.max(column.head.w + 4, 140);
  const inside = participant.type === 'service' || participant.type === 'component';
  const top = inside ? column.head.y + (column.head.h - 28) / 2 : column.head.y + column.head.h - 28;
  const close = () => sequenceActions.edit(node.id, null);
  const choose = (index: number) => {
    sequenceActions.chooseParticipant(node.id, participant.id, options[index]!.participant);
    close();
  };

  return (
    <div className="dc-seq-new nodrag nopan nowheel" style={{ left: column.x - width / 2, top, width }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <Field
        style={{ width, height: 28, padding: '0 8px' }}
        font={FONTS.nodeLabel}
        value={participant.name}
        ariaLabel="Participant name"
        onChange={(value) => {
          setQuery(value);
          setPicked(null);
        }}
        onCommit={(value, how) => {
          if (how === 'enter' && picked !== null && options[picked]) return choose(picked);
          const name = value.replace(/\s+/g, ' ').trim();
          if (name) sequenceActions.updateParticipant(node.id, participant.id, { name }, 'Rename participant');
          close();
        }}
        onCancel={close}
        onKey={(event) => {
          if (!query.trim() || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return false;
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setPicked(picked === null ? preferred : (picked + step + options.length) % options.length);
          return true;
        }}
      />
      {showOptions && (
        <ul className="dc-seq-options" role="listbox" aria-label="Participant suggestions">
          {options.map((option, index) => (
            <li
              key={option.key}
              role="option"
              aria-selected={index === picked}
              data-active={index === picked ? 'true' : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span className="dc-seq-option-label">{option.label}</span>
              <span className="dc-seq-option-hint">{option.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SequenceEditors({ node, layout, target }: { node: DraftNode; layout: SequenceLayout; target: SequenceEditTarget }) {
  const sequence = sequenceOf(node);
  const close = () => sequenceActions.edit(node.id, null);

  if (target.kind === 'participant') {
    const participant = sequence.participants.find((entry) => entry.id === target.id);
    return participant ? <ParticipantName key={target.id} node={node} layout={layout} participant={participant} /> : null;
  }

  if (target.kind === 'message') {
    const found = findItem(sequence, target.id);
    const drawn = layout.messages.find((entry) => entry.id === target.id);
    if (!found || found.item.t !== 'message' || !drawn) return null;
    const height = Math.max(24, (drawn.label?.layout.height ?? FONTS.sequenceMessage.size * LINE_HEIGHTS.label) + 4);
    const style: CSSProperties = drawn.self
      ? { left: Math.max(drawn.x1, drawn.x2) + 34, top: (drawn.y + drawn.yEnd) / 2 - height / 2, width: 170, height }
      : (() => {
          const width = Math.max(
            (drawn.label?.layout.width ?? 0) + 8,
            Math.min(300, Math.max(110, Math.abs(drawn.x2 - drawn.x1) - 16)),
          );
          return { left: (drawn.x1 + drawn.x2) / 2 - width / 2, top: drawn.y - 4 - height, width, height };
        })();
    return (
      <MessageLabel
        style={style}
        align={drawn.self ? 'left' : 'center'}
        value={found.item.label}
        suggestions={labelSuggestions(sequence, found.item, useEditorStore.getState().document.edges)}
        onCommit={(value) => {
          sequenceActions.setLabel(node.id, target.id, value);
          close();
        }}
        onCancel={close}
      />
    );
  }

  if (target.kind === 'guard') {
    const found = findOperand(sequence, target.id);
    const frame = found ? layout.fragments.find((entry) => entry.id === found.fragment.id) : undefined;
    const branch = frame?.operands.find((entry) => entry.id === target.id);
    if (!found || !frame || !branch) return null;
    const first = frame.operands[0]?.id === target.id;
    const left = branch.guard?.x ?? frame.box.x + (first ? frame.tab.w + 8 : 8);
    const top = branch.guard?.y ?? (first ? frame.box.y + 2 : (branch.separatorY ?? frame.box.y) + 3);
    return (
      <Field
        style={{ left, top: top - 2, width: Math.max(150, Math.min(240, frame.box.x + frame.box.w - left - 8)), height: 19 }}
        font={FONTS.sequenceGuard}
        align="left"
        value={found.operand.guard ?? ''}
        ariaLabel="Condition"
        placeholder="When this happens"
        onCommit={(value) => {
          sequenceActions.setGuard(node.id, target.id, value);
          close();
        }}
        onCancel={close}
      />
    );
  }

  if (target.kind === 'reference') {
    const found = findItem(sequence, target.id);
    const frame = layout.fragments.find((entry) => entry.id === target.id);
    if (!found || found.item.t !== 'fragment' || !frame) return null;
    const width = Math.max(140, frame.box.w - 40);
    return (
      <Field
        style={{ left: frame.box.x + frame.box.w / 2 - width / 2, top: frame.box.y + frame.box.h / 2 - 8, width, height: 20 }}
        font={FONTS.sequenceMessage}
        value={found.item.label ?? ''}
        ariaLabel="Referenced interaction"
        placeholder="Which interaction"
        onCommit={(value) => {
          sequenceActions.setReferenceLabel(node.id, target.id, value);
          close();
        }}
        onCancel={close}
      />
    );
  }

  if (target.kind === 'note') {
    const found = findItem(sequence, target.id);
    const drawn = layout.notes.find((entry) => entry.id === target.id);
    if (!found || found.item.t !== 'note' || !drawn) return null;
    return (
      <Field
        multiline
        align="left"
        style={{ left: drawn.box.x, top: drawn.box.y, width: Math.max(drawn.box.w, 150), height: Math.max(drawn.box.h, 40), padding: '6px 8px' }}
        font={FONTS.sequenceNote}
        value={found.item.text}
        ariaLabel="Note"
        placeholder="A note"
        onCommit={(value) => {
          sequenceActions.setNoteText(node.id, target.id, value);
          close();
        }}
        onCancel={close}
      />
    );
  }

  const group = sequence.groups?.find((entry) => entry.id === target.id);
  const band = layout.groups.find((entry) => entry.id === target.id);
  if (!group || !band) return null;
  return (
    <Field
      align="left"
      style={{ left: band.box.x + 6, top: band.box.y + 2, width: Math.max(120, band.box.w - 12), height: 16 }}
      font={FONTS.variantTag}
      value={group.name}
      ariaLabel="Group name"
      placeholder="What these have in common"
      onCommit={(value) => {
        sequenceActions.renameGroup(node.id, target.id, value);
        close();
      }}
      onCancel={close}
    />
  );
}
