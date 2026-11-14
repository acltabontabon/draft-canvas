import { useState } from 'react';
import { findItem, findOperand, isBranching, participantsIn, slotOf } from '../../document/sequenceModel';
import {
  SEQ_OPERATORS,
  type DraftNode,
  type DraftSequence,
  type SeqFragment,
  type SeqMessage,
  type SeqMessageKind,
  type SeqOperator,
  type SeqParticipant,
  type SeqParticipantType,
} from '../../document/types';
import { displayNameFor } from '../../document/factory';
import { hasDrifted, isLinkable } from '../../document/sequenceLinks';
import { technologyKindPatch } from '../../document/technologyKind';
import { headNode } from '../../nodes/sequence';
import { findingsFor } from '../../sequence/check';
import type { SequenceFocus } from '../../sequence/focus';
import { suggestedKind } from '../../sequence/suggest';
import { useEditorStore } from '../../store/editorStore';
import { sequenceActions } from '../../store/sequenceActions';
import { Button } from '../../ui/common/Button';
import { Tooltip, TooltipGroup } from '../../ui/common/Tooltip';
import { ACTOR_ICON_OPTIONS } from '../actorOptions';
import { COMPONENT_ICON_OPTIONS } from '../componentOptions';
import { DATABASE_ICON_OPTIONS } from '../dataStoreOptions';
import { InspectorSelect, type InspectorSelectOption } from '../InspectorSelect';
import { InspectorColourButton, InspectorColourPalette } from '../InspectorColour';
import { QUEUE_ICON_OPTIONS } from '../queueOptions';
import { SERVICE_ICON_OPTIONS } from '../serviceOptions';
import { TechnologyInput } from '../TechnologyInput';

/**
 * The inspector's row while something inside a sequence is selected: only what can be done to that
 * thing. A participant offers what it is; a message its kind, its reply and its place in a
 * fragment; a fragment its meaning and its branches. Nothing here is on screen until one of them is
 * selected, and nothing is that could be done by taking hold of the thing itself.
 */

const SHAPE_OPTIONS: InspectorSelectOption[] = [
  { value: 'service', label: 'Service' },
  { value: 'actor', label: 'Actor' },
  { value: 'database', label: 'Data Store' },
  { value: 'queue', label: 'Queue' },
  { value: 'component', label: 'Component' },
];

const KIND_OPTIONS: Record<SeqParticipantType, { field: keyof SeqParticipant; options: InspectorSelectOption[]; fallback: string; layout?: 'grid' }> = {
  service: { field: 'serviceKind', options: SERVICE_ICON_OPTIONS, fallback: 'generic', layout: 'grid' },
  database: { field: 'databaseKind', options: DATABASE_ICON_OPTIONS, fallback: 'generic', layout: 'grid' },
  queue: { field: 'queueKind', options: QUEUE_ICON_OPTIONS, fallback: 'queue' },
  actor: { field: 'actorKind', options: ACTOR_ICON_OPTIONS, fallback: 'human', layout: 'grid' },
  component: { field: 'componentKind', options: COMPONENT_ICON_OPTIONS, fallback: 'generic', layout: 'grid' },
};

const MESSAGE_KINDS: Record<SeqMessageKind, { label: string; description: string }> = {
  sync: { label: 'Call', description: 'The sender waits for it to finish. Solid line, filled arrowhead.' },
  async: { label: 'Asynchronous', description: 'Sent without waiting. Solid line, open arrowhead.' },
  reply: { label: 'Reply', description: 'What comes back from an earlier call. Dashed line.' },
  create: { label: 'Create', description: 'Brings the receiver into being at this point.' },
  destroy: { label: 'Destroy', description: 'The receiver ends here; its lifeline stops.' },
};

/** The fragments a stretch of messages can be wrapped in, in the words a person would use. */
const WRAPS: { operator: Exclude<SeqOperator, 'ref'>; label: string; description: string }[] = [
  { operator: 'alt', label: 'Condition', description: 'One of several branches happens, each under its own condition (alt).' },
  { operator: 'opt', label: 'Optional', description: 'Happens only when a condition holds (opt).' },
  { operator: 'loop', label: 'Loop', description: 'Repeats while a condition holds (loop).' },
  { operator: 'par', label: 'Parallel', description: 'Branches that run at the same time, in no order (par).' },
  { operator: 'break', label: 'Break', description: 'If this happens, the rest of the enclosing interaction is skipped (break).' },
  { operator: 'critical', label: 'Critical', description: 'Must not be interleaved with anything else (critical).' },
];

