/**
 * `{op:"arrange"}`: cleaning up an existing view in place — what it moves, what it must never change,
 * and what it leaves alone outside its scope.
 */
import { describe, expect, it } from 'vitest';
import { readingDirectionOf } from '../../src/agent/arrange';
import { compose } from '../../src/agent/compile';
import { applyUpdate } from '../../src/agent/patch';
import { measureContext } from '../../src/agent/place';
import { checkQuality } from '../../src/agent/quality';
import { overlaps } from '../../src/agent/route';
import type { DraftDocument, DraftNode } from '../../src/document/types';
import { deserializeDocument } from '../../src/export/project';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_arrange0000').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const orders = () =>
  build({
    groups: [{ id: 'core', label: 'Orders', kind: 'system' }],
    nodes: [
      { id: 'web', type: 'service', label: 'Web Storefront' },
      { id: 'api', type: 'api', label: 'Orders API', group: 'core' },
      { id: 'db', type: 'sql-database', label: 'Orders DB', group: 'core' },
      { id: 'events', type: 'topic', label: 'order-events' },
      { id: 'billing', type: 'worker', label: 'Billing Worker' },
      { id: 'email', type: 'worker', label: 'Email Worker' },
    ],
    relationships: [
      { id: 'r1', from: 'web', to: 'api', label: 'POST /orders' },
      { id: 'r2', from: 'api', to: 'db', label: 'Writes order' },
      { id: 'r3', from: 'api', to: 'events', label: 'Publishes' },
      { id: 'r4', from: 'events', to: 'billing' },
      { id: 'r5', from: 'events', to: 'email' },
    ],
    notes: [
      { id: 'n1', text: 'Billing retries 5 times, then parks the message.', about: 'billing', attach: false },
      { id: 'why', text: 'Signed with HMAC.', about: 'r1' },
    ],
    flows: [{ id: 'happy', title: 'Normal processing', steps: ['r1', 'r3', 'r4'] }],
  });

/** What a person's hand-arranging (and a messy agent history) leaves: shapes dragged about, a connector routed by hand. */
function messUp(doc: DraftDocument): DraftDocument {
  // The note is dragged along with the worker it explains.
  const moves: Record<string, [number, number]> = { web: [400, 520], billing: [-260, 40], n1: [-260, 150], email: [900, -180], events: [120, 380] };
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (moves[n.id] ? { ...n, x: moves[n.id]![0], y: moves[n.id]![1] } : n)),
    edges: doc.edges.map((e) => (e.id === 'r5' ? { ...e, routeMode: 'direct' as const, sourceAnchor: { side: 'top' as const, offset: 0.25 } } : e)),
  };
}

const errorsOf = (doc: DraftDocument) => checkQuality(doc.nodes, doc.edges, measureContext()).errors;
const byId = (doc: DraftDocument) => new Map(doc.nodes.map((n) => [n.id, n]));
const meaning = (n: DraftNode) => ({ ...n, x: 0, y: 0, width: 0, height: 0 });

