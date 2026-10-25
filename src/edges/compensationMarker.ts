import type { DraftEdge, DraftNode, EdgeAnchor } from '../document/types';
import { rectOf, routeBetween } from './routing';

/** Start a newly connected recovery on the neighbouring side of the source shape. This keeps
 * the action from painting over the original call and gives the association thread two exits. */
export function recoveryBranchAnchor(parent: DraftEdge, source: DraftNode, parentTarget: DraftNode, recoveryTarget: DraftNode): EdgeAnchor {
  const originalSide = routeBetween(rectOf(source), rectOf(parentTarget), parent.routing, {
    anchors: { source: parent.sourceAnchor, target: parent.targetAnchor },
    waypoints: parent.waypoints,
  }).source.side;
  const sourceCenterX = source.x + source.width / 2;
  const sourceCenterY = source.y + source.height / 2;
  const targetCenterX = recoveryTarget.x + recoveryTarget.width / 2;
  const targetCenterY = recoveryTarget.y + recoveryTarget.height / 2;
  const side = originalSide === 'left' || originalSide === 'right'
    ? targetCenterY >= sourceCenterY ? 'bottom' : 'top'
    : targetCenterX >= sourceCenterX ? 'right' : 'left';
  return { side, offset: 0.5 };
}

/** A named action remains recognizable when its operation has not been filled in yet. */
export function compensationActionCaption(name: string | undefined, fallback: string): string {
  return name?.trim() ? name.trim() : fallback;
}

/** The business action names the recovery arrow; its HTTP or call operation remains editable
 * in the companion card. An unnamed action still shows that operation on the canvas. */
export function compensationDisplayLabel(edge: Pick<DraftEdge, 'compensationFor' | 'compensationName' | 'label'>): string | undefined {
  return edge.compensationFor && edge.compensationName?.trim() ? edge.compensationName.trim() : edge.label;
}

/** A named recovery can also have an operation. Keep both on its arrow instead of letting
 * the business name replace the HTTP/call detail the person just entered. */
export function compensationLabelParts(edge: Pick<DraftEdge, 'compensationFor' | 'compensationName' | 'label'>): { name: string; operation: string } | null {
  const name = edge.compensationFor ? edge.compensationName?.trim() : undefined;
  const operation = edge.label?.trim();
  return name && operation && name !== operation ? { name, operation } : null;
}
