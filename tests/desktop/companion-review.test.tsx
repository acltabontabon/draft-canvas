import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSettings, Proposal, ProposalAction } from '../../src/desktop/api';

const prefs = new Map<string, string>();
vi.mock('../../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => void prefs.set(key, value),
  removePreference: (key: string) => void prefs.delete(key),
}));

const { prepareProposal } = await import('../../src/agent/proposal');
const { Companion } = await import('../../src/desktop/ui/Companion');
const { ProposalPanel } = await import('../../src/desktop/ui/ProposalPanel');
const { companion } = await import('../../src/desktop/companion');
const { desktopStore } = await import('../../src/desktop/store');
const { setDesktopController } = await import('../../src/desktop/useDesktop');
const { createDocument, createNode } = await import('../../src/document/factory');
const { __resetInteraction, useEditorStore } = await import('../../src/store/editorStore');
const { useUiStore } = await import('../../src/store/uiStore');

/**
 * The companion's own proposal, reviewed in its card: Accept is the panel's commit (one undo step,
 * recorded as accepted), Reject changes nothing, an edit that lands first turns it into a conflict,
 * and the card's canvas preview never removes the panel's.
 */

const RUN = 'r1';

function file() {
  return { ...createDocument('Orders'), nodes: [createNode({ id: 'db', type: 'service', x: 0, y: 0, text: 'Orders database' })] };
}

function proposalFor(ops: unknown[]): Proposal {
  const doc = useEditorStore.getState().document;
  return {
    proposalId: 'p1',
    version: 1,
    diagramId: doc.metadata.id,
    path: [],
    status: 'pending',
    baseRevision: 'r1',
    ops,
    layout: null,
    preconditions: prepareProposal(doc, [], ops, undefined, undefined).preconditions,
    counts: { added: 0, updated: 1, removed: 0 },
    summary: 'Rename the database',
    rationale: '',
    assumptions: [],
    openQuestions: [],
    sourceRef: null,
    createdAt: 0,
    updatedAt: 0,
    resolvedAt: null,
    stale: false,
    run: RUN,
  };
}

function fakeController(proposal: Proposal) {
  let status = proposal.status;
  const record = (): Proposal => ({ ...proposal, status });
  return {
    companionAgents: vi.fn(async () => [{ agent: 'claude-code' as const, name: 'Claude Code', availability: 'installed' as const, version: '2.1.295', signIn: { loggedIn: true, method: 'claude.ai', transcripts: null } }]),
    refreshCompanionProposals: vi.fn(async () => {}),
    refreshAgent: vi.fn(async () => {}),
    companionCancel: vi.fn(async () => {}),
    companionForget: vi.fn(async () => {}),
    openAgentSettings: vi.fn(),
    // Settings' one-click setups, all done already unless a test says otherwise.
    agentClients: vi.fn(async (): Promise<unknown[]> => []),
    agentSkills: vi.fn(async (): Promise<unknown[]> => []),
    connectAgentClient: vi.fn(async (_client: string): Promise<unknown> => null),
    installAgentSkill: vi.fn(async (_target: string): Promise<unknown> => null),
    getProposal: vi.fn(async () => record()),
    listProposals: vi.fn(async () => [record()]),
    onProposalsChanged: vi.fn(() => () => {}),
    beginAcceptProposal: vi.fn(async (): Promise<ProposalAction> => {
      status = 'accepting';
      return { ok: true, proposal: record() };
    }),
    resolveProposal: vi.fn(async (_id: string, to: 'accepted' | 'rejected' | 'dismissed'): Promise<ProposalAction> => {
      status = to;
      return { ok: true, proposal: record() };
    }),
  };
}

const ACCESS: AgentSettings = { enabled: true, listening: true, connections: 0, sidecarPath: null, sidecarWarning: null, background: 'ready', projects: [{ handle: 'ready', name: 'Work', displayPath: '~/work', agent: true }] };

/** React Flow's store, for putting the camera somewhere: jsdom never measures the canvas. */
let flow: ReturnType<typeof useStoreApi> | null = null;
function FlowStore() {
  flow = useStoreApi();
  return null;
}

function mount(controller: ReturnType<typeof fakeController>) {
  setDesktopController(controller as never);
  const diagramId = useEditorStore.getState().document.metadata.id;
  companion.begin(diagramId, RUN, 'Rename the database', null);
  companion.apply(RUN, { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'Proposed a new name.', costMicroUsd: null, usage: null });
  companion.setProposal(RUN, 'p1');
  return render(
    <ReactFlowProvider>
      <FlowStore />
      <Companion />
    </ReactFlowProvider>,
  );
}

async function acceptButton() {
  // The dry run that enables Accept is real work; a loaded runner can take past the 1 s default.
  const button = await screen.findByRole('button', { name: 'Accept' }, { timeout: 5000 });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
  return button;
}

beforeEach(() => {
  prefs.clear();
  __resetInteraction();
  companion.__reset();
  useEditorStore.setState({ document: file(), history: { past: [], future: [] }, selection: { nodes: [], edges: [] }, revision: 0, mode: 'edit', path: [], outer: null });
  useUiStore.setState({ companionOpen: true, proposalPanelOpen: false, openPointsPanelOpen: false, readOnly: null, proposalPreview: null });
  desktopStore.update({ doc: { kind: 'file', name: 'o', displayPath: '~/work/o.draftcanvas', dirty: false, readOnly: false }, agent: ACCESS });
});

