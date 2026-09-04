import { getViewportForBounds } from '@xyflow/react';
import { SEMANTIC_DEFAULTS } from '../document/edgeSemantics';
import { displayNameFor } from '../document/factory';
import { boundsOf } from '../document/operations';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import type { Command, CommandContext } from './types';

/**
 * Phase 8.3 — the same palette is the fastest way to find something on a big canvas. Every
 * named node, every flow, and every labelled connector becomes a "Jump to" row; the palette
 * fuzzy-ranks them with the same matcher as commands and shows the best few *after* command
 * matches, only once a query is typed (an empty palette is for commands, not an index).
 *
 * Picking one pans there (React Flow's own `fitView` over just that element, capped so a single
 * node never fills the screen), selects it, and flashes it once so the eye lands on the right
 * thing — see `jumpFlashId` in `uiStore.ts`.
 */

/** How many jump rows may follow the command matches. Enough to disambiguate, never a directory. */
export const JUMP_LIMIT = 8;
const JUMP_MAX_ZOOM = 1.2;
const JUMP_PADDING = 0.4;
export const JUMP_FLASH_MS = 900;
/**
 * Ranked together with commands, a jump row gives up this much score — so "Data Store" the node
 * still beats "About Draft Canvas" on the query "data", while on an equal-quality match the
 * command wins: a palette is for doing things first, finding things second.
 */
export const JUMP_RANK_PENALTY = 1;

const TYPE_CAPTIONS: Record<DraftNode['type'], string> = {
  text: 'Text',
  note: 'Note',
  code: 'Code',
  service: 'Service',
  database: 'Data store',
  queue: 'Queue',
  actor: 'Actor',
  group: 'Boundary',
  ellipse: 'Junction',
};

function edgeLabel(edge: DraftEdge): string | undefined {
  const explicit = edge.label?.trim();
  if (explicit) return explicit;
  return edge.semantic ? SEMANTIC_DEFAULTS[edge.semantic].label : undefined;
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;

/** Flashes one element, cancelling any flash still running from a previous jump. */
export function flash(ctx: CommandContext, id: string) {
  if (flashTimer) clearTimeout(flashTimer);
  ctx.ui.setJumpFlashId(id);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    ctx.ui.setJumpFlashId(null);
  }, JUMP_FLASH_MS);
}

/**
 * Pans and zooms so `nodeIds` fill the view — capped so a single node never becomes a wall.
 * Computed from the document's own geometry with the same `getViewportForBounds` Presentation
 * Mode uses (`useFlowPlayback.ts`'s `resolveStepViewport`), rather than React Flow's `fitView`
 * — this is pure, so it's unit-testable, and it's the camera math the GIF exporter already
 * trusts.
 */
export function focusNodes(ctx: CommandContext, nodeIds: string[]) {
  const wanted = new Set(nodeIds);
  const bounds = boundsOf(ctx.editor.document.nodes.filter((node) => wanted.has(node.id)));
  if (!bounds) return;
  const { viewWidth, viewHeight } = ctx.camera;
  if (viewWidth <= 0 || viewHeight <= 0) return;
  const viewport = getViewportForBounds(bounds, viewWidth, viewHeight, 0.1, JUMP_MAX_ZOOM, JUMP_PADDING);
  void ctx.camera.setViewport(viewport, { duration: 320 });
}

/** Every jumpable thing on the canvas as a command, unranked — the palette ranks and caps. */
export function jumpCommands(document: DraftDocument): Command[] {
  const commands: Command[] = [];
  const names = new Map(document.nodes.map((node) => [node.id, displayNameFor(node)]));

  for (const node of document.nodes) {
    const name = names.get(node.id)!;
    if (!name.trim()) continue;
    commands.push({
      id: `jump-node:${node.id}`,
      title: name,
      group: 'jump',
      hint: TYPE_CAPTIONS[node.type] ?? node.type,
      run: (ctx) => {
        ctx.editor.setSelection({ nodes: [node.id], edges: [] });
        focusNodes(ctx, [node.id]);
        flash(ctx, node.id);
      },
    });
  }

  for (const flow of document.flows) {
    if (!flow.title.trim()) continue;
    commands.push({
      id: `jump-flow:${flow.id}`,
      title: flow.title,
      group: 'jump',
      keywords: ['flow'],
      hint: `Flow · ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}`,
      run: (ctx) => {
        ctx.editor.setSelectedFlowId(flow.id);
        const edgesById = new Map(ctx.editor.document.edges.map((edge) => [edge.id, edge]));
        const members = new Set<string>();
        for (const step of flow.steps) {
          const edge = step.edgeId ? edgesById.get(step.edgeId) : undefined;
          if (edge) {
            members.add(edge.source);
            members.add(edge.target);
          }
          for (const extra of step.extraNodeIds ?? []) members.add(extra);
        }
        focusNodes(ctx, [...members]);
      },
    });
  }

  for (const edge of document.edges) {
    const label = edgeLabel(edge);
    if (!label) continue;
    const from = names.get(edge.source) ?? '?';
    const to = names.get(edge.target) ?? '?';
    commands.push({
      id: `jump-edge:${edge.id}`,
      title: label,
      group: 'jump',
      keywords: [from, to],
      hint: `${from} → ${to}`,
      run: (ctx) => {
        ctx.editor.setSelection({ nodes: [], edges: [edge.id] });
        focusNodes(ctx, [edge.source, edge.target]);
        flash(ctx, edge.id);
      },
    });
  }

  return commands;
}
