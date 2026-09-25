import { beforeEach, describe, expect, it } from 'vitest';
import { compose } from '../src/agent/compile';
import { deserializeDocument } from '../src/export/project';
import { __resetClipboardSync, __resetInteraction, useEditorStore } from '../src/store/editorStore';
import type { DraftDocument } from '../src/document/types';

/**
 * `applyToFile`'s optional `expectedRevision` (Phase 4a): a commit built from a stale snapshot must
 * refuse atomically, in the same synchronous pass that would otherwise commit — this is what lets
 * `ProposalPanel`'s Accept trust a `result` computed earlier without a second race window of its own.
 */

function build(): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', nodes: [{ id: 'api', type: 'api', label: 'Orders API' }] }, 'd_revguard001').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

function resetStore(doc: DraftDocument) {
  __resetInteraction();
  __resetClipboardSync();
  useEditorStore.setState({ document: doc, history: { past: [], future: [] }, selection: { nodes: [], edges: [] }, revision: 0 });
}

describe('applyToFile(expectedRevision)', () => {
  beforeEach(() => resetStore(build()));

  it('commits when no expectedRevision is passed, exactly as before', () => {
    const applied = useEditorStore.getState().applyToFile('rename', (file) => ({ ...file, nodes: file.nodes.map((n) => ({ ...n, text: 'Renamed' })) }));
    expect(applied).toBe(true);
    expect(useEditorStore.getState().document.nodes[0]?.text).toBe('Renamed');
  });

  it('commits when expectedRevision matches the current one', () => {
    const revision = useEditorStore.getState().revision;
    const applied = useEditorStore.getState().applyToFile('rename', (file) => ({ ...file, nodes: file.nodes.map((n) => ({ ...n, text: 'Renamed' })) }), revision);
    expect(applied).toBe(true);
    expect(useEditorStore.getState().document.nodes[0]?.text).toBe('Renamed');
  });

  it('refuses, without committing, when the document moved on since expectedRevision was captured', () => {
    const staleRevision = useEditorStore.getState().revision;
    // Someone/something else commits first, bumping the revision.
    useEditorStore.getState().applyToFile('someone else', (file) => ({ ...file, nodes: file.nodes.map((n) => ({ ...n, text: 'Someone else' })) }));

    const applied = useEditorStore.getState().applyToFile('stale accept', (file) => ({ ...file, nodes: file.nodes.map((n) => ({ ...n, text: 'Stale' })) }), staleRevision);
    expect(applied).toBe(false);
    // The stale commit never landed — the other change is still what's there.
    expect(useEditorStore.getState().document.nodes[0]?.text).toBe('Someone else');
  });
});
