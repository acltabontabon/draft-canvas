import { describe, expect, it } from 'vitest';
import { RAIL_GAP, RAIL_LIFT, RAIL_SIZE, attachmentTabWidth, markerRail } from '../src/document/markerRail';
import { describeAttachmentBadge } from '../src/edges/attachmentChips';
import { createAttachment, createNode } from '../src/document/factory';
import { getMeasurer } from '../src/render/text/measure';
import { LIGHT } from '../src/render/theme/tokens';
import { nodeMarkerOrigin } from '../src/openPoints/marker';
import { technologyMarkBounds } from '../src/nodes/technology';

/** The marks a shape carries above its top-right corner share one row and never overlap. */
describe('the marker rail', () => {
  const node = { type: 'service', width: 176 };

  it('lays every mark in one row above the top edge, from the corner inward', () => {
    const rail = markerRail(node, { technology: true, attachments: 3, openPoints: true });
    const top = -(RAIL_SIZE + RAIL_LIFT);
    expect(rail.technology).toEqual({ x: 176 - RAIL_SIZE, y: top });
    expect(rail.attachments).toEqual({ x: rail.technology!.x - RAIL_GAP - attachmentTabWidth(3), y: top, width: attachmentTabWidth(3) });
    expect(rail.openPoint).toEqual({ x: rail.attachments!.x - RAIL_GAP - RAIL_SIZE, y: top });
  });

  it('closes up when a mark is absent, so the first one always ends at the corner', () => {
    expect(markerRail(node, { openPoints: true }).openPoint!.x).toBe(176 - RAIL_SIZE);
    expect(markerRail(node, { attachments: 1 }).attachments).toMatchObject({ x: 176 - RAIL_SIZE, width: RAIL_SIZE });
    expect(markerRail(node, {})).toEqual({});
  });

  it('keeps a data store\'s technology mark by its glyph and a boundary\'s open point in its corner', () => {
    expect(markerRail({ type: 'database', width: 172 }, { technology: true, attachments: 1 })).toEqual({
      attachments: { x: 172 - RAIL_SIZE, y: -(RAIL_SIZE + RAIL_LIFT), width: RAIL_SIZE },
    });
    const boundary = markerRail({ type: 'group', width: 420 }, { openPoints: true, attachments: 1 });
    expect(boundary.openPoint!.y).toBeGreaterThan(0);
    expect(boundary.openPoint!.x + RAIL_SIZE).toBeLessThan(420);
    expect(boundary.attachments!.x).toBe(420 - RAIL_SIZE);
  });

  it('grows an attachment tab by its count and never for a single attachment', () => {
    expect(attachmentTabWidth(1)).toBe(RAIL_SIZE);
    expect(attachmentTabWidth(2)).toBeGreaterThan(RAIL_SIZE);
    expect(attachmentTabWidth(12)).toBeGreaterThan(attachmentTabWidth(2));
  });

  it('keeps no empty slot for a technology mark drawn beside a glyph, so the first tab still ends at the corner', () => {
    // A Data Store, an Artifact, and a Service or Component drawn as a glyph wear their technology
    // mark by the glyph, inside their own box (`technologyMarkBounds`), never in the rail.
    const beside = [
      createNode({ type: 'service', serviceKind: 'worker', x: 0, y: 0, text: 'Fulfilment', technology: 'Kafka' }),
      createNode({ type: 'service', serviceKind: 'api', x: 0, y: 0, text: 'Orders API', technology: 'Spring Boot' }),
      createNode({ type: 'service', serviceKind: 'gateway', x: 0, y: 0, text: 'Edge', technology: 'NGINX' }),
      createNode({ type: 'component', componentKind: 'adapter', x: 0, y: 0, text: 'Payment adapter', technology: 'Java' }),
      createNode({ type: 'artifact', x: 0, y: 0, text: 'settings.yaml', technology: 'YAML' }),
      createNode({ type: 'database', x: 0, y: 0, text: 'Orders', technology: 'PostgreSQL' }),
    ];
    const top = -(RAIL_SIZE + RAIL_LIFT);
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const base of beside) {
      const node = { ...base, attachments: [createAttachment({ type: 'note', text: 'a' }), createAttachment({ type: 'note', text: 'b' })] };
      const what = `${node.type}/${node.serviceKind ?? node.componentKind ?? ''}`;
      const mark = technologyMarkBounds(node);
      expect(mark, what).toBeDefined();
      const rail = markerRail(node, { technology: true, attachments: 2, openPoints: true });
      expect(rail.technology, what).toBeUndefined();
      expect(rail.attachments, what).toEqual({ x: node.width - attachmentTabWidth(2), y: top, width: attachmentTabWidth(2) });
      expect(rail.openPoint, what).toEqual({ x: rail.attachments!.x - RAIL_GAP - RAIL_SIZE, y: top });
      // The export places both tabs from the same rail, and neither lands on the mark.
      const [tab] = describeAttachmentBadge(node, { theme: LIGHT, measurer: getMeasurer() }, true);
      expect(tab, what).toMatchObject({ t: 'group', translate: { x: rail.attachments!.x, y: top } });
      expect(nodeMarkerOrigin(node, { technology: true, attachments: 2 }), what).toEqual(rail.openPoint);
      expect(overlaps(mark!, { ...rail.attachments!, height: RAIL_SIZE }), what).toBe(false);
      expect(overlaps(mark!, { ...rail.openPoint!, width: RAIL_SIZE, height: RAIL_SIZE }), what).toBe(false);
    }
    // A card keeps its mark at the corner end of the rail.
    const card = createNode({ type: 'service', x: 0, y: 0, text: 'Orders', technology: 'Redis' });
    expect(markerRail(card, { technology: true, attachments: 1 })).toMatchObject({ technology: { x: card.width - RAIL_SIZE, y: top } });
  });

  it('is what the technology mark, the attachment tab and the open-point tab are each placed by', () => {
    const service = {
      ...createNode({ type: 'service', x: 300, y: 200, technology: 'Redis' }),
      attachments: [createAttachment({ type: 'note', text: 'a' }), createAttachment({ type: 'note', text: 'b' })],
    };
    const rail = markerRail(service, { technology: true, attachments: 2, openPoints: true });
    expect(technologyMarkBounds(service)).toMatchObject(rail.technology!);
    expect(nodeMarkerOrigin(service, { technology: true, attachments: 2 })).toEqual(rail.openPoint);
    const [tab] = describeAttachmentBadge(service, { theme: LIGHT, measurer: getMeasurer() }, true);
    expect(tab).toMatchObject({ t: 'group', translate: { x: rail.attachments!.x, y: rail.attachments!.y } });
  });
});