describe('arrange', () => {
  it('cleans up a messy view in place: readable again, and nothing is anything other than it was', () => {
    const messy = messUp(orders());
    const { file, counts } = applyUpdate(messy, [], [{ op: 'arrange' }], undefined);
    expect(errorsOf(file)).toEqual([]);
    expect(counts.arranged).toBeGreaterThan(0);
    const before = byId(messy);
    // Same ids, same meaning (labels, C4 fields, attachments), same flows and the file's identity.
    expect(file.nodes.map((n) => n.id).sort()).toEqual(messy.nodes.map((n) => n.id).sort());
    for (const node of file.nodes) expect(meaning(node)).toEqual(meaning(before.get(node.id)!));
    expect(file.flows).toEqual(messy.flows);
    expect(file.metadata).toEqual(messy.metadata);
    expect(file.edges.find((e) => e.id === 'r1')!.attachments).toEqual(messy.edges.find((e) => e.id === 'r1')!.attachments);
    // Cleanup drops the hand routing (that is the point of "tidy").
    expect(file.edges.find((e) => e.id === 'r5')!.routeMode).toBeUndefined();
    // The free note follows the worker it was about.
    const note = byId(file).get('n1')!;
    const billing = byId(file).get('billing')!;
    const gap = Math.max(billing.x - (note.x + note.width), note.x - (billing.x + billing.width), billing.y - (note.y + note.height), note.y - (billing.y + billing.height));
    expect(gap).toBeLessThan(200);
  });

  it('keeps hand routing when asked to, and only straightens anchors', () => {
    const { file } = applyUpdate(messUp(orders()), [], [{ op: 'arrange', connectors: 'keep' }], undefined);
    expect(file.edges.find((e) => e.id === 'r5')!.routeMode).toBe('direct');
  });

  it('arranges one boundary without moving anything outside it, or touching connectors that don\'t reach it', () => {
    const base = orders();
    const custom = { ...base, edges: base.edges.map((e) => (e.id === 'r5' ? { ...e, routeMode: 'direct' as const, routing: 'bezier' as const } : e)) };
    const { file } = applyUpdate(custom, [], [{ op: 'arrange', scope: { group: 'core' } }], undefined);
    const before = byId(custom);
    for (const id of ['web', 'events', 'billing', 'email', 'n1']) {
      const [a, b] = [before.get(id)!, byId(file).get(id)!];
      expect([b.x, b.y], id).toEqual([a.x, a.y]);
    }
    expect(file.edges.find((e) => e.id === 'r5')).toEqual(custom.edges.find((e) => e.id === 'r5'));
    // Judged as the product judges an edit: what the arrange moved, and what that now touches. (The
    // hand-routed curve outside the scope is the person's, readable or not.)
    const scope = new Set(['core', 'api', 'db', 'r1', 'r2', 'r3']);
    expect(checkQuality(file.nodes, file.edges, measureContext(), scope).errors).toEqual([]);
  });

  it('keeps the way a diagram reads unless told otherwise', () => {
    const down = build({
      nodes: [
        { id: 'a', type: 'service', label: 'A' },
        { id: 'b', type: 'service', label: 'B' },
        { id: 'c', type: 'database', label: 'C' },
      ],
      relationships: [
        { id: 'ab', from: 'a', to: 'b' },
        { id: 'bc', from: 'b', to: 'c' },
      ],
      layout: { direction: 'down' },
    });
    expect(readingDirectionOf(down)).toBe('down');
    const { file } = applyUpdate(down, [], [{ op: 'arrange' }], undefined);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => byId(file).get(id)!);
    expect(a!.y < b!.y && b!.y < c!.y).toBe(true);
  });

  it('turns a whole view the other way only when that reads clearly better, and a scoped part never', () => {
    // A hub inside a boundary calling three externals, drawn reading right. Whether a cleanup turns
    // it is the rule a new diagram uses (`clearlyBetterDirection`, held to in the gallery's batch
    // case); here the two directions read alike, so nothing turns — and told the direction, or given
    // only part of the view, a cleanup never turns it.
    const request = {
      groups: [{ id: 'sys', label: 'System', kind: 'system' }],
      nodes: [
        { id: 'in', type: 'api', label: 'Intake', group: 'sys' },
        { id: 'hub', type: 'service', label: 'Hub', group: 'sys' },
        { id: 'a', type: 'service', label: 'A', group: 'sys' },
        { id: 'b', type: 'database', label: 'B', group: 'sys' },
        { id: 'c', type: 'worker', label: 'C', group: 'sys' },
        { id: 'x', type: 'external-system', label: 'X' },
        { id: 'y', type: 'external-system', label: 'Y' },
        { id: 'z', type: 'external-system', label: 'Z' },
      ],
      relationships: [
        { id: 'r1', from: 'in', to: 'hub', label: 'Hands over' },
        { id: 'r2', from: 'hub', to: 'a', label: 'Calls' },
        { id: 'r3', from: 'a', to: 'b', label: 'Writes' },
        { id: 'r4', from: 'hub', to: 'c', label: 'Queues' },
        { id: 'r5', from: 'hub', to: 'x', label: 'Checks with' },
        { id: 'r6', from: 'hub', to: 'y', label: 'Scores with' },
        { id: 'r7', from: 'hub', to: 'z', label: 'Opens at' },
      ],
    };
    const right = build({ ...request, layout: { direction: 'right' } });
    expect(readingDirectionOf(right)).toBe('right');
    const { file } = applyUpdate(right, [], [{ op: 'arrange' }], undefined);
    expect(readingDirectionOf(file)).toBe('right');
    expect(checkQuality(file.nodes, file.edges, measureContext()).errors).toEqual([]);
    expect(readingDirectionOf(applyUpdate(right, [], [{ op: 'arrange', direction: 'right' }], undefined).file)).toBe('right');
    expect(readingDirectionOf(applyUpdate(right, [], [{ op: 'arrange', scope: { group: 'sys' } }], undefined).file)).toBe('right');
  });

  it('adds and cleans up in one request, as one change', () => {
    const { file } = applyUpdate(
      orders(),
      [],
      [
        { op: 'add', nodes: [{ id: 'dlq', type: 'dead-letter-queue', label: 'billing-dlq' }], relationships: [{ id: 'r6', from: 'billing', to: 'dlq', label: 'After 5 failures', kind: 'failure' }] },
        { op: 'arrange' },
      ],
      undefined,
    );
    expect(byId(file).has('dlq')).toBe(true);
    expect(errorsOf(file)).toEqual([]);
  });

  it('refuses a scope it cannot find, naming it', () => {
    expect(() => applyUpdate(orders(), [], [{ op: 'arrange', scope: { group: 'nope' } }], undefined)).toThrow(/no group "nope"/);
  });

  it('keeps a free note at its own offset from its host when that host moves, instead of replacing the offset', () => {
    const doc = build({
      nodes: [
        { id: 'a', type: 'service', label: 'Service A' },
        { id: 'b', type: 'database', label: 'DB B' },
      ],
      relationships: [{ id: 'r1', from: 'a', to: 'b', label: 'reads and writes' }],
      notes: [{ id: 'n1', text: 'Keep this handy.', near: 'a', attach: false }],
    });
    // A person nudges the shape a little, taking the note along at the same offset.
    const nudged = { ...doc, nodes: doc.nodes.map((n) => (n.id === 'a' || n.id === 'n1' ? { ...n, x: n.x + 15, y: n.y - 10 } : n)) };
    const before = byId(nudged);
    const relBefore = { x: before.get('n1')!.x - before.get('a')!.x, y: before.get('n1')!.y - before.get('a')!.y };
    const { file } = applyUpdate(nudged, [], [{ op: 'arrange' }], undefined);
    const after = byId(file);
    const relAfter = { x: after.get('n1')!.x - after.get('a')!.x, y: after.get('n1')!.y - after.get('a')!.y };
    expect(relAfter).toEqual(relBefore);
  });

  it('falls back to a fresh spot for the note when its old offset from the host is no longer free', () => {
    const doc = build({
      nodes: [
        { id: 'a', type: 'service', label: 'Service A' },
        { id: 'b', type: 'database', label: 'DB B' },
        { id: 'blocker', type: 'service', label: 'Blocker' },
      ],
      relationships: [{ id: 'r1', from: 'a', to: 'b', label: 'reads and writes' }],
      notes: [{ id: 'n1', text: 'Keep this handy.', near: 'a', attach: false }],
    });
    const note = doc.nodes.find((n) => n.id === 'n1')!;
    const [dx, dy] = [15, -10];
    // A shape parked exactly where the note's preserved offset would land it.
    const blockerBox = { x: note.x + dx, y: note.y + dy, width: note.width, height: note.height };
    const nudged = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === 'a' || n.id === 'n1' ? { ...n, x: n.x + dx, y: n.y + dy } : n.id === 'blocker' ? { ...n, ...blockerBox } : n,
      ),
    };
    const { file } = applyUpdate(nudged, [], [{ op: 'arrange' }], undefined);
    const after = byId(file);
    expect(overlaps(after.get('n1')!, after.get('blocker')!)).toBe(false);
  });

  it('keeps a note beside its shape inside a boundary, and a boundary\'s own note at its head', () => {
    const doc = build({
      groups: [{ id: 'core', label: 'Orders', kind: 'system' }],
      nodes: [
        { id: 'web', type: 'service', label: 'Web Storefront' },
        { id: 'api', type: 'api', label: 'Orders API', group: 'core' },
        { id: 'db', type: 'sql-database', label: 'Orders DB', group: 'core' },
      ],
      relationships: [
        { id: 'a', from: 'web', to: 'api' },
        { id: 'b', from: 'api', to: 'db' },
      ],
      notes: [
        { id: 'idem', text: 'Idempotent by client key.', about: 'api', attach: false },
        { id: 'own', text: 'Owned by the orders team.', about: 'core' },
      ],
    });
    const { file } = applyUpdate(doc, [], [{ op: 'arrange', spacing: 'spacious' }], undefined);
    const at = (id: string) => file.nodes.find((n) => n.id === id)!;
    expect(at('idem').parentId).toBe('core');
    expect(at('idem').y + at('idem').height).toBeLessThanOrEqual(at('api').y);
    expect(at('api').y - (at('idem').y + at('idem').height)).toBeLessThanOrEqual(40);
    expect(at('own').y).toBeLessThan(at('idem').y);
    expect(checkQuality(file.nodes, file.edges, measureContext()).errors).toEqual([]);
  });
});
