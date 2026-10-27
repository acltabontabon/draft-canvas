import { ReactFlowProvider } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentSettings, PromptRequest } from '../../src/desktop/api';

const prefs = new Map<string, string>();
vi.mock('../../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => void prefs.set(key, value),
  removePreference: (key: string) => void prefs.delete(key),
}));

const { Companion } = await import('../../src/desktop/ui/Companion');
const { Mascot } = await import('../../src/desktop/ui/mascot/Mascot');
const { companion } = await import('../../src/desktop/companion');
const { desktopStore } = await import('../../src/desktop/store');
const { setDesktopController } = await import('../../src/desktop/useDesktop');
const { createDocument, createNode } = await import('../../src/document/factory');
const { useEditorStore } = await import('../../src/store/editorStore');
const { useUiStore } = await import('../../src/store/uiStore');

/**
 * What the companion holds on to and what it leaves lit: a draft and a greeting belong to one
 * diagram, a pin taken away puts out what it lit, an earlier turn's chips never light the latest
 * reply's points, and the mascot rests while nobody can see it.
 */

const CLAUDE: AgentInfo = { agent: 'claude-code', name: 'Claude Code', availability: 'installed', version: '2.1.295', signIn: { loggedIn: true, method: 'claude.ai', transcripts: null } };
const ACCESS: AgentSettings = { enabled: true, listening: true, connections: 0, sidecarPath: null, sidecarWarning: null, background: 'ready', projects: [{ handle: 'ready', name: 'Work', displayPath: '~/work', agent: true }] };

function fakeController() {
  return {
    companionAgents: vi.fn(async () => [CLAUDE]),
    companionContinue: vi.fn(async () => "cd '/work' && 'claude' '--resume' 's-1'"),
    companionSend: vi.fn(async (request: PromptRequest, about: string | null) => companion.begin(request.diagramId, request.runId, request.text, about, request.agent)),
    companionCancel: vi.fn(async () => {}),
    companionSnapshot: vi.fn(async (): Promise<string | null> => null),
    companionForget: vi.fn(async () => {}),
    companionCode: vi.fn(async () => null),
    refreshCompanionProposals: vi.fn(async () => {}),
    refreshAgent: vi.fn(async () => {}),
    openAgentSettings: vi.fn(),
    agentClients: vi.fn(async (): Promise<unknown[]> => []),
    agentSkills: vi.fn(async (): Promise<unknown[]> => []),
    getProposal: vi.fn(async () => null),
    onProposalsChanged: vi.fn(() => () => {}),
  };
}

let controller: ReturnType<typeof fakeController>;
const doc = {
  ...createDocument('Orders'),
  nodes: [createNode({ id: 'db', type: 'service', x: 0, y: 0, text: 'Orders database' }), createNode({ id: 'api', type: 'service', x: 300, y: 0, text: 'Orders API' })],
};
const other = { ...createDocument('Payments'), nodes: [createNode({ id: 'pay', type: 'service', x: 0, y: 0, text: 'Payments' })] };

