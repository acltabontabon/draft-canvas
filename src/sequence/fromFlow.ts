/**
 * A Flow, drawn as a sequence.
 *
 * A Flow is an order somebody gave to the connectors of an architecture — so, unlike the connectors
 * alone, it does say who calls whom first, and it can be turned into a sequence without guessing.
 * The reading is the one the Flow's own Mermaid and PlantUML export has always used
 * (`build.ts`); this takes that reading and makes it something that can be edited on the canvas,
 * with each participant still standing for the shape it came from.
 */
import { createId } from '../document/ids';
import { isLinkable, participantFromNode } from '../document/sequenceLinks';
import { normalizeSequence } from '../document/validateSequence';
import type { DraftDocument, DraftSequence, SeqItem, SeqMessage, SeqParticipant } from '../document/types';
import { buildSequenceModel } from './build';
import type { SequenceElement } from './types';

export function sequenceFromFlow(document: DraftDocument, flowId: string): { title: string; sequence: DraftSequence } | null {
  const model = buildSequenceModel(document);
  const group = model.elements.find((element) => element.kind === 'group' && element.sourceFlowId === flowId);
  if (!group || group.kind !== 'group') return null;

  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const participants: SeqParticipant[] = [];
  const idOf = new Map<string, string>();
  const standIn = (modelId: string): string => {
    const known = idOf.get(modelId);
    if (known) return known;
    const source = model.participants.find((participant) => participant.id === modelId);
    const shape = source ? nodes.get(source.sourceNodeId) : undefined;
    const id = createId('sp');
    participants.push(shape && isLinkable(shape) ? participantFromNode(shape, id) : { id, name: source?.label ?? 'Participant', type: 'service', serviceKind: 'generic' });
    idOf.set(modelId, id);
    return id;
  };

  const waiting: SeqMessage[] = [];
  const read = (elements: readonly SequenceElement[]): SeqItem[] => {
    const items: SeqItem[] = [];
    for (const element of elements) {
      if (element.kind === 'group') {
        items.push(...read(element.children));
      } else if (element.kind === 'note') {
        items.push({ id: createId('sn'), t: 'note', text: element.text, over: element.participantIds.map(standIn) });
      } else {
        const from = standIn(element.from);
        const to = standIn(element.to);
        const message: SeqMessage = { id: createId('sm'), t: 'message', from, to, kind: element.interaction === 'response' ? 'reply' : element.interaction, label: element.label };
        if (message.kind === 'sync' && from !== to) {
          message.activate = true;
          waiting.push(message);
        } else if (message.kind === 'reply') {
          const at = waiting.findLastIndex((call) => call.from === to && call.to === from);
          if (at >= 0) {
            message.replyTo = waiting.splice(at, 1)[0]!.id;
            message.deactivate = true;
          }
        }
        items.push(message);
      }
    }
    return items;
  };
  const items = read(group.children);
  if (participants.length === 0) return null;
  return { title: group.label, sequence: normalizeSequence({ participants, items }).sequence };
}