const OPERATOR_OPTIONS: InspectorSelectOption[] = SEQ_OPERATORS.filter((operator) => operator !== 'ref').map((operator) => {
  const wrap = WRAPS.find((entry) => entry.operator === operator)!;
  return { value: operator, label: `${wrap.label} · ${operator}`, description: wrap.description };
});

interface RowProps {
  node: DraftNode;
  sequence: DraftSequence;
  focus: SequenceFocus;
  openPanel: 'color' | 'details' | null;
  setOpenPanel: (panel: 'color' | 'details' | null) => void;
  menuDirection: 'up' | 'down';
  getMenuAvoidRect: () => { top: number; bottom: number } | null;
}

function Action({ label, description, onClick, shortcut }: { label: string; description?: string; shortcut?: string; onClick: () => void }) {
  return (
    <Tooltip content={{ title: label, ...(description ? { description } : {}), ...(shortcut ? { shortcut } : {}) }}>
      {(tip) => (
        <Button variant="quiet" className="dc-popover-action dc-element-action-tile" {...tip} onClick={onClick}>
          {label}
        </Button>
      )}
    </Tooltip>
  );
}

function Direct({ icon, label, description, danger, onClick }: { icon: 'pencil' | 'trash' | 'copy'; label: string; description: string; danger?: boolean; onClick: () => void }) {
  return (
    <Tooltip content={{ title: label, description }}>
      {(tip) => <Button icon={icon} variant={danger ? 'danger' : 'quiet'} className="dc-popover-direct-action" aria-label={label} {...tip} onClick={onClick} />}
    </Tooltip>
  );
}

export function SequenceInspectorRow(props: RowProps) {
  const { focus } = props;
  if (focus.kind === 'participant') return <ParticipantRow {...props} />;
  if (focus.kind === 'operand') return <BranchRow {...props} />;
  if (focus.kind === 'group') return <GroupRow {...props} />;
  return <ItemRow {...props} />;
}