afterEach(() => {
  setDesktopController(null as never);
  __resetInteraction();
});

describe('reviewing in the companion card', () => {
  it('Accept commits the change as one undo step and the turn says so', async () => {
    const controller = fakeController(proposalFor([{ op: 'update', id: 'db', set: { label: 'Orders DB (primary)' } }]));
    mount(controller);
    expect(await screen.findByRole('region', { name: 'Proposed change' })).toHaveTextContent('Rename the database');
    const accept = await acceptButton();
    // Checked against the diagram, the change is dashed on the canvas: the card's own preview (set by
    // an effect after the check, which a loaded runner can leave a beat behind Accept enabling).
    await waitFor(() => expect(useUiStore.getState().proposalPreview).toMatchObject({ proposalId: 'p1', owner: 'companion' }), { timeout: 5000 });
    await act(async () => fireEvent.click(accept));
    await waitFor(() => expect(controller.resolveProposal).toHaveBeenCalledWith('p1', 'accepted'));
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    expect(useEditorStore.getState().document.nodes[0]!.text).toBe('Orders DB (primary)');
    expect(await screen.findByText(/Added to the diagram/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Proposed change' })).toBeNull();
    // The ghost goes with the review.
    expect(useUiStore.getState().proposalPreview).toBeNull();
  });

  it('Reject leaves the diagram as it was', async () => {
    const controller = fakeController(proposalFor([{ op: 'update', id: 'db', set: { label: 'Orders DB (primary)' } }]));
    mount(controller);
    await acceptButton();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reject' })));
    await waitFor(() => expect(controller.resolveProposal).toHaveBeenCalledWith('p1', 'rejected'));
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useEditorStore.getState().document.nodes[0]!.text).toBe('Orders database');
    expect(await screen.findByText(/Rejected. The diagram is unchanged/)).toBeTruthy();
  });

  it('an edit that lands first — the person’s or a collaborator’s — turns it into a conflict', async () => {
    const controller = fakeController(proposalFor([{ op: 'update', id: 'db', set: { label: 'Orders DB (primary)' } }]));
    mount(controller);
    await acceptButton();
    act(() => {
      useEditorStore.getState().applyToFile('Rename', (doc) => ({ ...doc, nodes: doc.nodes.map((n) => ({ ...n, text: 'Order store' })) }));
    });
    await waitFor(() => expect(screen.getByText(/has moved on since/)).toBeTruthy(), { timeout: 3000 });
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true);
    expect(controller.beginAcceptProposal).not.toHaveBeenCalled();
  });

  it('never clears the review panel’s preview of the same proposal', async () => {
    const controller = fakeController(proposalFor([{ op: 'update', id: 'db', set: { label: 'Orders DB (primary)' } }]));
    const { unmount } = mount(controller);
    await acceptButton();
    // Under a loaded run the companion's own preview could land after the takeover below, so the
    // panel took over nothing and the companion's unmount then cleared its own late preview.
    await waitFor(() => expect(useUiStore.getState().proposalPreview).toMatchObject({ proposalId: 'p1', owner: 'companion' }));
    // The panel takes the same proposal over, as it does when Details opens it.
    act(() => useUiStore.setState({ proposalPreview: { ...useUiStore.getState().proposalPreview!, owner: 'panel' } }));
    unmount();
    expect(useUiStore.getState().proposalPreview).toMatchObject({ proposalId: 'p1', owner: 'panel' });
  });

  it('Details opens the review panel at this proposal, and the companion makes way', async () => {
    const controller = fakeController(proposalFor([{ op: 'update', id: 'db', set: { label: 'Orders DB (primary)' } }]));
    mount(controller);
    await acceptButton();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Details' })));
    expect(useUiStore.getState()).toMatchObject({ proposalPanelOpen: true, proposalPanelId: 'p1' });
    expect(screen.queryByRole('region', { name: 'Proposed change' })).toBeNull();
  });

  it('offers Show me only while the change is out of view', async () => {
    const controller = fakeController(proposalFor([{ op: 'update', id: 'db', set: { label: 'Orders DB (primary)' } }]));
    mount(controller);
    await acceptButton();
    // On screen, beside the chip: there is nowhere to take the person, so nothing is offered.
    act(() => flow!.setState({ width: 1200, height: 800, transform: [100, 100, 1] }));
    expect(screen.queryByRole('button', { name: 'Show me' })).toBeNull();
    // Panned away: the chip stays on the canvas and offers the way back.
    act(() => flow!.setState({ transform: [-3000, 100, 1] }));
    expect(screen.getByRole('button', { name: 'Show me' })).toBeTruthy();
  });

  it('the badge leaves the card’s proposal to the card, and takes it back once the conversation is gone', async () => {
    const controller = fakeController(proposalFor([{ op: 'update', id: 'db', set: { label: 'Orders DB (primary)' } }]));
    mount(controller);
    render(
      <ReactFlowProvider>
        <ProposalPanel />
      </ReactFlowProvider>,
    );
    await acceptButton();
    expect(screen.queryByRole('button', { name: '1 proposal to review' })).toBeNull();
    // A new conversation: the card no longer shows it.
    act(() => companion.clear(useEditorStore.getState().document.metadata.id));
    expect(await screen.findByRole('button', { name: '1 proposal to review' })).toBeTruthy();
  });
});
