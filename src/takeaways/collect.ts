/**
 * What came out of the discussion, read back off the document.
 *
 * A derivation, in the sense `docs/ARCHITECTURE.md` uses the word: the only thing this feature
 * stores is `DraftDocument.actions`. Decisions and open questions are not a second copy of
 * anything — they are the `note` nodes and note attachments already in the file, tagged
 * `decision` or `question` (`NoteKind`), gathered from every room. Which is why Takeaways has
 * something to show on a diagram drawn long before it existed, with no migration involved.
 *
 * `warning` is deliberately left out. A warning annotates the architecture — "this path is
 * unbounded" — and stays true of the drawing tomorrow; a decision, a question and an action are
 * outcomes of a conversation, and they are what this surface is for.
 *
 * Pure and framework-free, like the model it reads. Imports `document/` and `depth/` and nothing
 * else, so listing what a canvas produced never pulls in a renderer.
 */

import { displayNameFor } from '../document/factory';
import type { DraftAction, DraftDocument, DraftEdge, DraftNode, NoteKind } from '../document/types';
import { walkGraphs, type DepthPath } from '../depth/tree';

/** Where a row points, and what it is called. Both kinds resolve through the same navigation. */
export interface TakeawayTarget {
  kind: 'node' | 'edge';
  id: string;
  /** What to call it on screen — "Payment Service", or "Payment Service → Settlement Service". */
  label: string;
  /** Owner ids from the document outward-in; `[]` when it lives on the top-level canvas. */
  path: DepthPath;
  /** The name of the room it lives in, when that isn't the document itself. */
  room?: string;
}

/** One decision or open question, wherever in the file it was written. */
export interface TakeawayNote {
  /** The note node's id, or the attachment's — unique file-wide either way, so it keys a list. */
  id: string;
  kind: Extract<NoteKind, 'decision' | 'question'>;
  text: string;
  /** What to reveal when the row is clicked: the note itself, or the shape holding it. */
  target: TakeawayTarget;
}

export interface TakeawayAction {
  action: DraftAction;
  /** Absent when the action belongs to the whole canvas, or when its anchor no longer resolves. */
  context?: TakeawayTarget;
}

export interface Takeaways {
  decisions: TakeawayNote[];
  questions: TakeawayNote[];
  actions: TakeawayAction[];
}

/** Nothing was decided, asked or assigned — the state most canvases are in, forever. */
export function isEmpty(takeaways: Takeaways): boolean {
  return (
    takeaways.decisions.length === 0 && takeaways.questions.length === 0 && takeaways.actions.length === 0
  );
}

/** How many actions are still open — the one number the status bar shows. */
export function openCount(takeaways: Takeaways): number {
  return takeaways.actions.reduce((total, entry) => (entry.action.done ? total : total + 1), 0);
}

function edgeLabel(edge: DraftEdge, nodes: Map<string, DraftNode>): string {
  const from = nodes.get(edge.source);
  const to = nodes.get(edge.target);
  // Matches how the command palette names a flow step, so a connector is called the same thing
  // wherever the product talks about one.
  return `${from ? displayNameFor(from) : '?'} → ${to ? displayNameFor(to) : '?'}`;
}

/**
 * An index of every element in the file, by id, with the room it lives in.
 *
 * Built once per read rather than per row: a 200-node file with 20 actions would otherwise walk
 * every room 20 times over. Ids are unique file-wide (`validate.ts`), so one flat map is enough
 * and no anchor needs to carry a path of its own.
 */
interface FileIndex {
  nodes: Map<string, { node: DraftNode; path: DepthPath; room?: string }>;
  edges: Map<string, { edge: DraftEdge; path: DepthPath; room?: string; label: string }>;
}

export function indexFile(file: DraftDocument): FileIndex {
  const index: FileIndex = { nodes: new Map(), edges: new Map() };
  // Room names come from the node that owns the room, so they are resolved against the *outer*
  // graph — which `walkGraphs` has already visited by the time it reaches the room itself.
  const ownerNames = new Map<string, string>();

  walkGraphs(file, (graph, path) => {
    const room = path.length === 0 ? undefined : ownerNames.get(path[path.length - 1]!);
    const here = new Map<string, DraftNode>();
    for (const node of graph.nodes) {
      here.set(node.id, node);
      ownerNames.set(node.id, displayNameFor(node));
      index.nodes.set(node.id, room === undefined ? { node, path } : { node, path, room });
    }
    for (const edge of graph.edges) {
      const label = edgeLabel(edge, here);
      index.edges.set(edge.id, room === undefined ? { edge, path, label } : { edge, path, room, label });
    }
  });

  return index;
}

/** The label, room and path for an action's anchor, or `undefined` if it no longer resolves. */
export function resolveTarget(index: FileIndex, kind: 'node' | 'edge', id: string): TakeawayTarget | undefined {
  if (kind === 'node') {
    const found = index.nodes.get(id);
    if (!found) return undefined;
    const target: TakeawayTarget = { kind: 'node', id, label: displayNameFor(found.node), path: found.path };
    if (found.room !== undefined) target.room = found.room;
    return target;
  }
  const found = index.edges.get(id);
  if (!found) return undefined;
  const target: TakeawayTarget = { kind: 'edge', id, label: found.label, path: found.path };
  if (found.room !== undefined) target.room = found.room;
  return target;
}

function isOutcome(kind: NoteKind | undefined): kind is Extract<NoteKind, 'decision' | 'question'> {
  return kind === 'decision' || kind === 'question';
}

/**
 * Everything the meeting produced, in reading order: notes in the order they sit in each room,
 * document before rooms; actions in the order they were captured.
 */
export function takeawaysFor(file: DraftDocument): Takeaways {
  const index = indexFile(file);
  const decisions: TakeawayNote[] = [];
  const questions: TakeawayNote[] = [];

  const collect = (note: TakeawayNote) => {
    (note.kind === 'decision' ? decisions : questions).push(note);
  };

  walkGraphs(file, (graph) => {
    for (const node of graph.nodes) {
      // A note written straight onto the canvas. Its own text is the outcome; it points at itself.
      if (node.type === 'note' && isOutcome(node.noteKind)) {
        const text = node.text?.trim();
        const target = resolveTarget(index, 'node', node.id);
        if (text && target) collect({ id: node.id, kind: node.noteKind, text, target });
      }
      // A note folded into a shape. It points at its host, which is what "go to it" means for
      // something that has no position of its own.
      for (const attachment of node.attachments ?? []) {
        if (attachment.type !== 'note' || !isOutcome(attachment.noteKind)) continue;
        const text = attachment.text?.trim();
        const target = resolveTarget(index, 'node', node.id);
        if (text && target) collect({ id: attachment.id, kind: attachment.noteKind, text, target });
      }
    }
    for (const edge of graph.edges) {
      for (const attachment of edge.attachments ?? []) {
        if (attachment.type !== 'note' || !isOutcome(attachment.noteKind)) continue;
        const text = attachment.text?.trim();
        const target = resolveTarget(index, 'edge', edge.id);
        if (text && target) collect({ id: attachment.id, kind: attachment.noteKind, text, target });
      }
    }
  });

  const actions: TakeawayAction[] = file.actions.map((action) => {
    const context = action.anchor ? resolveTarget(index, action.anchor.kind, action.anchor.id) : undefined;
    return context ? { action, context } : { action };
  });

  return { decisions, questions, actions };
}