function ParticipantRow({ node, sequence, focus, openPanel, setOpenPanel, menuDirection, getMenuAvoidRect }: RowProps) {
  const chosen = sequence.participants.filter((participant) => focus.ids.includes(participant.id));
  const [first] = chosen;
  const detail = openPanel === 'details';
  const nodes = useEditorStore((state) => state.document.nodes);
  if (!first) return null;
  const group = sequence.groups?.find((entry) => entry.participantIds.includes(first.id));

  if (chosen.length > 1) {
    return (
      <div className="dc-popover-row dc-popover-config dc-element-identity-row">
        <span className="dc-seq-count">{chosen.length} participants</span>
        <span className="dc-popover-divider" aria-hidden="true" />
        <TooltipGroup>
          <Action label="Group" description="Draw these side by side under one name. It says nothing about what happens — only that they belong together." onClick={() => sequenceActions.groupParticipants(node.id, focus.ids)} />
          <Direct icon="trash" danger label="Delete" description="Remove these participants and their messages." onClick={() => sequenceActions.removeParticipants(node.id, focus.ids)} />
        </TooltipGroup>
      </div>
    );
  }

  const kind = KIND_OPTIONS[first.type];
  // The shape this participant stands for, and the shapes it could: read once per render of a row
  // that only exists while one participant is selected.
  const shape = first.ref ? nodes.find((candidate) => candidate.id === first.ref) : undefined;
  const taken = new Set(sequence.participants.map((participant) => participant.ref).filter(Boolean));
  const linkable: InspectorSelectOption[] = shape
    ? []
    : nodes
        .filter((candidate) => isLinkable(candidate) && !taken.has(candidate.id))
        .slice(0, 40)
        .map((candidate) => ({ value: candidate.id, label: displayNameFor(candidate).replace(/\s+/g, ' ').trim() || 'Unnamed shape' }));
  return (
    <>
      <div className="dc-popover-row dc-popover-config dc-element-identity-row">
        <InspectorColourButton
          label="Participant colour"
          accent={first.accent}
          open={openPanel === 'color'}
          onClick={() => setOpenPanel(openPanel === 'color' ? null : 'color')}
        />
        <InspectorSelect
          ariaLabel="Shape"
          value={first.type}
          options={SHAPE_OPTIONS}
          onChange={(value) => sequenceActions.updateParticipant(node.id, first.id, { type: value as SeqParticipantType }, 'Change participant shape')}
          preferredDirection={menuDirection}
          getAvoidRect={getMenuAvoidRect}
        />
        <InspectorSelect
          ariaLabel="Kind"
          value={String(first[kind.field] ?? kind.fallback)}
          options={kind.options}
          onChange={(value) => sequenceActions.updateParticipant(node.id, first.id, { [kind.field]: value, kindOrigin: undefined }, 'Change participant kind')}
          preferredDirection={menuDirection}
          getAvoidRect={getMenuAvoidRect}
          layout={kind.layout}
        />
        <Tooltip content={{ title: 'Technology', description: 'What it is built with. A product the catalogue knows is drawn as its logo.' }}>
          {(tip) => (
            <Button variant="quiet" active={detail} aria-expanded={detail} {...tip} onClick={() => setOpenPanel(detail ? null : 'details')}>
              {first.technology || 'Technology'}
            </Button>
          )}
        </Tooltip>
        <span className="dc-popover-divider" aria-hidden="true" />
        <TooltipGroup>
          <Direct icon="pencil" label="Rename" description="Change the participant's name." onClick={() => sequenceActions.edit(node.id, { kind: 'participant', id: first.id })} />
          <Direct icon="trash" danger label="Delete" description="Remove this participant and its messages." onClick={() => sequenceActions.removeParticipants(node.id, [first.id])} />
        </TooltipGroup>
      </div>
      {(group || shape || linkable.length > 0) && (
        <div className="dc-element-action-row">
          <TooltipGroup>
            {shape && (
              <>
                <Action
                  label={`Go to “${displayNameFor(shape).replace(/\s+/g, ' ').trim() || 'shape'}”`}
                  description="This participant stands for that shape on the canvas: renaming or retyping either changes both."
                  onClick={() => useEditorStore.getState().setSelection({ nodes: [shape.id], edges: [] })}
                />
                {hasDrifted(first, shape) && (
                  <Action label="Update from shape" description="The shape was changed elsewhere. Take its name, kind and technology." onClick={() => sequenceActions.linkTo(node.id, first.id, shape.id)} />
                )}
                <Action label="Unlink" description="Keep the participant as it is; from now on the two are changed separately." onClick={() => sequenceActions.unlink(node.id, first.id)} />
              </>
            )}
            {!shape && linkable.length > 0 && (
              <InspectorSelect
                ariaLabel="Link to a shape"
                value=""
                options={[{ value: '', label: 'Stands for a shape…' }, ...linkable]}
                onChange={(value) => {
                  if (value) sequenceActions.linkTo(node.id, first.id, value);
                }}
                preferredDirection={menuDirection}
                getAvoidRect={getMenuAvoidRect}
              />
            )}
            {group && <Action label={`Take out of “${group.name || 'group'}”`} onClick={() => sequenceActions.leaveGroup(node.id, first.id)} />}
          </TooltipGroup>
        </div>
      )}
      {openPanel === 'color' && (
        <InspectorColourPalette accent={first.accent} onChange={(accent) => {
          sequenceActions.updateParticipant(node.id, first.id, { accent }, 'Recolour participant');
          setOpenPanel(null);
        }} />
      )}
      {detail && (
        <div className="dc-popover-panel dc-seq-technology">
          <TechnologyInput
            autoFocus
            value={first.technology ?? ''}
            onCommit={(value) => {
              const technology = value.trim() || undefined;
              // The same rule a shape follows: a known product sets the kind, unless one was picked.
              const patch = technologyKindPatch(headNode(node, first), technology) as Partial<SeqParticipant> | null;
              sequenceActions.updateParticipant(node.id, first.id, { technology, ...(patch ?? {}) }, 'Change technology');
            }}
            onConfirm={() => setOpenPanel(null)}
          />
        </div>
      )}
    </>
  );
}

