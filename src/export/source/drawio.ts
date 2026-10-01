/**
 * DraftDocument → an uncompressed `.drawio` file (mxGraph XML) that diagrams.net opens as an
 * editable diagram: every shape at the position and size it has on the canvas, boundaries as
 * container cells their members are parented to, connectors as edge cells with their label, and
 * one page per room. Positions are the document's own; nothing is laid out here. Every value goes
 * through the SVG exporter's XML escaping, and labels are HTML-escaped a second time because
 * diagrams.net reads an `html=1` label as markup — a shape named `<b>` must still say `<b>`.
 */

import type { DraftDocument, DraftEdge, DraftNode } from '../../document/types';
import { escapeXmlAttr } from '../../render/svg/element';
import { collectRooms, edgeCaption, isBoundary, oneLine, roomTitleFor, titleOf, type ExportRoom } from './shared';

/** A label diagrams.net shows verbatim: HTML-escaped so markup stays text, breaks kept as `<br>`. */
function label(text: string | undefined): string {
  const html = (text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/\r\n?|\n/g, '<br>');
  return escapeXmlAttr(html);
}

const attr = (value: string | number): string => escapeXmlAttr(String(value));

/** diagrams.net's own stock shapes, nearest to each silhouette the canvas draws. */
function styleOf(node: DraftNode): string {
  switch (node.type) {
    case 'group':
      return 'swimlane;container=1;whiteSpace=wrap;html=1;startSize=30;collapsible=0;rounded=1;dashed=1;';
    case 'database':
      return 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;';
    case 'queue':
      return 'shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;';
    case 'actor':
      return node.actorKind === 'system' || node.actorKind === 'thirdParty'
        ? 'rounded=0;whiteSpace=wrap;html=1;dashed=1;'
        : 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;';
    case 'component':
      return 'shape=module;align=left;spacingLeft=20;align=center;verticalAlign=top;whiteSpace=wrap;html=1;';
    case 'ellipse':
      return 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;';
    case 'note':
      return 'shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;darkOpacity=0.05;size=14;align=left;verticalAlign=top;spacing=8;';
    case 'code':
      return 'shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;size=14;align=left;verticalAlign=top;spacing=8;fontFamily=Courier New;';
    case 'text':
      return 'text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;';
    default:
      return 'rounded=1;whiteSpace=wrap;html=1;';
  }
}

function edgeStyle(edge: DraftEdge): string {
  const parts = ['edgeStyle=orthogonalEdgeStyle', 'rounded=1', 'orthogonalLoop=1', 'jettySize=auto', 'html=1'];
  parts.push(edge.directed ? 'endArrow=block' : 'endArrow=none');
  if (edge.async) parts.push('dashed=1');
  return `${parts.join(';')};`;
}

function textOf(node: DraftNode): string {
  if (node.type === 'code') return node.code ?? '';
  return node.text ?? '';
}

/**
 * Cells in an order where a container precedes its members, because diagrams.net resolves `parent`
 * as it reads. Boundaries come first (they sit behind everything on the canvas too), then the rest
 * in document order; a `parentId` that names nothing, or something that is not a boundary, reads
 * as the page.
 */
function orderedNodes(nodes: readonly DraftNode[]): { node: DraftNode; parent: DraftNode | undefined }[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentOf = (node: DraftNode) => {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    return parent && isBoundary(parent) && parent.id !== node.id ? parent : undefined;
  };
  const depthOf = (node: DraftNode): number => {
    let depth = 0;
    let current = parentOf(node);
    const seen = new Set<string>([node.id]);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      depth += 1;
      current = parentOf(current);
    }
    return depth;
  };
  return nodes
    .map((node, index) => ({ node, parent: parentOf(node), depth: depthOf(node), index }))
    .sort((a, b) => a.depth - b.depth || Number(isBoundary(b.node)) - Number(isBoundary(a.node)) || a.index - b.index)
    .map(({ node, parent }) => ({ node, parent }));
}

function pageCells(room: ExportRoom): string[] {
  const graph = room.document;
  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const ordered = orderedNodes(graph.nodes);
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const { node, parent } of ordered) {
    // A member's geometry is relative to its container, the way diagrams.net stores it.
    const x = node.x - (parent?.x ?? 0);
    const y = node.y - (parent?.y ?? 0);
    cells.push(
      `<mxCell id="${attr(node.id)}" value="${label(textOf(node))}" style="${attr(styleOf(node))}" vertex="1" parent="${attr(parent?.id ?? '1')}">` +
        `<mxGeometry x="${attr(round(x))}" y="${attr(round(y))}" width="${attr(round(node.width))}" height="${attr(round(node.height))}" as="geometry"/>` +
        '</mxCell>',
    );
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    cells.push(
      `<mxCell id="${attr(edge.id)}" value="${label(edgeCaption(graph, edge))}" style="${attr(edgeStyle(edge))}" edge="1" parent="1" source="${attr(edge.source)}" target="${attr(edge.target)}">` +
        '<mxGeometry relative="1" as="geometry"/>' +
        '</mxCell>',
    );
    // A condition or a response is a second caption on the same connector — its own label cell,
    // the way diagrams.net stores an extra edge label, placed a little along the line.
    const extras = [edge.condition ? `[${oneLine(edge.condition)}]` : '', edge.hasResponse ? oneLine(edge.response) : ''].filter(Boolean);
    extras.forEach((text, index) => {
      cells.push(
        `<mxCell id="${attr(`${edge.id}-label-${index + 1}`)}" value="${label(text)}" style="edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];" vertex="1" connectable="0" parent="${attr(edge.id)}">` +
          `<mxGeometry x="${index === 0 ? -0.5 : 0.5}" relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry>` +
          '</mxCell>',
      );
    });
  }
  return cells;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function drawioSource(document: DraftDocument): string {
  const rooms = collectRooms(document);
  const pages = rooms.map((room, index) => {
    const name = index === 0 ? titleOf(document) : roomTitleFor(room);
    const id = index === 0 ? 'canvas' : `room-${room.path.join('-')}`;
    return [
      `  <diagram id="${attr(id)}" name="${attr(name)}">`,
      '    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">',
      '      <root>',
      ...pageCells(room).map((cell) => `        ${cell}`),
      '      </root>',
      '    </mxGraphModel>',
      '  </diagram>',
    ].join('\n');
  });
  return `<mxfile host="Draft Canvas" type="device" compressed="false">\n${pages.join('\n')}\n</mxfile>\n`;
}
