/** Regenerate the site’s diagram scenes and attachment previews from the editable examples. */
import { readFile, writeFile } from 'node:fs/promises';
import { effectiveLevel, LEVEL_LABELS } from '../../src/depth/level';
import { hasInside, roomsOf, viewOf, type DepthPath } from '../../src/depth/tree';
import { markerRail, RAIL_SIZE } from '../../src/document/markerRail';
import type { DraftDocument } from '../../src/document/types';
import { parseDocument } from '../../src/document/validate';
import { describeContext } from '../../src/nodes/describe';
import { loadTechnologyIcons, technologyMarkBounds } from '../../src/nodes/technology';
import { buildScene, renderDocumentSvg } from '../../src/render/svg/document';
import { el, serialize, type SvgEl } from '../../src/render/svg/element';
import { beginIdScope, endIdScope } from '../../src/render/svg/ids';
import { markerDefs } from '../../src/render/svg/markers';
import { getMeasurer } from '../../src/render/text/measure';
import { DARK } from '../../src/render/theme/tokens';

const directory = new URL('../examples/', import.meta.url);
async function loadExample(name: string): Promise<DraftDocument> {
  const result = parseDocument(await readFile(new URL(`${name}.draftcanvas`, directory), 'utf8'));
  if (!result.ok) throw new Error(`${name}: ${result.error}`);
  return result.document;
}

const [file, pipeline, payment, video, lakehouse, search] = await Promise.all([
  loadExample('shopify-inventory'), loadExample('slack-messaging'), loadExample('stripe-ledger'),
  loadExample('netflix-live-origin'), loadExample('uber-ingestionnext'), loadExample('discord-message-search'),
]);
await loadTechnologyIcons([file, pipeline, payment, video, lakehouse, search].flatMap((document) =>
  roomsOf(document).flatMap(({ graph }) => graph.nodes),
));

function overviewSvg(document: DraftDocument, description: string, path?: DepthPath): string {
  const { svg, origin } = renderDocumentSvg(document, {
    theme: 'dark', transparent: true, padding: 12, openPointKey: false,
    idScope: path?.join('/') || 'overview', identifyElements: true,
  });
  const graphic = serialize(el('g', { role: 'img', 'aria-label': description }));
  const triggers = document.nodes.flatMap((node) => {
    const tab = markerRail(node, {
      technology: Boolean(technologyMarkBounds(node)),
      attachments: node.attachments?.length,
    }).attachments;
    if (!tab) return [];

    // This hit target shares the native attachment tab's coordinates and leaves the export intact.
    return [serialize(el('g', {
      role: 'button', 'aria-label': `Attachments on ${node.text}`,
      'data-attachment-trigger': node.id,
    }, [el('rect', {
      x: node.x + tab.x - origin.x - 3, y: node.y + tab.y - origin.y - 3,
      width: tab.width + 6, height: RAIL_SIZE + 6, rx: 5, fill: 'transparent',
    })]))];
  }).join('');
  const roomTriggers = path === undefined ? '' : document.nodes.filter(hasInside).map((node) => {
    const x = node.x - origin.x;
    const y = node.y - origin.y;
    return serialize(el('g', {
      role: 'button',
      'aria-label': `Look inside ${node.text}`,
      'data-exhibit-enter': [...path, node.id].join('/'),
      transform: `translate(${x} ${y})`,
    }, [
      el('rect', { class: 'depth-hit', x: 0, y: 0, width: node.width, height: node.height, rx: 9 }),
      el('rect', { class: 'depth-mark', x: node.width - 30, y: 8, width: 20, height: 20, rx: 4 }),
      el('path', { d: `M${node.width - 25} 18h10m-5 -5v10`, stroke: 'currentColor', fill: 'none' }),
    ]));
  }).join('');
  return svg.replace(/<svg ([^>]+)>/, (_, attrs) =>
    `<svg class="system-graph" role="group" ${attrs}>${graphic.replace('/>', '>')}`,
  ).replace('</svg>', () => `</g>${roomTriggers}${triggers}</svg>`);
}

