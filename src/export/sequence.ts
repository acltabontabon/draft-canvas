/**
 * SequenceModel -> source text: build the model and render it. There is no image/rendered export
 * here — the source text IS the product (see `docs/reference/architecture.md`). The Export dialog's
 * Source mode and the agent tools download or return that text themselves.
 *
 * A document is a tree of rooms and a Flow belongs to the room it was drawn in, so the source is
 * one section per room that has something to play, in tree order, each under a comment naming
 * the room's path. Within a section every room's flows are rendered exactly as a flat canvas's are
 * — one diagram, one group per flow — and a canvas with no rooms at all reads exactly as it always
 * did, comment and all.
 */
import { flowIsPlayable } from '../document/flow';
import type { DraftDocument, DraftNode } from '../document/types';
import { buildSequenceModel, toMermaid, toPlantUml } from '../sequence';
import { sequenceToMermaid } from '../sequence/native/mermaid';
import { sequenceToPlantUml } from '../sequence/native/plantuml';
import { escapeMermaidText } from '../sequence/mermaid';
import { collectRooms, roomTitleFor } from './rooms';

export { MERMAID_EXTENSION, PLANTUML_EXTENSION } from './source/formats';

export type SequenceFormat = 'mermaid' | 'plantuml';

const COMMENT: Record<SequenceFormat, string> = { mermaid: '%%', plantuml: "'" };

function render(document: DraftDocument, format: SequenceFormat): string {
  const model = buildSequenceModel(document);
  return format === 'mermaid' ? toMermaid(model) : toPlantUml(model);
}

/** Mermaid lifts `%%{ … }%%` directives out of text even inside a `%%` comment, so a shape or title
 * named like one would reconfigure the renderer of whoever opens the source. */
function roomLabel(room: Parameters<typeof roomTitleFor>[0], format: SequenceFormat): string {
  const title = roomTitleFor(room);
  return format === 'mermaid' ? escapeMermaidText(title) : title;
}

export function playableCount(document: DraftDocument): number {
  return document.flows.filter((flow) => flowIsPlayable(document, flow)).length;
}

/** How many Flows the source will carry — across every room, since the source does. */
export function countPlayableFlows(document: DraftDocument): number {
  return collectRooms(document).reduce((sum, room) => sum + playableCount(room.document), 0);
}

/**
 * The sequence source text for the whole document's playable Flows, in the requested format —
 * one function for both formats, so they can't drift from each other.
 *
 * A Mermaid text is one diagram: a second `sequenceDiagram` header is a syntax error that Mermaid
 * refuses the whole text over, and a re-import read both as one. So a document with more than one
 * (Flows in several rooms, a sequence beside them) is Markdown, one ```` ```mermaid ```` block per
 * diagram, which Markdown pages, Mermaid's own CLI and the importer read block by block; its file
 * is `.md` (`sourceFileNameFor`). PlantUML takes any number of `@startuml` blocks in one file.
 */
export function sequenceSourceFor(document: DraftDocument, format: SequenceFormat): string {
  const rooms = collectRooms(document);
  const sections: { room: string | null; diagrams: string[] }[] = [];
  for (const room of rooms) {
    // A room's Flows as one diagram, then each sequence drawn in it as a diagram of its own — a
    // sequence is already a whole interaction, not a group inside someone else's.
    const diagrams: string[] = [];
    if (playableCount(room.document) > 0) diagrams.push(render(room.document, format));
    for (const node of sequencesIn(room.document)) diagrams.push(format === 'mermaid' ? sequenceToMermaid(node) : sequenceToPlantUml(node));
    if (diagrams.length === 0) continue;
    sections.push({ room: rooms.length === 1 ? null : `${COMMENT[format]} Room: ${roomLabel(room, format)}\n`, diagrams });
  }
  // Nothing to play anywhere: the same empty diagram a flat canvas without Flows produces.
  if (sections.length === 0) return render(document, format);
  // Each diagram already ends in a newline; one more leaves a blank line between them.
  if (format === 'mermaid' && sections.reduce((sum, section) => sum + section.diagrams.length, 0) > 1) {
    return sections.flatMap((section) => section.diagrams.map((diagram) => `\`\`\`mermaid\n${section.room ?? ''}${diagram}\`\`\`\n`)).join('\n');
  }
  return sections.map((section) => `${section.room ?? ''}${section.diagrams.join('\n')}`).join('\n');
}

/** The sequences a view holds that have anyone in them: an empty frame is not yet a diagram. */
function sequencesIn(document: DraftDocument): DraftNode[] {
  return document.nodes.filter((node) => node.type === 'sequence' && (node.sequence?.participants.length ?? 0) > 0);
}

/** How many diagrams the source holds: each room's Flows as one, and each sequence. */
export function countSequenceDiagrams(document: DraftDocument): number {
  return collectRooms(document).reduce((sum, room) => sum + (playableCount(room.document) > 0 ? 1 : 0) + sequencesIn(room.document).length, 0);
}

/** How many sequences the source will carry — across every room, since the source does. */
export function countSequences(document: DraftDocument): number {
  return collectRooms(document).reduce((sum, room) => sum + sequencesIn(room.document).length, 0);
}
