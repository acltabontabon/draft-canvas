import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareProposal } from '../../src/agent/proposal';
import type { Proposal, ProposalAction } from '../../src/desktop/api';
import { companion } from '../../src/desktop/companion';
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
    preconditions: ops.length ? prepareProposal(doc, [], ops, undefined, undefined).preconditions : { nodes: {}, edges: {} },
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
  companion.__reset();
  __resetInteraction();
  const doc = file();
  useEditorStore.setState({ document: doc, history: { past: [], future: [] }, selection: { nodes: [], edges: [] }, revision: 0, mode: 'edit', path: [], outer: null });
});

afterEach(() => {
  setDesktopController(null);
  __resetInteraction();
});

describe('ProposalPanel accept', () => {
  it('preserves a new open point that a pending removal would cascade into during acceptance', async () => {
    const doc = useEditorStore.getState().document;
    const proposal = proposalFor(doc, 'p1', [{ op: 'remove', ids: ['api'] }], 'Remove the API');
    const controller = fakeController([proposal]);
    controller.beginAcceptProposal.mockImplementationOnce(async () => {
      useEditorStore.getState().apply('Raise a question', (file) => ({
        ...file,
        openPoints: [{ id: 'new-question', kind: 'awaiting', context: 'Keep this API?', targets: [{ kind: 'node', id: 'api' }] }],
      }));
      return { ok: true, proposal: { ...proposal, status: 'accepting' } };
    });
    mount(controller, 'p1');
    const accept = await acceptButton();
    await act(async () => fireEvent.click(accept));
    expect(controller.beginAcceptProposal).toHaveBeenCalledTimes(1);
    expect(controller.resolveProposal).not.toHaveBeenCalled();
    expect(useEditorStore.getState().document.nodes[0]?.id).toBe('api');
    expect(useEditorStore.getState().document.openPoints[0]?.id).toBe('new-question');
    expect(await screen.findByRole('alert')).toHaveTextContent(/conflicts with/);
  });

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
    // Older app versions could store an unchanged proposal. It must still be possible to close its
    // review, even though new submissions that change nothing are now refused.
    const legacy = { ...proposalFor(doc, 'p1', [{ op: 'update', id: 'api', set: { label: 'Other API' } }]), ops: [{ op: 'update', id: 'api', set: { label: 'Orders API' } }], preconditions: { nodes: {}, edges: {} } };
    const controller = fakeController([legacy]);
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

describe('ProposalPanel review presentation', () => {
  it('keeps another agent’s pending proposal reachable when the companion switches histories', async () => {
    const doc = useEditorStore.getState().document;
    const proposal = { ...proposalFor(doc, 'codex-proposal', [{ op: 'update', id: 'api', set: { label: 'Checkout API' } }]), run: 'codex' };
    companion.begin(doc.metadata.id, 'codex', 'Rename it', null, 'codex');
    companion.apply('codex', { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null });
    companion.setProposal('codex', proposal.proposalId);
    companion.selectAgent(doc.metadata.id, 'codex');
    mount(fakeController([proposal]), proposal.proposalId);
    await acceptButton();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('button', { name: '1 proposal to review' })).toBeNull();
    act(() => companion.selectAgent(doc.metadata.id, 'claude-code'));
    expect(await screen.findByRole('button', { name: '1 proposal to review' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1 proposal to review' }));
    await acceptButton();
    expect(useUiStore.getState().proposalPanelId).toBe('codex-proposal');
  });

  it('leads with one summary, colour-count labels and named changes grouped before rationale', async () => {
    const doc = useEditorStore.getState().document;
    const withLegacy = { ...doc, nodes: [...doc.nodes, createNode({ id: 'old', type: 'service', x: 300, y: 0, text: 'Legacy worker' })] };
    useEditorStore.setState({ document: withLegacy });
    const proposal = proposalFor(withLegacy, 'p1', [
      { op: 'add', nodes: [{ id: 'worker', type: 'service', label: 'Payment worker' }], relationships: [{ id: 'jobs', from: 'api', to: 'worker', label: 'Dispatches jobs' }] },
      { op: 'update', id: 'api', set: { label: 'Checkout API' } },
      { op: 'remove', ids: ['old'] },
    ], 'Replace the legacy worker and rename the API');
    proposal.counts = { added: 2, updated: 1, removed: 1 };
    proposal.rationale = 'Keep payment processing separate.';
    const { container } = mount(fakeController([proposal]), 'p1');
    await acceptButton();

    expect(screen.getAllByText(proposal.summary)).toHaveLength(1);
    const counts = screen.getByRole('list', { name: 'Proposed changes' });
    expect(within(counts).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['+ 2 added', '~ 1 changed', '− 1 removed']);
    const added = screen.getByRole('region', { name: 'Added' });
    expect(within(added).getByText('Payment worker')).toBeTruthy();
    expect(within(added).getByText('Dispatches jobs')).toBeTruthy();
    expect(within(added).getByText('Connector')).toBeTruthy();
    const changed = screen.getByRole('region', { name: 'Changed' });
    expect(within(changed).getByText('Checkout API', { selector: '.dc-proposal-diff-label' })).toBeTruthy();
    expect(within(changed).getByText('Orders API')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Removed' })).getByText('Legacy worker')).toBeTruthy();
    const rationale = screen.getByText('Rationale').closest('details')!;
    expect(rationale.open).toBe(false);
    expect([...container.querySelectorAll('.dc-proposal-diff-group, .dc-proposal-collapsible')].at(-1)).toBe(rationale);
  });

  it('keeps decided proposals in quiet history and clears the preview when switching or closing', async () => {
    const doc = useEditorStore.getState().document;
    const pending = proposalFor(doc, 'p1', [{ op: 'update', id: 'api', set: { label: 'Checkout API' } }]);
    const beforeOld = { ...doc, nodes: doc.nodes.map((node) => ({ ...node, text: 'Previous API' })) };
    const old = { ...proposalFor(beforeOld, 'old', [{ op: 'update', id: 'api', set: { label: 'Orders API' } }], 'An earlier change with a long summary'), status: 'accepted' as const };
    mount(fakeController([old, pending]), 'p1');
    await acceptButton();
    await waitFor(() => expect(useUiStore.getState().proposalPreview?.proposalId).toBe('p1'));
    const history = screen.getByText('History · 1').closest('details')!;
    expect(history.open).toBe(false);
    expect(within(history).getByRole('img', { name: 'Accepted' })).toHaveTextContent('✓');
    fireEvent.click(screen.getByText('History · 1'));
    fireEvent.click(within(history).getByRole('listitem'));
    expect(await screen.findByText('Accepted: it is in the diagram.')).toBeTruthy();
    expect(screen.getAllByText(old.summary)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Show on canvas' })).toBeNull();
    expect(useUiStore.getState().proposalPreview).toBeNull();

    fireEvent.click(screen.getByRole('listitem', { name: /Rename the API/ }));
    await acceptButton();
    await waitFor(() => expect(useUiStore.getState().proposalPreview?.proposalId).toBe('p1'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useUiStore.getState().proposalPreview).toBeNull();
    expect(screen.queryByRole('region', { name: 'Proposal review' })).toBeNull();
  });
});
