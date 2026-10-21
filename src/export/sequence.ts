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
import type { DraftDocument } from '../document/types';
import { buildSequenceModel, toMermaid, toPlantUml } from '../sequence';
import { collectRooms, roomTitleFor } from './rooms';

export { MERMAID_EXTENSION, PLANTUML_EXTENSION } from './source/formats';

export type SequenceFormat = 'mermaid' | 'plantuml';

const COMMENT: Record<SequenceFormat, string> = { mermaid: '%%', plantuml: "'" };

function render(document: DraftDocument, format: SequenceFormat): string {
  const model = buildSequenceModel(document);
  return format === 'mermaid' ? toMermaid(model) : toPlantUml(model);
}

function playableCount(document: DraftDocument): number {
  return document.flows.filter((flow) => flowIsPlayable(document, flow)).length;
}

/** How many Flows the source will carry — across every room, since the source does. */
export function countPlayableFlows(document: DraftDocument): number {
  return collectRooms(document).reduce((sum, room) => sum + playableCount(room.document), 0);
}

/**
 * The sequence source text for the whole document's playable Flows, in the requested format —
 * one function for both formats, so they can't drift from each other.
 */
export function sequenceSourceFor(document: DraftDocument, format: SequenceFormat): string {
  const rooms = collectRooms(document);
  if (rooms.length === 1) return render(document, format);
  const sections = rooms
    .filter((room) => playableCount(room.document) > 0)
    .map((room) => `${COMMENT[format]} Room: ${roomTitleFor(room)}\n${render(room.document, format)}`);
  // Nothing to play anywhere: the same empty diagram a flat canvas without Flows produces.
  if (sections.length === 0) return render(document, format);
  // Each section already ends in a newline; one more leaves a blank line between diagrams.
  return sections.join('\n');
}