function attachmentCards(document: DraftDocument): string {
  return document.nodes.flatMap((node) => (node.attachments ?? []).map((attachment) => serialize(el('div', {
    class: 'attachment-preview', 'data-attachment-node': node.id,
  }, [
    el('dt', undefined, [
      el('strong', undefined, undefined, attachment.type === 'code'
        ? attachment.text
        : attachment.noteKind === 'decision' ? 'Decision note' : 'Risk note'),
      el('span', undefined, undefined, node.text),
    ]),
    el('dd', undefined, attachment.type === 'code'
      ? [el('pre', undefined, [el('code', undefined, undefined, attachment.code)])]
      : [el('p', undefined, undefined, attachment.text)]),
  ])))).join('');
}

const checkoutExample = {
  system: overviewSvg(file, 'Shopify inventory reservations. When payment starts, checkout locks and removes available units and records a hold in MySQL. When payment succeeds, it clears the hold and deducts stock in one transaction. An empty pool triggers inline replenishment from the inventory ledger.'),
  attachments: attachmentCards(file),
};
const pipelineExample = overviewSvg(pipeline, 'Slack real-time messaging. Webapp forwards a message to an admin server, which uses a consistent hash ring to find the channel server. The channel server fans the message out to subscribed regional gateways. Those gateways deliver it to connected clients over WebSockets. Ring managers update the ring configuration in Consul.');
const paymentSketchOrder = [
  'payments charge-events partners partner-data producers publish-reports ledger-system readiness close finance review-close anomalies ownership engineer triage',
  'ledger-boundary event-producer append event-log project projections check-quality quality surface investigation operator inspect request-repair repair review-impact impact commit-repair',
  'dq-components fund-flow check-clearing clearing check-time timeliness check-completeness completeness clearing-score time-score completeness-score scores alert alerts',
];
const paymentRooms = roomsOf(payment).map(({ path, owners }) => ({
  path, owners, view: viewOf(payment, path)!,
}));
const paymentViews = paymentRooms.map(({ path, owners, view }) => {
  const level = effectiveLevel(payment, path);
  const title = owners.at(-1)?.text ?? payment.metadata.title;
  const caption = level ? LEVEL_LABELS[level] : title;
  const room = path.join('/');
  const attrs = serialize(el('div', {
    class: 'example-art', role: 'region', 'aria-label': `${title} diagram (${caption})`, tabindex: 0,
    'data-exhibit-room': room || '/', 'data-room-label': caption,
    ...(path.length ? { hidden: true } : {}),
  }));
  const description = [
    'Stripe Ledger system context. Stripe payments and reporting systems supply financial events. Accounting Close shows readiness, and engineers triage issues with the owning teams.',
    'Stripe Ledger containers. Producer systems append events to an immutable log. Fund flows feed quality checks and investigation tools. A correction utility prepares an impact report for review before committing a correction.',
    'Data Quality checks. Clearing, timeliness, and completeness feed a score that helps Stripe alert owners and prioritize issues.',
  ][path.length] ?? title;
  return `${attrs.replace('/>', '>')}${overviewSvg(view, description, path)}</div>`;
}).join('');