function GroupRow({ node, sequence, focus }: RowProps) {
  const group = sequence.groups?.find((entry) => entry.id === focus.ids[0]);
  if (!group) return null;
  return (
    <div className="dc-popover-row dc-popover-config dc-element-identity-row">
      <span className="dc-seq-count">Group of {group.participantIds.length}</span>
      <span className="dc-popover-divider" aria-hidden="true" />
      <TooltipGroup>
        <Direct icon="pencil" label="Rename" description="Change the group's name." onClick={() => sequenceActions.edit(node.id, { kind: 'group', id: group.id })} />
        <Action label="Ungroup" description="Stop drawing these together. They stay where they are." onClick={() => sequenceActions.ungroup(node.id, group.id)} />
      </TooltipGroup>
    </div>
  );
}

function BranchRow({ node, sequence, focus }: RowProps) {
  const found = findOperand(sequence, focus.ids[0] ?? '');
  if (!found) return null;
  const { fragment, operand, index } = found;
  const several = fragment.operands.length > 1;
  return (
    <>
      <div className="dc-popover-row dc-popover-config dc-element-identity-row">
        <span className="dc-seq-count">
          Branch {index + 1} of {fragment.operands.length}
        </span>
        <span className="dc-popover-divider" aria-hidden="true" />
        <TooltipGroup>
          <Direct icon="pencil" label="Edit condition" description="When this branch happens." onClick={() => sequenceActions.edit(node.id, { kind: 'guard', id: operand.id })} />
          {several && <Direct icon="trash" danger label="Remove branch" description="Its messages move into the branch beside it." onClick={() => sequenceActions.removeBranch(node.id, operand.id)} />}
        </TooltipGroup>
      </div>
      {isBranching(fragment.operator) && (
        <div className="dc-element-action-row">
          <TooltipGroup>
            <Action label="Add branch below" onClick={() => sequenceActions.addBranch(node.id, fragment.id, operand.id)} />
            {index > 0 && <Action label="Move up" onClick={() => sequenceActions.moveBranch(node.id, operand.id, -1)} />}
            {index < fragment.operands.length - 1 && <Action label="Move down" onClick={() => sequenceActions.moveBranch(node.id, operand.id, 1)} />}
            {several && <Action label="Delete with its messages" onClick={() => sequenceActions.removeBranch(node.id, operand.id, true)} />}
          </TooltipGroup>
        </div>
      )}
    </>
  );
}

