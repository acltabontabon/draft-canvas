/**
 * Depth navigation must replace a substantial room in both directions. The ordinary interaction
 * fixture's six-shape rooms cannot expose the mount, snapshot and raster cost of a real dive.
 * Reuse its mix of boundaries, connectors and attachments, with disjoint ids in the inside room.
 */
import type { DraftNode } from '../../src/document/types';
import { buildScaleDocument, type ScaleSpec } from './scale';

export function buildDepthDocument(spec: ScaleSpec): ReturnType<typeof buildScaleDocument> {
  const built = buildScaleDocument(spec);
  const inner = buildScaleDocument(spec).document;
  const prefix = (id: string) => `inside-${id}`;
  const attachmentIds = (attachments: DraftNode['attachments']) => attachments?.map((attachment) => ({
    ...attachment,
    id: prefix(attachment.id),
  }));
  // Keep exactly one room: nested small rooms would obscure what the measured navigation swaps.
  for (const node of built.document.nodes) delete node.inside;
  const owner = built.document.nodes.find((node) => node.type === 'service');
  if (!owner) throw new Error('The depth fixture needs a service doorway.');
  owner.text = 'Depth benchmark doorway';
  owner.inside = {
    nodes: inner.nodes.map(({ inside: _inside, ...node }) => ({
      ...node,
      id: prefix(node.id),
      ...(node.parentId ? { parentId: prefix(node.parentId) } : {}),
      ...(node.attachments ? { attachments: attachmentIds(node.attachments) } : {}),
    })),
    edges: inner.edges.map((edge) => ({
      ...edge,
      id: prefix(edge.id),
      source: prefix(edge.source),
      target: prefix(edge.target),
      ...(edge.attachments ? { attachments: attachmentIds(edge.attachments) } : {}),
    })),
    flows: [],
    viewport: inner.viewport,
    level: 'component',
  };
  built.manifest.rooms = 1;
  built.manifest.roomNodes = inner.nodes.length;
  built.manifest.roomEdges = inner.edges.length;
  built.manifest.depthOwnerId = owner.id;
  return built;
}