function paymentDraft() {
  const frames = paymentRooms.map(({ view }) => renderDocumentSvg(view, { padding: 0, openPointKey: false }));
  const contextScale = Math.min(1, 1284 / frames[0]!.width);
  const detailY = Math.ceil(53 + frames[0]!.height * contextScale) + 50;
  const positions = [
    { x: 38, y: 14, scale: contextScale, title: 'System context', width: 1284 },
    { x: 38, y: detailY, scale: 478 / frames[1]!.width, title: 'Inside Stripe Ledger · Containers', width: 478 },
    { x: 557, y: detailY, scale: 765 / frames[2]!.width, title: 'Inside Data Quality · Components', width: 765 },
  ];
  const ctx = describeContext(DARK, 'clean');
  const edgeCtx = { theme: DARK, measurer: getMeasurer(), showSequence: false, preset: 'clean' as const };
  const colors = new Set<string>();
  const order: string[] = [];
  const elements: SvgEl[] = [];
  beginIdScope('marketing-payment-sketch');
  for (const [index, { view }] of paymentRooms.entries()) {
    const { x, y, scale, title, width } = positions[index]!;
    const { origin } = frames[index]!;
    const scene = buildScene(view, ctx, edgeCtx);
    const prefix = `level-${index}-`;
    const transform = `translate(${x} ${y + 39}) scale(${scale}) translate(${-origin.x} ${-origin.y})`;
    const nodeTransform = (node: { x: number; y: number }) => `${transform} translate(${node.x} ${node.y})`;
    const heading = `${prefix}heading`;
    order.push(heading, ...paymentSketchOrder[index]!.split(' ').map((id) => prefix + id));
    elements.push(el('g', { 'data-diagram-node': heading }, [
      el('path', { d: `M${x} ${y + 24}h${width}`, stroke: '#b9acd5', fill: 'none' }),
      el('text', { x, y: y + 17, 'font-size': 20 }, undefined, title),
    ]));
    for (const { node, els } of scene.nodeEntries) {
      elements.push(el('g', { 'data-diagram-node': prefix + node.id, transform: nodeTransform(node) }, els));
    }
    for (const { edge, lineEls, overlayEls } of scene.edgeEntries) {
      elements.push(
        el('g', { 'data-diagram-edge': prefix + edge.id, transform }, lineEls),
        el('g', { 'data-diagram-edge-labels': prefix + edge.id, transform }, overlayEls),
      );
    }
    for (const color of scene.arrowColors) colors.add(color);
  }
  function sketchPoint(level: number, id: string, edge: 'top' | 'bottom', offset = 0.5) {
    const { x, y, scale } = positions[level]!;
    const { origin } = frames[level]!;
    const node = paymentRooms[level]!.view.nodes.find((node) => node.id === id)!;
    return {
      x: x + (node.x + node.width * offset - origin.x) * scale,
      y: y + 39 + (node.y + (edge === 'bottom' ? node.height : 0) - origin.y) * scale,
    };
  }
  const ledger = sketchPoint(0, 'ledger-system', 'bottom');
  const quality = sketchPoint(1, 'quality', 'bottom');
  const [, containers, components] = positions;
  const detailHeight = Math.max(frames[1]!.height * containers!.scale, frames[2]!.height * components!.scale);
  const guides = [
    { id: 'ledger-depth', d: `M${ledger.x} ${ledger.y} V${detailY - 18} H${containers!.x} V${detailY + 24}`, before: 'level-1-heading' },
    { id: 'quality-depth', d: `M${quality.x} ${quality.y} V${detailY + 36} H${components!.x} V${detailY + 24}`, before: 'level-2-heading' },
  ];
  for (const { id, d, before } of guides) {
    order.splice(order.indexOf(before), 0, id);
    elements.push(el('g', { 'data-diagram-edge': id }, [el('path', { d, stroke: '#b9acd5', fill: 'none', 'stroke-opacity': 0.55 })]));
  }
  const svg = serialize(el('svg', {
    class: 'exhibit-sketch-sheet', viewBox: `0 0 1360 ${detailY + 58 + Math.ceil(detailHeight)}`, 'aria-hidden': 'true', 'data-sketch-order': order.join(' '),
  }, [
    el('defs', undefined, markerDefs(colors)),
    el('g', { role: 'img' }, [el('g', undefined, elements)]),
  ]));
  endIdScope();
  return `<template data-exhibit-sketch-sheet>${svg}</template>`;
}

const videoExample = overviewSvg(video, 'Netflix Live Origin. Independent AWS MediaConnect, MediaLive and packager pipelines in two regions push candidate segments to Live Origin. KeyValue splits the segments into chunks stored and replicated across regions in Cassandra and cached in EVCache. The player requests segments from Open Connect. On a miss, the CDN fills from a separate retrieval stack, which selects a valid candidate and reads from EVCache with Cassandra as fallback.');
const lakehouseExample = overviewSvg(lakehouse, 'Uber IngestionNext. Flink consumes Kafka partitions and writes Hudi commits into the raw data lake. The commit metadata records the Flink checkpoint ID for recovery. A control plane operates and monitors jobs, a batch path supports fallback, and compaction merges Parquet row groups.');
const searchExample = overviewSvg(search, 'Discord message search, simplified from its April 2025 engineering write-up. A Pub/Sub router batches messages by destination and bulk indexes them into separate server and direct message cells. Server queries route by guild and cross-DM queries route by user. A representative Elasticsearch cluster has three ingest nodes, three master-eligible nodes, and five data nodes. A primary shard and its replica occupy different zones.');

await writeFile(new URL('../src/checkout-views.json', import.meta.url), `${JSON.stringify({
  checkout: checkoutExample, pipeline: pipelineExample, paymentViews: paymentViews + paymentDraft(), video: videoExample,
  lakehouse: lakehouseExample,
  search: searchExample,
})}\n`);
