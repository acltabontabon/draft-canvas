/**
 * A sequence told as a story.
 *
 * Presenting a sequence steps through its messages with the same playback, bar and camera that
 * present a Flow — so the sequence is handed to them as a flow: one step per message, in the order
 * they are drawn. It is worked out from the sequence each time it is asked for and never saved, so
 * a file's Flows stay exactly what its author made, and reordering a message reorders the telling
 * with nothing to keep in step.
 *
 * Each step's caption says what the message says and where it sits: the condition it happens
 * under, and — inside a `par` — that its branch runs alongside the others, so stepping through
 * them one after another is never read as "this, then that".
 */
import { sequenceOf } from './sequenceModel';
import type { DraftDocument, DraftFlow, DraftFlowStep, DraftNode, SeqItem, SeqMessage } from './types';

const PREFIX = 'seq:';

/** The id playback knows a sequence's own telling by. */
export const sequenceFlowId = (nodeId: string): string => `${PREFIX}${nodeId}`;

const KIND_WORDS: Record<SeqMessage['kind'], string> = { sync: 'Call', async: 'Message', reply: 'Reply', create: 'Create', destroy: 'Destroy' };

function steps(node: DraftNode): DraftFlowStep[] {
  const out: DraftFlowStep[] = [];
  const visit = (items: readonly SeqItem[], context: readonly string[]) => {
    for (const item of items) {
      if (item.t === 'message') {
        const words = item.label.trim() || KIND_WORDS[item.kind];
        out.push({ id: item.id, extraNodeIds: [node.id], caption: context.length > 0 ? `${context.join(' · ')} — ${words}` : words });
      } else if (item.t === 'fragment') {
        item.operands.forEach((branch, index) => {
          const here =
            item.operator === 'par'
              ? `in parallel, branch ${index + 1} of ${item.operands.length}`
              : branch.guard
                ? `[${branch.guard}]`
                : item.operator === 'alt' && index > 0
                  ? '[else]'
                  : item.operator;
          visit(branch.items, [...context, here]);
        });
      }
    }
  };
  visit(sequenceOf(node).items, []);
  return out;
}

const told = new WeakMap<DraftNode, DraftFlow>();

/** A sequence node as a flow: one step per message. The same object for the same node. */
export function sequenceFlow(node: DraftNode): DraftFlow {
  let flow = told.get(node);
  if (!flow) {
    flow = { id: sequenceFlowId(node.id), title: node.text?.trim() || 'Sequence', steps: steps(node) };
    told.set(node, flow);
  }
  return flow;
}

/**
 * The flow playback is asked to tell: one of the document's own, or a sequence's telling of
 * itself. What every reader of `flowPlayback.flowId` uses — never the editing operations, which
 * only ever touch the flows a file really holds.
 */
export function playbackFlowOf(
  document: Pick<DraftDocument, 'flows' | 'nodes'>,
  flowId: string | null | undefined,
  sequenceNodeId?: string,
): DraftFlow | undefined {
  if (sequenceNodeId !== undefined) {
    const node = sequencesIn(document.nodes).get(sequenceNodeId);
    return node ? sequenceFlow(node) : undefined;
  }
  if (!flowId) return undefined;
  let byId = savedFlows.get(document.flows);
  if (!byId) {
    byId = new Map(document.flows.map((flow) => [flow.id, flow]));
    savedFlows.set(document.flows, byId);
  }
  return byId.get(flowId);
}

const savedFlows = new WeakMap<readonly DraftFlow[], Map<string, DraftFlow>>();

/** The message a playback step is about, when the step is one of a sequence's own. */
export function messageOfStep(host: DraftNode | undefined, stepId: string): SeqMessage | undefined {
  if (host?.type !== 'sequence') return undefined;
  const sequence = sequenceOf(host);
  let byId = messages.get(sequence);
  if (!byId) {
    byId = new Map();
    const collect = (items: readonly SeqItem[]) => {
      for (const item of items) {
        if (item.t === 'message') byId!.set(item.id, item);
        else if (item.t === 'fragment') for (const branch of item.operands) collect(branch.items);
      }
    };
    collect(sequence.items);
    messages.set(sequence, byId);
  }
  return byId.get(stepId);
}

const messages = new WeakMap<object, Map<string, SeqMessage>>();

/**
 * The sequence nodes of a view, by id. Kept per `nodes` array: every shape on the canvas asks which
 * flow is playing on every store update while one is, and must not scan the document to find out.
 */
const sequences = new WeakMap<readonly DraftNode[], Map<string, DraftNode>>();
function sequencesIn(nodes: readonly DraftNode[]): Map<string, DraftNode> {
  let byId = sequences.get(nodes);
  if (!byId) {
    byId = new Map(nodes.filter((node) => node.type === 'sequence').map((node) => [node.id, node]));
    sequences.set(nodes, byId);
  }
  return byId;
}
