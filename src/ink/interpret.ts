/**
 * What a recognized drawing means *here*: which Draft Canvas element it could become, given the
 * shapes around it — or that it should stay ink.
 *
 * Geometry is evidence of a silhouette, never of architecture. A rectangle is offered as the
 * generic Component first because a box says nothing more; a cylinder is a Data Store because that
 * is the silhouette Draft Canvas draws one with. Nothing here guesses a technology, a protocol, a
 * deployment or a responsibility. The canvas only ever adds two kinds of evidence:
 *
 * - **Containment.** A box drawn around existing shapes is offered as their Boundary; a circle drawn
 *   around them is someone circling them — emphasis, so it stays ink.
 * - **Endpoints.** A line or arrow whose two ends land on two different shapes is a connector between
 *   them. One that starts or ends in empty space, or both ends on the same shape (an underline), is not.
 *
 * Anything overlapping existing shapes without enclosing them is annotation on them and stays ink.
 */
import type { DraftNodeType } from '../document/types';
import type { InkShapeChoice } from './choices';
import { boxContains, boxIntersects, distToSegment, pointInBox, type Box, type Pt } from './geometry';
import type { InkGeometry, Recognition } from './recognize';
import { CONVERT_CONFIDENCE, END_REACH_PX, ENCLOSE_TOLERANCE_PX, FORCED_OFFER_FRACTION, LARGE_BOX, OFFER_CONFIDENCE, SMALL_CIRCLE } from './thresholds';

/** A shape on the canvas, as the interpreter needs it. */
export interface InkContextNode {
  id: string;
  type: DraftNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InkInterpretation =
  | {
      kind: 'shape';
      geometry: InkGeometry;
      /** Where it was drawn, in room coordinates. */
      box: Box;
      /** Recommended first. */
      choices: InkShapeChoice[];
      /** Convert as drawn (true), or only offer (false). */
      confident: boolean;
      /** Shapes the drawing goes round — what a Boundary made from it would hold. */
      encloses: string[];
    }
  | { kind: 'connector'; source: string; target: string; directed: boolean; confident: boolean }
  | { kind: 'none'; reason: 'unrecognized' | 'annotation' | 'unanchored' | 'same-shape' };

export function interpret(recognition: Recognition, nodes: readonly InkContextNode[], options: { scale: number; forced?: boolean }): InkInterpretation {
  const { geometry, confidence } = recognition;
  // Asked for explicitly ("Convert to shape"), a weaker reading is still worth offering.
  const offerAt = options.forced ? OFFER_CONFIDENCE * FORCED_OFFER_FRACTION : OFFER_CONFIDENCE;
  if (!geometry || confidence < offerAt) return { kind: 'none', reason: 'unrecognized' };
  const confident = confidence >= CONVERT_CONFIDENCE && !options.forced;

  if (geometry === 'line' || geometry === 'arrow') {
    const line = recognition.line;
    if (!line) return { kind: 'none', reason: 'unrecognized' };
    // A hand lands a little short of, or a little past, the shape it means: forgive a few pixels.
    const reach = END_REACH_PX / Math.max(options.scale, 0.05);
    const source = shapeAt(line.from, nodes, reach);
    const target = shapeAt(line.to, nodes, reach);
    if (!source || !target) return { kind: 'none', reason: 'unanchored' };
    if (source.id === target.id) return { kind: 'none', reason: 'same-shape' };
    // A line that merely grazes across a third shape is still a connector between the two it joins
    // (routing will take it round); but one that *starts and ends* inside one shape's own area
    // overlapping another (an underline across two touching shapes) is not.
    if (insideBoth(line.from, line.to, source, target)) return { kind: 'none', reason: 'same-shape' };
    return { kind: 'connector', source: source.id, target: target.id, directed: line.heads !== 'none', confident };
  }

  const box = recognition.box;
  const tolerance = ENCLOSE_TOLERANCE_PX / Math.max(options.scale, 0.05);
  const encloses: string[] = [];
  let overlaps = false;
  let container: InkContextNode | undefined;
  for (const node of nodes) {
    if (boxContains(box, node, tolerance)) encloses.push(node.id);
    else if (boxContains(node, box, tolerance)) {
      // Drawn inside a boundary: a part of what it holds. Drawn inside any other shape: a mark on it.
      if (node.type !== 'group') overlaps = true;
      else if (!container || node.width * node.height < container.width * container.height) container = node;
    } else if (boxIntersects(box, node)) overlaps = true;
  }
  if (overlaps) return { kind: 'none', reason: 'annotation' };

  const choices = choicesFor(geometry, box, encloses.length > 0);
  if (!choices) return { kind: 'none', reason: encloses.length > 0 ? 'annotation' : 'unrecognized' };
  return { kind: 'shape', geometry, box, choices, confident, encloses };
}

function choicesFor(geometry: InkGeometry, box: Box, enclosing: boolean): InkShapeChoice[] | null {
  switch (geometry) {
    case 'rectangle':
      if (enclosing) return ['boundary'];
      return box.width >= LARGE_BOX.width && box.height >= LARGE_BOX.height
        ? ['boundary', 'component', 'service', 'note']
        : ['component', 'service', 'boundary', 'note'];
    case 'ellipse':
      // Circling shapes is pointing at them.
      if (enclosing) return null;
      return Math.max(box.width, box.height) <= SMALL_CIRCLE ? ['junction', 'actor', 'component'] : ['component', 'actor', 'service', 'junction'];
    case 'cylinder':
      return enclosing ? null : ['database', 'queue', 'component'];
    case 'tube':
      return enclosing ? null : ['queue', 'database', 'component'];
    case 'person':
      return enclosing ? null : ['actor', 'component'];
    default:
      return null;
  }
}

/**
 * The shape a line's end lands on: the smallest one whose box (grown by `reach`) holds the point.
 * A Boundary only counts at its frame — an end inside its area is meant for what is in it, or for
 * nothing at all.
 */
function shapeAt(point: Pt, nodes: readonly InkContextNode[], reach: number): InkContextNode | undefined {
  let best: InkContextNode | undefined;
  for (const node of nodes) {
    if (!pointInBox(point, node, reach)) continue;
    if (node.type === 'group' && !nearFrame(point, node, reach)) continue;
    if (!best || node.width * node.height < best.width * best.height || (best.type === 'group' && node.type !== 'group')) best = node;
  }
  return best;
}

function nearFrame(point: Pt, box: Box, reach: number): boolean {
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
  for (let i = 0; i < 4; i += 1) if (distToSegment(point, corners[i]!, corners[(i + 1) % 4]!) <= reach) return true;
  return false;
}

function insideBoth(from: Pt, to: Pt, a: Box, b: Box): boolean {
  return pointInBox(from, a) && pointInBox(from, b) && pointInBox(to, a) && pointInBox(to, b);
}