function ItemRow({ node, sequence, focus, menuDirection, getMenuAvoidRect }: RowProps) {
  const [wrapping, setWrapping] = useState(false);
  const items = focus.ids.map((id) => findItem(sequence, id)?.item).filter((item): item is NonNullable<typeof item> => !!item);
  const [first] = items;
  if (!first) return null;
  const single = items.length === 1 ? first : null;
  const findings = single ? findingsFor(sequence, single.id) : [];

  const wrapPanel = wrapping && (
    <div className="dc-element-action-row">
      <TooltipGroup>
        {WRAPS.map((wrap) => (
          <Action key={wrap.operator} label={wrap.label} description={wrap.description} onClick={() => sequenceActions.wrap(node.id, focus.ids, wrap.operator)} />
        ))}
      </TooltipGroup>
    </div>
  );
  const problems = findings.length > 0 && (
    <div className="dc-seq-findings">
      {findings.map((finding) => (
        <p key={`${finding.kind}:${finding.itemIds.join()}`}>
          <span>{finding.message}</span>
          {finding.fix && (
            <Button variant="quiet" onClick={() => sequenceActions.applyFix(node.id, finding)}>
              {finding.fix.label}
            </Button>
          )}
        </p>
      ))}
    </div>
  );

  if (!single) {
    return (
      <>
        <div className="dc-popover-row dc-popover-config dc-element-identity-row">
          <span className="dc-seq-count">{items.length} selected</span>
          <span className="dc-popover-divider" aria-hidden="true" />
          <TooltipGroup>
            <Button variant="quiet" active={wrapping} aria-expanded={wrapping} onClick={() => setWrapping(!wrapping)}>
              Wrap in…
            </Button>
            <Direct icon="trash" danger label="Delete" description="Remove what is selected." onClick={() => sequenceActions.removeItems(node.id, focus.ids)} />
          </TooltipGroup>
        </div>
        {wrapPanel}
      </>
    );
  }

  if (single.t === 'note') {
    return (
      <div className="dc-popover-row dc-popover-config dc-element-identity-row">
        <span className="dc-seq-count">Note</span>
        <span className="dc-popover-divider" aria-hidden="true" />
        <TooltipGroup>
          <Direct icon="pencil" label="Edit" description="Change what the note says." onClick={() => sequenceActions.edit(node.id, { kind: 'note', id: single.id })} />
          <Direct icon="copy" label="Duplicate" description="A copy directly below." onClick={() => sequenceActions.duplicate(node.id, single.id)} />
          <Direct icon="trash" danger label="Delete" description="Remove this note." onClick={() => sequenceActions.removeItems(node.id, [single.id])} />
        </TooltipGroup>
      </div>
    );
  }

  if (single.t === 'fragment') return <FragmentRow node={node} fragment={single} menuDirection={menuDirection} getMenuAvoidRect={getMenuAvoidRect} problems={problems} />;

  return <MessageRow node={node} sequence={sequence} message={single} menuDirection={menuDirection} getMenuAvoidRect={getMenuAvoidRect} wrapping={wrapping} setWrapping={setWrapping} wrapPanel={wrapPanel} problems={problems} />;
}

function FragmentRow({
  node,
  fragment,
  menuDirection,
  getMenuAvoidRect,
  problems,
}: Pick<RowProps, 'node' | 'menuDirection' | 'getMenuAvoidRect'> & { fragment: SeqFragment; problems: React.ReactNode }) {
  const empty = fragment.operands.every((branch) => branch.items.length === 0);
  if (fragment.operator === 'ref') {
    return (
      <div className="dc-popover-row dc-popover-config dc-element-identity-row">
        <span className="dc-seq-count">Reference</span>
        <span className="dc-popover-divider" aria-hidden="true" />
        <TooltipGroup>
          <Direct icon="pencil" label="Edit" description="Name the interaction this stands for." onClick={() => sequenceActions.edit(node.id, { kind: 'reference', id: fragment.id })} />
          <Direct icon="trash" danger label="Delete" description="Remove this reference." onClick={() => sequenceActions.removeItems(node.id, [fragment.id])} />
        </TooltipGroup>
      </div>
    );
  }
  return (
    <>
      <div className="dc-popover-row dc-popover-config dc-element-identity-row">
        <InspectorSelect
          ariaLabel="Fragment kind"
          value={fragment.operator}
          options={OPERATOR_OPTIONS}
          onChange={(value) => sequenceActions.setOperator(node.id, fragment.id, value as SeqOperator)}
          preferredDirection={menuDirection}
          getAvoidRect={getMenuAvoidRect}
        />
        <span className="dc-popover-divider" aria-hidden="true" />
        <TooltipGroup>
          <Direct icon="copy" label="Duplicate" description="A copy directly below, with everything in it." onClick={() => sequenceActions.duplicate(node.id, fragment.id)} />
          <Direct
            icon="trash"
            danger
            label={empty ? 'Delete' : 'Delete with its messages'}
            description={empty ? 'Remove this fragment.' : 'Remove the fragment and everything in it. Unwrap keeps the messages.'}
            onClick={() => sequenceActions.removeItems(node.id, [fragment.id])}
          />
        </TooltipGroup>
      </div>
      <div className="dc-element-action-row">
        <TooltipGroup>
          {!empty && <Action label="Unwrap" description="Remove the frame and keep its messages where they are." shortcut="Delete" onClick={() => sequenceActions.unwrap(node.id, fragment.id)} />}
          {isBranching(fragment.operator) && <Action label={fragment.operator === 'alt' ? 'Add else branch' : 'Add branch'} onClick={() => sequenceActions.addBranch(node.id, fragment.id)} />}
        </TooltipGroup>
      </div>
      {problems}
    </>
  );
}

