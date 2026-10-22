import type { Attachment, DraftDocument, OpenPoint } from '../document/types';
import { OPEN_POINT_LABELS } from '../document/openPoints';
import { indexFile, resolveTarget, type ElementTarget } from '../openPoints/locate';

export type ReaderContextSection = 'notes' | 'decisions' | 'pending' | 'resolved';
export interface ReaderContextItem {
  id: string;
  text: string;
  targets: ElementTarget[];
  note?: Pick<Attachment, 'type' | 'noteKind' | 'accent'>;
  code?: Pick<Attachment, 'code' | 'language'>;
  point?: OpenPoint;
}
export type ReaderContext = Record<ReaderContextSection, ReaderContextItem[]>;

/** Read the existing annotations at every depth without inventing decisions or pending work. */
export function readerContext(file: DraftDocument): ReaderContext {
  const result: ReaderContext = { notes: [], decisions: [], pending: [], resolved: [] };
  const index = indexFile(file);
  const appendNote = (id: string, note: Pick<Attachment, 'type' | 'text' | 'noteKind' | 'accent'>, target: ElementTarget) => {
    if (note.type === 'code' || !note.text?.trim()) return;
    result[note.noteKind === 'decision' ? 'decisions' : 'notes'].push({ id, text: note.text, note, targets: [target] });
  };
  for (const { node } of index.nodes.values()) {
    const target = resolveTarget(index, 'node', node.id)!;
    if (node.type === 'note') appendNote(`node:${node.id}`, { type: 'note', text: node.text, noteKind: node.noteKind, accent: node.accent }, target);
    for (const note of node.attachments ?? []) appendNote(`attachment:${note.id}`, note, target);
  }
  for (const { edge } of index.edges.values()) {
    const target = resolveTarget(index, 'edge', edge.id)!;
    for (const note of edge.attachments ?? []) appendNote(`attachment:${note.id}`, note, target);
  }
  for (const point of file.openPoints ?? []) {
    const targets = point.targets.map((target) => resolveTarget(index, target.kind, target.id)).filter((target): target is ElementTarget => Boolean(target));
    result[point.resolved ? 'resolved' : 'pending'].push({
      id: `point:${point.id}`, text: point.context || OPEN_POINT_LABELS[point.kind], targets, point,
    });
  }
  return result;
}

/** The reader browses one detail at a time, including code that the former note list omitted. */
export function readerAttachments(file: DraftDocument): ReaderContextItem[] {
  const context = readerContext(file);
  const items = [...context.notes, ...context.decisions, ...context.pending, ...context.resolved];
  const index = indexFile(file);
  const appendCode = (id: string, code: Pick<Attachment, 'code' | 'language'>, target: ElementTarget) => {
    if (code.code?.trim()) items.push({ id, text: '', code: { code: code.code, language: code.language }, targets: [target] });
  };
  for (const { node } of index.nodes.values()) {
    const target = resolveTarget(index, 'node', node.id)!;
    if (node.code) appendCode(`code:${node.id}`, node, target);
    for (const attachment of node.attachments ?? []) {
      if (attachment.type === 'code') appendCode(`attachment:${attachment.id}`, attachment, target);
    }
  }
  for (const { edge } of index.edges.values()) {
    const target = resolveTarget(index, 'edge', edge.id)!;
    for (const attachment of edge.attachments ?? []) {
      if (attachment.type === 'code') appendCode(`attachment:${attachment.id}`, attachment, target);
    }
    if (edge.details) appendCode(`details:${edge.id}`, edge.details, target);
  }
  return items;
}
