import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes, updateNode } from '../../src/document/operations';
import type { CommitRecord } from '../../src/evolution/contracts';
import { groupSessions, matches, milestoneMessage, toMilestone, toRevision, SESSION_GAP_MS } from '../../src/evolution/timeline';
import { formatMessage } from '../../src/evolution/trailers';
import { changedArea, frameRevision } from '../../src/presentation/revisionFraming';

const sig = (t: number) => ({ name: 'Draft Canvas', email: 'history@draftcanvas.invalid', timestamp: t, timezoneOffset: 0 });
let n = 0;
function commit(at: number, summary: string, parents: string[] = [], extra: Partial<Parameters<typeof formatMessage>[0]['trailers']> = {}): CommitRecord {
  n += 1;
  const oid = n.toString(16).padStart(40, '0');
  return { oid, tree: 'f'.repeat(40), parents, author: sig(at), committer: sig(at), message: formatMessage({ summary, body: ['+ Added Service “Payments”'], trailers: { initiator: 'auto', categories: ['structure'], ...extra } }) };
}

describe('the timeline model', () => {
  it('groups revisions into sessions by the pauses between them, newest first', () => {
    const t0 = 1_700_000_000;
    const a = commit(t0, 'A');
    const b = commit(t0 + 60, 'B', [a.oid]);
    const c = commit(t0 + 60 + SESSION_GAP_MS / 1000 + 5, 'C', [b.oid]);
    const revisions = [c, b, a].map((x) => toRevision(x));
    const sessions = groupSessions(revisions);
    expect(sessions.map((session) => session.revisions.map((r) => r.summary))).toEqual([['C'], ['B', 'A']]);
    expect(sessions[1]!.before).toBeNull();
    expect(sessions[0]!.before).toBe(b.oid);
    expect(sessions[0]!.last).toBe(c.oid);
  });

  it('finds revisions by words, element names, people and categories', () => {
    const revision = toRevision(commit(1_700_000_000, 'Add Payments', [], { contributors: ['Ann'], agents: ['Claude Code'] }));
    expect(matches(revision, { text: 'payments' })).toBe(true);
    expect(matches(revision, { text: 'ann' })).toBe(true);
    expect(matches(revision, { text: 'claude' })).toBe(true);
    expect(matches(revision, { text: 'orders' })).toBe(false);
    expect(matches(revision, { categories: ['layout'] })).toBe(false);
    expect(matches(revision, { categories: ['structure'] })).toBe(true);
    expect(matches(revision, { milestones: true })).toBe(false);
  });

  it('reads milestones from their tag message, safely', () => {
    const message = milestoneMessage('Approved\nby review', 'Signed off\u0007 on Tuesday');
    expect(message).toBe('Approved by review\n\nSigned off on Tuesday\n');
    const milestone = toMilestone({ oid: 'a'.repeat(40), ref: 'refs/tags/milestone/m1', target: 'b'.repeat(40), message, tagger: sig(5) });
    expect(milestone).toEqual({ id: 'm1', name: 'Approved by review', note: 'Signed off on Tuesday', at: 5000, target: 'b'.repeat(40) });
    const revision = toRevision({ ...commit(5, 'X'), oid: 'b'.repeat(40) }, [milestone!]);
    expect(revision.milestones).toHaveLength(1);
  });
});

describe('framing a revision', () => {
  const doc = addNodes(createDocument('F'), [createNode({ type: 'service', x: 0, y: 0, id: 'a' }), createNode({ type: 'service', x: 1000, y: 0, id: 'b' })]);

  it('finds the area that changed, and nothing when nothing did', () => {
    expect(changedArea(doc, doc)).toBeNull();
    const moved = updateNode(doc, 'b', { x: 1200 });
    const area = changedArea(doc, moved)!;
    expect(area.x).toBe(1000);
    expect(area.x + area.width).toBe(1200 + doc.nodes[1]!.width);
  });

  it('keeps the camera when the change is already in view', () => {
    const moved = updateNode(doc, 'a', { x: 10 });
    const frame = frameRevision(doc, moved, { x: 100, y: 100, zoom: 1 }, { width: 1400, height: 900 }, { top: 40, right: 40, bottom: 120, left: 40 });
    expect(frame.kind).toBe('stay');
  });

  it('moves to a change out of view', () => {
    const moved = updateNode(doc, 'b', { x: 5000 });
    const frame = frameRevision(doc, moved, { x: 100, y: 100, zoom: 1 }, { width: 1400, height: 900 }, { top: 40, right: 40, bottom: 120, left: 40 });
    expect(frame.kind).not.toBe('stay');
  });
});
