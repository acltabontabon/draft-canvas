import { beforeEach, describe, expect, it } from 'vitest';
import { commandsFor, isReadSafe } from '../src/commands/registry';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import type { DraftDocument } from '../src/document/types';
import { checksOf } from '../src/store/checks';
import { useUiStore } from '../src/store/uiStore';
import { stubContext } from './commandStubs';

const at = { x: 0, y: 0 };
const service = (id: string, text: string) => createNode({ id, type: 'service', text, ...at });
const calls = (id: string, source: string, target: string) => createEdge({ id, source, target, semantic: 'calls', semanticsOrigin: 'explicit' });

function looped(): DraftDocument {
  return { ...createDocument('Shop'), nodes: [service('a', 'A'), service('b', 'B'), service('c', 'C')], edges: [calls('ab', 'a', 'b'), calls('bc', 'b', 'c'), calls('ca', 'c', 'a')] };
}

describe('the editor\'s checks', () => {
  it('reads what the drawing says, most severe first', () => {
    const checks = checksOf(looped());
    expect(checks.findings.map((entry) => entry.rule)).toEqual(['model/dependency-cycle']);
    expect(checks.counts).toEqual({ error: 0, warning: 1, info: 0 });
    expect(checksOf(createDocument('Empty')).findings).toEqual([]);
  });

  it('keeps its answer while shapes are only moved or restyled, as a drag does every frame', () => {
    const file = looped();
    const checks = checksOf(file);
    const dragged = { ...file, nodes: file.nodes.map((node) => ({ ...node, x: node.x + 40, accent: 'blue' as const })) };
    expect(checksOf(dragged)).toBe(checks);
    // And again from the moved copy: the newest arrays are the ones remembered.
    expect(checksOf({ ...dragged, viewport: { x: 5, y: 5, zoom: 2 } })).toBe(checks);
  });

  it('reads again when something a check depends on changes', () => {
    const file = looped();
    const checks = checksOf(file);
    const cut = { ...file, edges: file.edges.slice(0, 2) };
    expect(checksOf(cut)).not.toBe(checks);
    expect(checksOf(cut).findings).toEqual([]);
    const renamed = { ...file, nodes: file.nodes.map((node) => (node.id === 'a' ? { ...node, text: 'Orders' } : node)) };
    expect(checksOf(renamed).findings[0]!.message).toContain('"Orders"');
    const inside = { ...file, nodes: file.nodes.map((node) => (node.id === 'a' ? { ...node, inside: { nodes: [service('x', 'X')], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } } : node)) };
    expect(checksOf(inside)).not.toBe(checksOf(file));
  });
});

describe('the Checks panel', () => {
  beforeEach(() => useUiStore.setState({ checksPanelOpen: false, openPointsPanelOpen: false }));

  it('shares its corner with Open points: opening one closes the other', () => {
    const ui = useUiStore.getState();
    ui.setChecksPanelOpen(true);
    expect(useUiStore.getState()).toMatchObject({ checksPanelOpen: true, openPointsPanelOpen: false });
    ui.setOpenPointsPanelOpen(true);
    expect(useUiStore.getState()).toMatchObject({ checksPanelOpen: false, openPointsPanelOpen: true });
    ui.setChecksPanelOpen(true);
    ui.setChecksPanelOpen(false);
    expect(useUiStore.getState()).toMatchObject({ checksPanelOpen: false, openPointsPanelOpen: false });
  });

  it('opens from the palette, in a shared read-only diagram too, and changes nothing', () => {
    const ids = (ctx: ReturnType<typeof stubContext>) => commandsFor(ctx).map((command) => command.id);
    expect(ids(stubContext())).toContain('checks');
    expect(isReadSafe({ id: 'checks' })).toBe(true);
    expect(ids(stubContext({ ui: { ...useUiStore.getState(), readOnly: { sharedTitle: 'Shared' } } }))).toContain('checks');
    const ctx = stubContext();
    const revision = ctx.editor.revision;
    void commandsFor(ctx).find((command) => command.id === 'checks')!.run(ctx);
    expect(useUiStore.getState().checksPanelOpen).toBe(true);
    expect(ctx.editor.revision).toBe(revision);
  });
});
