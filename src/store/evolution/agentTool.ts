/**
 * `diagram_history` (agent tool): what an agent may know about the open diagram's history, served
 * by the page that keeps it. Read-only by construction (ADR-13):
 *
 * - summary, list, compare: summaries of what changed — the semantic diff and recorded wording,
 *   the same a person sees in the timeline;
 * - preview_restore, preview_merge: what would change, never applying it — restoring and merging
 *   stay the person's own actions;
 * - suggest_milestone: asks the person, in the history details, to name a revision;
 * - read: a past revision's whole content, only when the person allowed agents to read history on
 *   this device (Settings → History): history can hold content since removed from the diagram.
 *
 * No raw Git, no ref names, no other diagram's history.
 */
import { historyContent } from '../../document/content';
import type { Oid } from '../../evolution/contracts';
import type { ElementChange, SemanticDiff } from '../../evolution/diff';
import { branchOf } from '../../evolution/refs';
import { readPreference } from '../../lib/preferences';
import { fileOf, useEditorStore } from '../editorStore';
import { HISTORY_PREFS, historyService } from './bridge';
import { historyCompute } from './client';
import { useEvolutionStore } from './evolutionStore';
import { loadTimeline, searchRevisions, snapshotOf } from './historyView';

export class HistoryToolError extends Error {
  readonly code: 'NOT_ACTIVE' | 'NO_HISTORY' | 'NOT_ALLOWED' | 'NOT_FOUND' | 'INVALID';
  constructor(code: HistoryToolError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface HistoryToolArgs {
  diagramId: string;
  action: 'summary' | 'list' | 'compare' | 'read' | 'preview_restore' | 'preview_merge' | 'suggest_milestone';
  revision?: string;
  against?: string;
  alternative?: string;
  name?: string;
  query?: string;
  limit?: number;
}

function changes(diff: SemanticDiff): unknown[] {
  return diff.elements.slice(0, 200).map((change: ElementChange) => ({
    change: change.change,
    kind: change.kind,
    id: change.id,
    label: change.label,
    ...(change.change === 'modified' ? { categories: change.categories, fields: change.fields.slice(0, 20) } : {}),
    ...(change.room ? { inView: diff.rooms[change.room] ?? change.room } : {}),
  }));
}

function known(oid: string): Oid {
  if (!/^[0-9a-f]{40}$/.test(oid)) throw new HistoryToolError('INVALID', 'revision must be a revision id from list.');
  return oid;
}

export async function historyTool(args: HistoryToolArgs): Promise<Record<string, unknown>> {
  const service = historyService();
  const context = service.context();
  // The history attached must be this diagram's too: it is attached after a newly opened diagram
  // loads, and a call in between once read the previous diagram's history.
  if (!context || useEditorStore.getState().document.metadata.id !== args.diagramId || service.documentId !== args.diagramId) {
    throw new HistoryToolError('NOT_ACTIVE', 'That diagram is not open, so its history is not available.');
  }
  const store = context.store;
  if (!store) throw new HistoryToolError('NO_HISTORY', 'This diagram has no recorded history yet.');
  const base = { diagramId: args.diagramId, action: args.action };
  const compute = historyCompute();

  switch (args.action) {
    case 'summary': {
      const tip = context.tip;
      const tags = await store.listTags('refs/tags/milestone');
      return {
        ...base,
        current: tip,
        alternative: context.binding?.altId ? (context.meta?.alternatives.find((alt) => alt.altId === context.binding!.altId)?.name ?? null) : 'Main architecture',
        alternatives: (context.meta?.alternatives ?? []).filter((alt) => !alt.archived).map((alt) => ({ id: alt.altId, name: alt.name })),
        milestones: tags.slice(0, 50).map((tag) => ({ revision: tag.target, name: tag.message.split('\n')[0] })),
        pending: useEvolutionStore.getState().capture.kind === 'pending',
      };
    }
    case 'list': {
      const limit = Math.min(args.limit ?? 30, 100);
      // A search reads past the timeline's loaded pages: it once found only the newest ones.
      let found;
      if (args.query?.trim()) found = await searchRevisions(args.query, limit);
      else {
        await loadTimeline();
        found = useEvolutionStore.getState().timeline.revisions.slice(0, limit);
      }
      const revisions = found
        .map((revision) => ({ revision: revision.oid, at: new Date(revision.at).toISOString(), summary: revision.summary, categories: revision.categories, initiator: revision.initiator, milestones: revision.milestones.map((m) => m.name) }));
      return { ...base, revisions };
    }
    case 'compare': {
      const from = await snapshotOf(known(args.revision ?? ''));
      const to = !args.against || args.against === 'live' ? historyContent(fileOf(useEditorStore.getState())) : await snapshotOf(known(args.against));
      const diff = await compute.diff(from, to);
      const described = await compute.describe(from, to);
      return { ...base, summary: described.summary, changes: changes(diff) };
    }
    case 'read': {
      if (readPreference(HISTORY_PREFS.agentsRead) !== 'on') {
        throw new HistoryToolError('NOT_ALLOWED', 'The person has not allowed agents to read past revisions. History can hold content since removed from the diagram; ask them to allow it in Settings → History if you need it.');
      }
      const doc = await snapshotOf(known(args.revision ?? ''));
      return { ...base, revision: args.revision, title: doc.metadata.title, nodes: doc.nodes.length, document: doc };
    }
    case 'preview_restore': {
      const target = await snapshotOf(known(args.revision ?? ''));
      const live = historyContent(fileOf(useEditorStore.getState()));
      const described = await compute.describe(live, target);
      return { ...base, wouldChange: described.summary, changes: changes(await compute.diff(live, target)), note: 'A preview only. The person restores from the timeline.' };
    }
    case 'preview_merge': {
      const altId = !args.alternative || args.alternative === 'main' ? null : args.alternative;
      if (altId !== null && !context.meta?.alternatives.some((alt) => alt.altId === altId)) throw new HistoryToolError('NOT_FOUND', 'No alternative with that id.');
      const ours = context.tip;
      const theirs = await store.readRef(branchOf(altId));
      if (!ours || !theirs) throw new HistoryToolError('NOT_FOUND', 'Both need at least one revision.');
      const bases = await store.mergeBases(ours, theirs);
      if (bases.length !== 1) return { ...base, note: bases.length === 0 ? 'No shared history: they cannot be merged.' : 'Several shared ancestors: the person merges step by step.' };
      const [b, o, t] = await Promise.all([snapshotOf(bases[0]!), snapshotOf(ours), snapshotOf(theirs)]);
      const result = await compute.merge(b, o, t, []);
      return {
        ...base,
        combined: result.combined,
        conflicts: result.conflicts.map((conflict) => ({ label: conflict.label, kind: conflict.kind, description: conflict.description })),
        note: 'A preview only. The person merges from the timeline, deciding each conflict.',
      };
    }
    case 'suggest_milestone': {
      const revision = known(args.revision ?? context.tip ?? '');
      await store.readCommit(revision).catch(() => {
        throw new HistoryToolError('NOT_FOUND', 'No revision with that id in this diagram’s history.');
      });
      const name = (args.name ?? '').trim().slice(0, 120);
      if (!name) throw new HistoryToolError('INVALID', 'name is required for suggest_milestone.');
      useEvolutionStore.setState({ milestoneSuggestion: { revision, name } });
      return { ...base, suggested: true, note: 'The person sees the suggestion beside the history status and decides.' };
    }
  }
}