function MessageRow({
  node,
  sequence,
  message,
  menuDirection,
  getMenuAvoidRect,
  wrapping,
  setWrapping,
  wrapPanel,
  problems,
}: Pick<RowProps, 'node' | 'sequence' | 'menuDirection' | 'getMenuAvoidRect'> & {
  message: SeqMessage;
  wrapping: boolean;
  setWrapping: (on: boolean) => void;
  wrapPanel: React.ReactNode;
  problems: React.ReactNode;
}) {
  const suggestion = suggestedKind(sequence, message);
  const options: InspectorSelectOption[] = (Object.keys(MESSAGE_KINDS) as SeqMessageKind[]).map((kind) => ({
    value: kind,
    label: MESSAGE_KINDS[kind].label,
    description: MESSAGE_KINDS[kind].description,
  }));
  const slot = slotOf(sequence, message.id);
  const answered = message.kind !== 'reply' && message.from !== message.to;
  const starts = message.kind !== 'reply' && message.kind !== 'destroy';

  return (
    <>
      <div className="dc-popover-row dc-popover-config dc-element-identity-row">
        <InspectorSelect
          ariaLabel="Message kind"
          value={message.kind}
          options={options}
          onChange={(value) => sequenceActions.setKind(node.id, message.id, value as SeqMessageKind)}
          preferredDirection={menuDirection}
          getAvoidRect={getMenuAvoidRect}
          layout="rich"
        />
        {starts && (
          <Tooltip content={{ title: 'Starts work', description: 'Whether the receiver is shown working from here: the bar on its lifeline.' }}>
            {(tip) => (
              <Button variant="quiet" active={Boolean(message.activate)} {...tip} onClick={() => sequenceActions.setActivates(node.id, message.id, !message.activate)}>
                Starts work
              </Button>
            )}
          </Tooltip>
        )}
        {!starts && message.kind === 'reply' && (
          <Tooltip content={{ title: 'Ends work', description: 'Whether the sender’s bar stops as this leaves.' }}>
            {(tip) => (
              <Button variant="quiet" active={Boolean(message.deactivate)} {...tip} onClick={() => sequenceActions.setDeactivates(node.id, message.id, !message.deactivate)}>
                Ends work
              </Button>
            )}
          </Tooltip>
        )}
        <span className="dc-popover-divider" aria-hidden="true" />
        <TooltipGroup>
          <Direct icon="pencil" label="Edit" description="Change what the message says." onClick={() => sequenceActions.edit(node.id, { kind: 'message', id: message.id })} />
          <Direct icon="copy" label="Duplicate" description="A copy directly below." onClick={() => sequenceActions.duplicate(node.id, message.id)} />
          <Direct icon="trash" danger label="Delete" description="Remove this message." onClick={() => sequenceActions.removeItems(node.id, [message.id])} />
        </TooltipGroup>
      </div>
      {suggestion && (
        <div className="dc-seq-suggestion">
          <span>{suggestion.reason}</span>
          <Button variant="quiet" onClick={() => sequenceActions.setKind(node.id, message.id, suggestion.kind)}>
            Make it {MESSAGE_KINDS[suggestion.kind].label.toLowerCase()}
          </Button>
        </div>
      )}
      <div className="dc-element-action-row">
        <TooltipGroup>
          {answered && <Action label="Add reply" description="What comes back, below whatever this call sets going." onClick={() => sequenceActions.addReply(node.id, message.id)} />}
          {message.from !== message.to && <Action label="Reverse" description="Swap who sends and who receives." onClick={() => sequenceActions.reverse(node.id, message.id)} />}
          {slot && <Action label="Add note" description="A note beside this message." onClick={() => sequenceActions.addNote(node.id, [...participantsIn(message)].slice(0, 2), { operandId: slot.operandId, index: slot.index + 1 })} />}
          <Button variant="quiet" className="dc-popover-action dc-element-action-tile" active={wrapping} aria-expanded={wrapping} onClick={() => setWrapping(!wrapping)}>
            Wrap in…
          </Button>
        </TooltipGroup>
      </div>
      {wrapPanel}
      {problems}
    </>
  );
}
