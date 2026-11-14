import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { findItem, findOperand, sequenceOf } from '../../document/sequenceModel';
import type { DraftNode } from '../../document/types';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { cssFont, FONTS, LINE_HEIGHTS, type FontSpec } from '../../render/text/fonts';
import type { SequenceEditTarget } from '../../sequence/focus';
import type { SequenceLayout } from '../../sequence/layout';
import { labelSuggestions } from '../../sequence/suggest';
import { useEditorStore } from '../../store/editorStore';
import { sequenceActions } from '../../store/sequenceActions';
import { participantOptions, type ParticipantOption } from './participantOptions';

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

/** A message's words, with what could be said listed under the field while it is still empty. */
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
  const shown = suggestions.filter((suggestion) => suggestion.toLowerCase().startsWith(typed.trim().toLowerCase()) && suggestion !== typed);
  const { left, top, width, height } = style as { left: number; top: number; width: number; height: number };
  return (
    <div className="dc-seq-new nodrag nopan nowheel" style={{ left, top, width }} onPointerDown={(event) => event.stopPropagation()}>
      <Field
        style={{ width, height }}
        font={FONTS.sequenceMessage}
        align={align}
        value={value}
        ariaLabel="Message"
        placeholder="What is said"
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
      {shown.length > 0 && (
        <ul className="dc-seq-options" role="listbox" aria-label="Words to start from">
          {shown.map((suggestion, index) => (
            <li
              key={suggestion}
              role="option"
              aria-selected={index === picked}
              data-active={index === picked ? 'true' : undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                onCommit(suggestion);
              }}
            >
              <span className="dc-seq-option-label">{suggestion}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Naming a participant that was added a moment ago. It is already in the sequence — the lifelines
 * have made room and the field sits on its head — and under the field is what the name could mean.
 * Enter keeps it and goes on to the next one; leaving it empty, or Escape, takes it out again.
 */
function NamingParticipant({ node, layout, target }: { node: DraftNode; layout: SequenceLayout; target: Extract<SequenceEditTarget, { kind: 'participant' }> }) {
  const sequence = sequenceOf(node);
  const [query, setQuery] = useState('');
  // The others in the sequence: a shape one of them already stands for is not offered twice.
  const others = useMemo(() => ({ ...sequence, participants: sequence.participants.filter((participant) => participant.id !== target.id) }), [sequence, target.id]);
  const { options, preferred } = useMemo(() => participantOptions(query, useEditorStore.getState().document.nodes, others), [query, others]);
  const [picked, setPicked] = useState<number | null>(null);
  const active = Math.min(options.length - 1, picked ?? preferred);
  const column = layout.columns.find((entry) => entry.id === target.id);
  if (!column) return null;
  // The head was laid out as wide as this field (`UNNAMED_HEAD_WIDTH`), so the field sits on it and on nothing else.
  const width = column.head.w;

  const finish = (option: ParticipantOption | undefined, how: 'enter' | 'blur') => {
    const typed = query.replace(/\s+/g, ' ').trim();
    const named = option?.key.startsWith('shape:') || option?.key.startsWith('technology:');
    // Nothing typed and nothing picked from the list: there is no participant to keep.
    const is = option && (typed || named) ? option.participant : null;
    sequenceActions.finishNaming(node.id, target.id, is, how === 'enter' ? 'next' : 'done');
  };

  return (
    <div className="dc-seq-new nodrag nopan nowheel" style={{ left: column.x - width / 2, top: column.head.y + column.head.h / 2 - 13, width }} onPointerDown={(event) => event.stopPropagation()}>
      <Field
        style={{ width, height: 26 }}
        font={FONTS.nodeLabel}
        value=""
        ariaLabel="New participant name"
        placeholder="Name, then Enter"
        // A new name means a new best guess: an option arrowed to for the old one is let go.
        onChange={(value) => {
          setQuery(value);
          setPicked(null);
        }}
        onCommit={(_value, how) => finish(how === 'blur' && picked === null ? options[preferred] : options[active], how)}
        onCancel={() => sequenceActions.finishNaming(node.id, target.id, null)}
        onKey={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
          event.preventDefault();
          setPicked((active + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
          return true;
        }}
      />
      <ul className="dc-seq-options" role="listbox" aria-label="What it is">
        {options.map((option, index) => (
          <li
            key={option.key}
            role="option"
            aria-selected={index === active}
            data-active={index === active ? 'true' : undefined}
            // `mousedown`, not `click`: the field's blur would otherwise commit before the click lands.
            onMouseDown={(event) => {
              event.preventDefault();
              finish(option, 'enter');
            }}
          >
            <span className="dc-seq-option-label">{option.label}</span>
            <span className="dc-seq-option-hint">{option.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SequenceEditors({ node, layout, target }: { node: DraftNode; layout: SequenceLayout; target: SequenceEditTarget }) {
  const sequence = sequenceOf(node);
  const close = () => sequenceActions.edit(node.id, null);

  // Keyed by the participant, so going on to the next one starts with an empty, focused field.
  if (target.kind === 'participant' && target.naming) return <NamingParticipant key={target.id} node={node} layout={layout} target={target} />;

  if (target.kind === 'participant') {
    const participant = sequence.participants.find((entry) => entry.id === target.id);
    const column = layout.columns.find((entry) => entry.id === target.id);
    if (!participant || !column) return null;
    const width = Math.max(column.head.w, 150);
    return (
      <Field
        style={{ left: column.x - width / 2, top: column.head.y + column.head.h / 2 - 13, width, height: 26 }}
        font={FONTS.nodeLabel}
        value={participant.name}
        ariaLabel="Participant name"
        onCommit={(value) => {
          sequenceActions.updateParticipant(node.id, target.id, { name: value }, 'Rename participant');
          close();
        }}
        onCancel={close}
      />
    );
  }

  if (target.kind === 'message') {
    const found = findItem(sequence, target.id);
    const drawn = layout.messages.find((entry) => entry.id === target.id);
    if (!found || found.item.t !== 'message' || !drawn) return null;
    const height = (drawn.label?.layout.height ?? FONTS.sequenceMessage.size * LINE_HEIGHTS.label) + 4;
    const style: CSSProperties = drawn.self
      ? { left: Math.max(drawn.x1, drawn.x2) + 34, top: (drawn.y + drawn.yEnd) / 2 - height / 2, width: 170, height }
      : (() => {
          const width = Math.max(110, Math.abs(drawn.x2 - drawn.x1) - 16);
          return { left: (drawn.x1 + drawn.x2) / 2 - width / 2, top: drawn.y - 4 - height, width, height };
        })();
    return (
      <MessageLabel
        style={style}
        align={drawn.self ? 'left' : 'center'}
        value={found.item.label}
        // Words already written down for these two: a connector between the shapes they stand
        // for, or how two such shapes usually relate. Offered under an empty field, never filled in.
        suggestions={found.item.label ? [] : labelSuggestions(sequence, found.item, useEditorStore.getState().document.edges)}
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