function mount() {
  setDesktopController(controller as never);
  return render(
    <ReactFlowProvider>
      <Companion />
    </ReactFlowProvider>,
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function answered(runId: string, prompt: string, summary: string) {
  act(() => {
    companion.begin(doc.metadata.id, runId, prompt, null);
    companion.apply(runId, { type: 'stopped', reason: { kind: 'end-turn' }, summary, costMicroUsd: null, usage: null });
  });
}

beforeEach(() => {
  prefs.clear();
  companion.__reset();
  controller = fakeController();
  useEditorStore.setState({ document: doc, path: [], outer: null, selection: { nodes: [], edges: [] } });
  useUiStore.setState({ companionOpen: false, proposalPanelOpen: false, openPointsPanelOpen: false, readOnly: null, pointedIds: null });
  desktopStore.update({ doc: { kind: 'file', name: 'orders.draftcanvas', displayPath: '~/work/orders.draftcanvas', dirty: false, readOnly: false }, agent: ACCESS, explorerMode: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setDesktopController(null as never);
});

describe('the companion across diagrams', () => {
  it('starts afresh on a diagram opened in place: no draft typed about the last one goes to its agent', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    fireEvent.change(screen.getByLabelText('Message Claude Code'), { target: { value: 'Remove the Orders API' } });
    act(() => useEditorStore.setState({ document: other, selection: { nodes: [], edges: [] } }));
    await settle();
    const input = screen.getByLabelText('Message Claude Code') as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(controller.companionSend).not.toHaveBeenCalled();
  });

  it('walks on and says hello on each diagram opened this run, the editor staying mounted', async () => {
    // Diagrams not opened before in this file: each is greeted once per app run.
    useEditorStore.setState({ document: { ...createDocument('Inventory') } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mount();
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByRole('img', { name: 'Nodi, on the way' })).toBeTruthy();
    // Arrived (the walk's own end never plays in jsdom: its fallback timer stands in).
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(screen.queryByRole('img', { name: 'Nodi, on the way' })).toBeNull();
    act(() => useEditorStore.setState({ document: { ...createDocument('Shipping') }, selection: { nodes: [], edges: [] } }));
    expect(screen.getByRole('img', { name: 'Nodi, on the way' })).toBeTruthy();
  });
});

describe('what the reply lights', () => {
  it('an earlier turn’s part lights that part alone, never the latest reply’s point of the same number', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    answered('r1', 'How is the store?', '- [[db]] is fine.');
    answered('r2', 'And the API?', '- [[api]] is slow.');
    const earlier = screen.getAllByRole('button', { name: 'Orders database' })[0]!;
    fireEvent.mouseEnter(earlier);
    expect([...(useUiStore.getState().pointedIds ?? [])]).toEqual(['db']);
    // Neither the latest reply's point 1 nor its pin, both about the API.
    expect(document.querySelector('[data-hot="true"]')).toBeNull();
  });

  it('puts out what a pin lit when the pin goes from under the pointer', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    answered('r1', 'What is slow?', '- [[api]] is slow.');
    const pin = await screen.findByRole('button', { name: 'Point 1, about Orders API' });
    fireEvent.mouseEnter(pin);
    expect([...(useUiStore.getState().pointedIds ?? [])]).toEqual(['api']);
    // The next turn begins: its pins go, with no mouseleave.
    act(() => companion.begin(doc.metadata.id, 'r2', 'Fix it', null));
    expect(screen.queryByRole('button', { name: 'Point 1, about Orders API' })).toBeNull();
    expect(useUiStore.getState().pointedIds).toBeNull();
    // Its answer's own point 1 is not lit by the hover that went before.
    act(() => companion.apply('r2', { type: 'stopped', reason: { kind: 'end-turn' }, summary: '- [[db]] needs an index.', costMicroUsd: null, usage: null }));
    expect(await screen.findByRole('button', { name: 'Point 1, about Orders database' })).toBeTruthy();
    expect(document.querySelector('[data-hot="true"]')).toBeNull();
  });
});

describe('Continue in Terminal', () => {
  it('keeps its word up for the whole moment after a second click', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    answered('r1', 'Explain this diagram', 'It is event driven.');
    const copy = vi.spyOn(useEditorStore.getState(), 'copyText').mockResolvedValue(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const click = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue in Terminal' }));
      await act(async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
    };
    await click();
    act(() => vi.advanceTimersByTime(3000));
    await click();
    act(() => vi.advanceTimersByTime(2000));
    // Five seconds after the first, two after the second: still said.
    expect(screen.getByText('Copied. Paste it into Terminal, boss.')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2500));
    expect(screen.queryByText('Copied. Paste it into Terminal, boss.')).toBeNull();
    copy.mockRestore();
  });
});

describe('the mascot', () => {
  let visibility: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  it('stops drawing while the window is hidden, and starts again when it is back', () => {
    vi.useFakeTimers();
    render(<Mascot mood="idle" />);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('still bobs and blinks, drawing only the frames that differ', () => {
    vi.useFakeTimers();
    const { container } = render(<Mascot mood="idle" />);
    const svg = () => container.querySelector('svg')!.innerHTML;
    const first = svg();
    // Idle lifts every four frames.
    act(() => vi.advanceTimersByTime(150 * 4));
    expect(svg()).not.toBe(first);
    act(() => vi.advanceTimersByTime(150 * 4));
    expect(svg()).toBe(first);
  });
});
