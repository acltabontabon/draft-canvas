import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareProposal } from '../../src/agent/proposal';
import type { Proposal, ProposalAction } from '../../src/desktop/api';
import { ProposalPanel } from '../../src/desktop/ui/ProposalPanel';
import { setDesktopController } from '../../src/desktop/useDesktop';
import { createDocument, createNode } from '../../src/document/factory';
import type { DraftDocument } from '../../src/document/types';
import { __resetInteraction, useEditorStore } from '../../src/store/editorStore';
import { useUiStore } from '../../src/store/uiStore';

/**
 * Accept never leaves a proposal stuck mid-accept for a reason it could have seen coming: a gesture
 * in progress is a retry before anything starts, and a proposal the diagram already matches is
 * recorded as accepted without a commit `applyToFile` would refuse.
 */

function file(): DraftDocument {
  return { ...createDocument('Orders'), nodes: [createNode({ id: 'api', type: 'service', x: 0, y: 0, text: 'Orders API' })] };
}

function proposalFor(doc: DraftDocument, id: string, ops: unknown[], summary = 'Rename the API'): Proposal {
  return {
    proposalId: id,
    version: 1,
    diagramId: doc.metadata.id,
    path: [],
    status: 'pending',
    baseRevision: 'r1',
    ops,
    layout: null,
    preconditions: prepareProposal(doc, [], ops, undefined, undefined).preconditions,
    counts: { added: 0, updated: 1, removed: 0 },
    summary,
    rationale: '',
    assumptions: [],
    openQuestions: [],
    sourceRef: null,
    createdAt: 0,
    updatedAt: 0,
    resolvedAt: null,
    stale: false,
  };
}

function fakeController(proposals: Proposal[]) {
  const status = new Map(proposals.map((p) => [p.proposalId, p.status]));
  const record = (id: string): Proposal => ({ ...proposals.find((p) => p.proposalId === id)!, status: status.get(id)! });
  return {
    listProposals: vi.fn(async () => proposals.map((p) => record(p.proposalId))),
    onProposalsChanged: vi.fn(() => () => {}),
    beginAcceptProposal: vi.fn(async (id: string): Promise<ProposalAction> => {
      status.set(id, 'accepting');
      return { ok: true, proposal: record(id) };
    }),
    resolveProposal: vi.fn(async (id: string, to: 'accepted' | 'rejected' | 'dismissed'): Promise<ProposalAction> => {
      status.set(id, to);
      return { ok: true, proposal: record(id) };
    }),
  };
}

function mount(controller: ReturnType<typeof fakeController>, selected: string) {
  setDesktopController(controller as never);
  useUiStore.setState({ proposalPanelOpen: true, proposalPanelId: selected, proposalPreview: null, readOnly: null });
  return render(
    <ReactFlowProvider>
      <ProposalPanel />
    </ReactFlowProvider>,
  );
}

async function acceptButton() {
  const button = await screen.findByRole('button', { name: 'Accept' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  return button;
}

beforeEach(() => {
  __resetInteraction();
  const doc = file();
  useEditorStore.setState({ document: doc, history: { past: [], future: [] }, selection: { nodes: [], edges: [] }, revision: 0, mode: 'edit', path: [], outer: null });
});

afterEach(() => {
  setDesktopController(null);
  __resetInteraction();
});

describe('ProposalPanel accept', () => {
  it('asks for a retry while a gesture is in progress, before the proposal is moved on', async () => {
    const doc = useEditorStore.getState().document;
    const controller = fakeController([proposalFor(doc, 'p1', [{ op: 'update', id: 'api', set: { label: 'Checkout API' } }])]);
    mount(controller, 'p1');
    const accept = await acceptButton();
    useEditorStore.getState().beginInteraction('Move');
    await act(async () => fireEvent.click(accept));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Finish the drag or edit in progress/);
    expect(controller.beginAcceptProposal).not.toHaveBeenCalled();
    expect(useEditorStore.getState().history.past).toHaveLength(0);
  });

  it('records a proposal the diagram already matches as accepted, without a commit', async () => {
    const doc = useEditorStore.getState().document;
    const controller = fakeController([proposalFor(doc, 'p1', [{ op: 'update', id: 'api', set: { label: 'Orders API' } }], 'Keep the name')]);
    mount(controller, 'p1');
    const accept = await acceptButton();
    await act(async () => fireEvent.click(accept));
    await waitFor(() => expect(controller.resolveProposal).toHaveBeenCalledWith('p1', 'accepted'));
    expect(controller.beginAcceptProposal).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('commits a real change as one undo step', async () => {
    const doc = useEditorStore.getState().document;
    const controller = fakeController([proposalFor(doc, 'p1', [{ op: 'update', id: 'api', set: { label: 'Checkout API' } }])]);
    mount(controller, 'p1');
    const accept = await acceptButton();
    await act(async () => fireEvent.click(accept));
    await waitFor(() => expect(controller.resolveProposal).toHaveBeenCalledWith('p1', 'accepted'));
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    expect(useEditorStore.getState().document.nodes[0]!.text).toBe('Checkout API');
  });

  it('does not carry one proposal’s error over to the next one selected', async () => {
    const doc = useEditorStore.getState().document;
    const controller = fakeController([
      proposalFor(doc, 'p1', [{ op: 'update', id: 'api', set: { label: 'Checkout API' } }], 'First'),
      proposalFor(doc, 'p2', [{ op: 'update', id: 'api', set: { label: 'Billing API' } }], 'Second'),
    ]);
    mount(controller, 'p1');
    const accept = await acceptButton();
    useEditorStore.getState().beginInteraction('Move');
    await act(async () => fireEvent.click(accept));
    expect(await screen.findByRole('alert')).toBeTruthy();
    __resetInteraction();
    await act(async () => fireEvent.click(screen.getByText('Second')));
    await acceptButton();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
