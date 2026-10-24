import { ReactFlowProvider } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentSettings, PromptRequest } from '../../src/desktop/api';

// The apply mode is a preference; a real `localStorage` would leak it from one test into the next.
const prefs = new Map<string, string>();
vi.mock('../../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => void prefs.set(key, value),
  removePreference: (key: string) => void prefs.delete(key),
}));

const { Companion, IDLE_MS } = await import('../../src/desktop/ui/Companion');
const { goodbyeLine, returnLine, seedOf } = await import('../../src/desktop/ui/nodiLines');
const { companion } = await import('../../src/desktop/companion');
const { desktopStore } = await import('../../src/desktop/store');
const { setDesktopController } = await import('../../src/desktop/useDesktop');
const { createDocument, createNode } = await import('../../src/document/factory');
const { useEditorStore } = await import('../../src/store/editorStore');
const { useUiStore } = await import('../../src/store/uiStore');

/**
 * The companion on the canvas: resting, opened, refusing to start where it can't, sending what the
 * person typed with what they selected, and showing a turn as the shell reports it.
 */

const CLAUDE: AgentInfo = { agent: 'claude-code', name: 'Claude Code', availability: 'installed', version: '2.1.295', signIn: { loggedIn: true, method: 'claude.ai', transcripts: null } };
const CODEX: AgentInfo = { agent: 'codex', name: 'Codex', availability: 'installed', version: '0.163.0', signIn: { loggedIn: true, method: 'chatgpt', transcripts: null } };
const ACCESS = { enabled: true, listening: true, connections: 0, sidecarPath: null, sidecarWarning: null, background: 'ready', projects: [] } as unknown as AgentSettings;

function fakeController() {
  return {
    companionAgents: vi.fn(async () => [CLAUDE, CODEX]),
    companionContinue: vi.fn(async () => "cd '/work' && 'claude' '--resume' 's-1'"),
    companionSend: vi.fn(async (request: PromptRequest, about: string | null) => companion.begin(request.diagramId, request.runId, request.text, about)),
    companionCancel: vi.fn(async () => {}),
    companionSnapshot: vi.fn(async (): Promise<string | null> => null),
    companionForget: vi.fn(async (diagramId: string) => companion.clear(diagramId)),
    refreshCompanionProposals: vi.fn(async () => {}),
    refreshAgent: vi.fn(async () => {}),
    openAgentSettings: vi.fn(),
    // Settings' one-click setups, all done already unless a test says otherwise.
    agentClients: vi.fn(async (): Promise<unknown[]> => []),
    agentSkills: vi.fn(async (): Promise<unknown[]> => []),
    connectAgentClient: vi.fn(async (_client: string): Promise<unknown> => null),
    installAgentSkill: vi.fn(async (_target: string): Promise<unknown> => null),
    // As the shell answers: where access now stands.
    configureAgent: vi.fn(async (patch: { enabled?: boolean; project?: { handle: string; agent: boolean } }) => {
      const now = desktopStore.getSnapshot().agent!;
      desktopStore.update({
        agent: {
          ...now,
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          projects: now.projects.map((p) => (patch.project && p.handle === patch.project.handle ? { ...p, agent: patch.project.agent } : p)),
        },
      });
      return true;
    }),
    save: vi.fn(async () => {}),
    saveAs: vi.fn(async () => {}),
    // The proposal itself is reviewed in the card (`companion-review.test.tsx`).
    getProposal: vi.fn(async () => null),
    onProposalsChanged: vi.fn(() => () => {}),
  };
}

let controller: ReturnType<typeof fakeController>;
const doc = { ...createDocument('Orders'), nodes: [createNode({ id: 'db', type: 'service', x: 0, y: 0, text: 'Orders database' })] };

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
    // And one timer tick: stepping inside first commits the focused composer, a tick later.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  prefs.clear();
  companion.__reset();
  controller = fakeController();
  useEditorStore.setState({ document: doc, path: [], outer: null, selection: { nodes: [], edges: [] } });
  useUiStore.setState({ companionOpen: false, proposalPanelOpen: false, openPointsPanelOpen: false, readOnly: null });
  desktopStore.update({ doc: { kind: 'file', name: 'orders.draftcanvas', displayPath: '~/orders.draftcanvas', dirty: false, readOnly: false }, agent: ACCESS });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setDesktopController(null as never);
});

describe('the companion', () => {
  it('walks on once it knows an agent is there, and opens to a composer', async () => {
    mount();
    // Nothing until the shell says which agents are installed: no agent, no Nodi.
    expect(screen.queryByRole('button', { name: 'Open Nodi' })).toBeNull();
    await settle();
    expect(screen.getByRole('img', { name: 'Nodi, on the way' })).toBeTruthy();
    // No buttons that say nothing beside it.
    expect(screen.queryByRole('button', { name: 'Open the conversation' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Nodi' }));
    await settle();
    expect(useUiStore.getState().companionOpen).toBe(true);
    expect(screen.getByLabelText('Message Claude Code')).toBeTruthy();
    // Nodi offers the person's replies, each a plain question for the agent behind it.
    fireEvent.click(screen.getByRole('button', { name: 'Walk me through it' }));
    await settle();
    expect(controller.companionSend.mock.calls[0]![0]).toMatchObject({ text: 'Explain this diagram' });
  });

  it('sends the view with the turn, read as it was sent, so the agent needn’t read it first', async () => {
    controller.companionSnapshot.mockResolvedValue('{"revision":"o:1.1","elements":[]}');
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    const input = screen.getByLabelText('Message Claude Code');
    fireEvent.change(input, { target: { value: 'What breaks first?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // A second Enter while it is read is not a second turn.
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(controller.companionSnapshot).toHaveBeenCalledWith(doc.metadata.id, []);
    expect(controller.companionSend).toHaveBeenCalledTimes(1);
    expect(controller.companionSend.mock.calls[0]![0]).toMatchObject({ text: 'What breaks first?', snapshot: '{"revision":"o:1.1","elements":[]}' });
  });

  it('answers small talk itself, without running the agent', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    const input = screen.getByLabelText('Message Claude Code');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(controller.companionSend).not.toHaveBeenCalled();
    // Nodi's own reply, in the conversation, with nothing spent.
    expect(screen.getByRole('region', { name: /Conversation with/ }).textContent).toMatch(/boss/i);
    expect(screen.queryByText(/new tokens/)).toBeNull();
    // Nothing to carry on in a terminal: no agent has run.
    expect(screen.queryByRole('button', { name: 'Continue in Terminal' })).toBeNull();
    // A real question still goes to the agent.
    fireEvent.change(input, { target: { value: 'hello, what breaks first?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(controller.companionSend).toHaveBeenCalledTimes(1);
  });

  describe('taking a break', () => {
    async function start() {
      vi.useFakeTimers();
      await act(async () => { mount(); });
      await advance(2200);
      await advance(5000);
      fireEvent.keyDown(window, { key: 'Shift' });
    }

    async function advance(ms: number) {
      await act(async () => { vi.advanceTimersByTime(ms); });
    }

    const tripSeed = () => seedOf(doc.metadata.id) + 1;
    const say = () => document.querySelector('.dc-companion-say');

    it('keeps saying its hello while the bubble goes, instead of typing the next line over it', async () => {
      vi.useFakeTimers();
      // A diagram not yet greeted this run, so there is a hello to say.
      useEditorStore.setState({ document: { ...doc, metadata: { ...doc.metadata, id: 'd_hello00001' } } });
      await act(async () => { mount(); });
      await advance(2200);
      const hello = say()?.getAttribute('aria-label');
      expect(say()?.getAttribute('data-shown')).toBe('true');
      // Its five seconds are up: the bubble starts to go, with the hello still in it.
      await advance(5000);
      expect(say()?.getAttribute('data-shown')).toBeNull();
      expect(say()?.getAttribute('aria-label')).toBe(hello);
      await advance(1000);
      expect(say()?.getAttribute('aria-label')).toBe(hello);
    });

    it('says goodbye after idle, walks right, and walks back on a key with a return greeting', async () => {
      await start();
      await advance(IDLE_MS - 1);
      expect(say()?.getAttribute('aria-label')).not.toContain(goodbyeLine(tripSeed()));
      await advance(1);
      expect(say()?.getAttribute('aria-label')).toContain(goodbyeLine(tripSeed()));
      expect(say()?.getAttribute('data-shown')).toBe('true');
      await advance(2500);
      const walking = screen.getByRole('img', { name: 'Nodi, on the way' });
      expect(walking.style.transform).toBe('scaleX(-1)');
      expect(walking.closest('.dc-companion')?.getAttribute('data-leaving')).toBe('true');
      await advance(1400);
      expect(screen.queryByRole('button', { name: 'Open Nodi' })).toBeNull();
      expect(say()).toBeNull();

      fireEvent.keyDown(window, { key: 'a' });
      expect(screen.getByRole('img', { name: 'Nodi, on the way' }).style.transform).toBe('');
      expect(document.querySelector('.dc-companion')?.getAttribute('data-arriving')).toBe('true');
      await advance(2200);
      expect(say()?.getAttribute('aria-label')).toContain(returnLine(tripSeed()));
      expect(say()?.getAttribute('data-shown')).toBe('true');
      await advance(5000);
      expect(say()?.getAttribute('data-shown')).toBeNull();
    });

    it('keeps the idle clock in refs for input, document and selection activity', async () => {
      const snapshots = vi.spyOn(companion, 'snapshot');
      await start();
      for (const event of ['pointermove', 'pointerdown', 'click', 'keydown', 'wheel', 'scroll']) {
        await advance(IDLE_MS - 2);
        snapshots.mockClear();
        fireEvent(window, new Event(event));
        // A parent render reads its conversation snapshot; the mascot's own frame ticks don't.
        expect(snapshots).not.toHaveBeenCalled();
        await advance(1);
        expect(say()?.getAttribute('aria-label')).not.toContain(goodbyeLine(tripSeed()));
      }
      await advance(IDLE_MS - 2);
      act(() => useEditorStore.setState({ document: { ...doc, metadata: { ...doc.metadata, title: 'Updated' } } }));
      await advance(IDLE_MS - 1);
      act(() => useEditorStore.setState({ selection: { nodes: ['db'], edges: [] } }));
      await advance(IDLE_MS - 1);
      expect(say()?.getAttribute('aria-label')).not.toContain(goodbyeLine(tripSeed()));
      await advance(1);
      expect(say()?.getAttribute('aria-label')).toContain(goodbyeLine(tripSeed()));
    });

    it('stays while a run is going, and while its answer or proposal needs attention', async () => {
      act(() => companion.begin(doc.metadata.id, 'idle-run', 'Check this', null));
      await start();
      await advance(IDLE_MS + 10_000);
      expect(screen.getByRole('img', { name: 'Nodi, working' })).toBeTruthy();
      expect(document.querySelector('[data-leaving="true"]')).toBeNull();
      act(() => companion.apply('idle-run', { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'Done.', costMicroUsd: null, usage: null }));
      await advance(IDLE_MS + 10_000);
      expect(say()?.getAttribute('data-tone')).toBe('done');
      act(() => companion.setProposal('idle-run', 'idle-proposal'));
      await advance(IDLE_MS + 10_000);
      expect(say()?.getAttribute('data-tone')).toBe('waiting');
      expect(screen.getByRole('button', { name: 'Open Nodi' })).toBeTruthy();
    });

    it('stays for a snag, hover or focus, and cancels a goodbye when activity resumes', async () => {
      desktopStore.update({ agent: { ...ACCESS, enabled: false } });
      await start();
      await advance(IDLE_MS + 10_000);
      expect(say()?.getAttribute('data-tone')).toBe('blocked');
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'Open Nodi' }).closest('.dc-companion')!);
      act(() => desktopStore.update({ agent: ACCESS }));
      await advance(IDLE_MS);
      expect(say()?.getAttribute('aria-label')).not.toContain(goodbyeLine(tripSeed()));
      act(() => screen.getByRole('button', { name: 'Open Nodi' }).focus());
      fireEvent.mouseLeave(document.querySelector('.dc-companion')!);
      await advance(IDLE_MS);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Nodi' }));
      act(() => (document.activeElement as HTMLElement).blur());
      await advance(0);
      expect(say()?.getAttribute('aria-label')).toContain(goodbyeLine(tripSeed()));
      fireEvent.pointerMove(window);
      await advance(4000);
      expect(screen.getByRole('button', { name: 'Open Nodi' })).toBeTruthy();
      expect(document.querySelector('[data-leaving="true"]')).toBeNull();
    });

    it('opens immediately through companionOpen while away', async () => {
      await start();
      await advance(IDLE_MS);
      await advance(2500);
      await advance(1400);
      expect(screen.queryByRole('button', { name: 'Open Nodi' })).toBeNull();
      act(() => useUiStore.getState().setCompanionOpen(true));
      expect(screen.getByLabelText('Message Claude Code')).toBeTruthy();
      expect(document.querySelector('[data-arriving="true"]')).toBeNull();
      act(() => useUiStore.getState().setCompanionOpen(false));
      await advance(IDLE_MS);
      await advance(2500);
      await advance(1400);
      expect(screen.queryByRole('button', { name: 'Open Nodi' })).toBeNull();
      // EditorScreen handles the shortcut after the window's activity capture listener.
      const shortcut = () => useUiStore.getState().setCompanionOpen(true);
      window.addEventListener('keydown', shortcut);
      try {
        fireEvent.keyDown(window, { key: 'j', metaKey: true });
      } finally {
        window.removeEventListener('keydown', shortcut);
      }
      expect(screen.getByLabelText('Message Claude Code')).toBeTruthy();
      act(() => useUiStore.getState().setCompanionOpen(false));
      expect(document.querySelector('[data-arriving="true"]')).toBeNull();
    });

    it('fades without walking under reduced motion, keeping both lines', async () => {
      vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
      await start();
      await advance(IDLE_MS);
      expect(say()?.getAttribute('aria-label')).toContain(goodbyeLine(tripSeed()));
      await advance(2500);
      expect(screen.queryByRole('img', { name: 'Nodi, on the way' })).toBeNull();
      await advance(200);
      expect(screen.queryByRole('button', { name: 'Open Nodi' })).toBeNull();
      fireEvent.keyDown(window, { key: 'a' });
      expect(screen.queryByRole('img', { name: 'Nodi, on the way' })).toBeNull();
      await advance(1000);
      expect(say()?.getAttribute('aria-label')).toContain(returnLine(tripSeed()));
      expect(say()?.getAttribute('data-shown')).toBe('true');
    });
  });

  it('sends what was typed, about the selection, as a proposal by default', async () => {
    useEditorStore.setState({ selection: { nodes: ['db'], edges: [] } });
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    expect(screen.getByText('Orders database')).toBeTruthy();
    const input = screen.getByLabelText('Message Claude Code');
    fireEvent.change(input, { target: { value: 'Put a cache in front of this' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(controller.companionSend).toHaveBeenCalledTimes(1);
    const [request, about] = controller.companionSend.mock.calls[0]!;
    expect(request).toMatchObject({
      diagramId: doc.metadata.id,
      text: 'Put a cache in front of this',
      selection: { nodes: ['db'], edges: [] },
      agent: 'claude-code',
      mode: 'proposal',
    });
    expect(about).toBe('Orders database');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('asks about the whole view when the selection is left out, and remembers direct mode', async () => {
    useEditorStore.setState({ selection: { nodes: ['db'], edges: [] } });
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    // The selection is the chip; its × leaves it out, and the quiet chip left behind brings it back.
    fireEvent.click(screen.getByRole('button', { name: 'Ask about the whole view instead' }));
    fireEvent.click(screen.getByRole('button', { name: /Ask about the selection|Orders database/ }));
    expect(screen.getByRole('button', { name: 'Ask about the whole view instead' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask about the whole view instead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes first' }));
    expect(prefs.get('companion.apply')).toBe('direct');
    fireEvent.change(screen.getByLabelText('Message Claude Code'), { target: { value: 'Explain it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();
    expect(controller.companionSend.mock.calls[0]![0]).toMatchObject({ selection: null, mode: 'direct' });
  });

  it('switches between the agents on this computer, and sends to the one chosen', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    expect(screen.getByLabelText('Message Claude Code')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(prefs.get('companion.agent')).toBe('codex');
    const input = screen.getByLabelText('Message Codex');
    fireEvent.change(input, { target: { value: 'What breaks first?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();
    const sent = controller.companionSend.mock.calls[0]![0];
    expect(sent).toMatchObject({ agent: 'codex' });
    // Not while it works on the turn; once it has, back again: the name switches to the next one there is.
    expect((screen.getByRole('button', { name: 'Codex' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => companion.apply(sent.runId, { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'Done.', costMicroUsd: null, usage: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(prefs.get('companion.agent')).toBe('claude-code');
  });

  it('names parts of another view by name, and never shows an id the diagram doesn’t have', async () => {
    // The reply was about the parts inside Orders database; the person is at the top level.
    const inner = createNode({ id: 'c_api', type: 'component', x: 0, y: 0, text: 'Orders endpoint' });
    const db = { ...doc.nodes[0]!, inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    useEditorStore.setState({ document: { ...doc, nodes: [db] }, path: [], outer: null });
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    act(() => {
      companion.begin(doc.metadata.id, 'r1', 'Add a component view inside the database', null);
      companion.apply('r1', { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'Inside [[db]], [[c_api]] routes requests. [[c_gone]] is gone.', costMicroUsd: null, usage: null });
    });
    const thread = screen.getByRole('region', { name: 'Conversation with Claude Code' });
    expect(thread.textContent).not.toMatch(/c_api|c_gone|\[\[/);
    expect(screen.getByRole('button', { name: 'Orders database' })).toBeTruthy();
    // Inside another view: its name, not something to light or bring into view from here.
    expect(screen.getByText('Orders endpoint').getAttribute('data-elsewhere')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Orders endpoint' })).toBeNull();
    expect(screen.getByText('something not in this diagram')).toBeTruthy();
  });

  it('offers the way inside a shape its answer names, and takes the person there', async () => {
    const inner = createNode({ id: 'c_api', type: 'component', x: 0, y: 0, text: 'Orders endpoint' });
    const db = { ...doc.nodes[0]!, inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    useEditorStore.setState({ document: { ...doc, nodes: [db] }, path: [], outer: null });
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    act(() => {
      companion.begin(doc.metadata.id, 'r1', 'Add a component view inside the database', null);
      companion.apply('r1', { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'I added a component view inside [[db]].', costMicroUsd: null, usage: null });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take me inside Orders database' }));
    await settle();
    expect(useEditorStore.getState().path).toEqual(['db']);
  });

  it('names the shape a view is inside, read from inside it', async () => {
    const inner = createNode({ id: 'c_api', type: 'component', x: 0, y: 0, text: 'Orders endpoint' });
    const room = { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const file = { ...doc, nodes: [{ ...doc.nodes[0]!, inside: room }] };
    useEditorStore.setState({ document: { ...doc, ...room }, path: ['db'], outer: file });
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    act(() => {
      companion.begin(doc.metadata.id, 'r1', 'What is in here?', null);
      companion.apply('r1', { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'I added a view inside [[db]]: [[c_api]] routes requests.', costMicroUsd: null, usage: null });
    });
    expect(screen.getByText('Orders database').getAttribute('data-elsewhere')).toBe('true');
    expect(screen.getByRole('button', { name: 'Orders endpoint' })).toBeTruthy();
  });

  it('copies the command that carries the conversation on in Terminal', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    act(() => {
      companion.begin(doc.metadata.id, 'r1', 'Explain this diagram', null);
      companion.apply('r1', { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'It is event driven.', costMicroUsd: null, usage: null });
    });
    const copy = vi.spyOn(useEditorStore.getState(), 'copyText').mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Continue in Terminal' }));
    await settle();
    expect(controller.companionContinue).toHaveBeenCalledWith(doc.metadata.id, 'claude-code');
    expect(copy).toHaveBeenCalledWith("cd '/work' && 'claude' '--resume' 's-1'");
    expect(screen.getByText('Copied. Paste it into Terminal, boss.')).toBeTruthy();
    copy.mockRestore();
  });

  it('offers no subject control with nothing selected, and asks about a new selection again', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    expect(document.querySelector('.dc-companion-chip')).toBeNull();
    act(() => useEditorStore.setState({ selection: { nodes: ['db'], edges: [] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask about the whole view instead' }));
    expect(document.querySelector('.dc-companion-chip')?.getAttribute('data-off')).toBe('true');
    // Something else chosen: it is what the message is about, without switching anything back on.
    act(() => useEditorStore.setState({ selection: { nodes: [], edges: ['r1'] } }));
    expect(document.querySelector('.dc-companion-chip')?.getAttribute('data-off')).toBeNull();
  });

  it('shows the turn as it runs, stops it, and looks up its proposal for review', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    act(() => {
      companion.begin(doc.metadata.id, 'r1', 'Add a cache', null);
      companion.apply('r1', { type: 'tool-call', id: 't1', tool: 'read_diagram', status: 'in-progress' });
    });
    expect(screen.getByRole('img', { name: 'Nodi, working' })).toBeTruthy();
    // The bubble shows the turn as it goes: each step the agent takes, and no conversation actions yet.
    expect(screen.getByText('Reading the diagram')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue in Terminal' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(controller.companionCancel).toHaveBeenCalledWith('r1');

    // Words that come first don't end the turn: it still says it is working, below them.
    act(() => {
      companion.apply('r1', { type: 'tool-call-update', id: 't1', status: 'completed', error: null });
      companion.apply('r1', { type: 'message-chunk', text: 'I’ll review the modules, then propose what’s missing.\n\n' });
    });
    expect(screen.getByText('Thinking')).toBeTruthy();
    act(() => {
      companion.apply('r1', { type: 'message-chunk', text: 'I proposed a cache.\n\n- **Cache-aside**: reads first\n- Invalidate on write' });
      companion.apply('r1', { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: 1, usage: null });
      companion.setProposal('r1', 'p1');
    });
    expect(screen.getByText('I proposed a cache.')).toBeTruthy();
    // Advice reads as a list, with emphasis, never as raw markup.
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(expect.arrayContaining(['Cache-aside: reads first', 'Invalidate on write']));
    expect(screen.getByText('Cache-aside').tagName).toBe('STRONG');
    // Answered: now there is a conversation to start over or carry on.
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Nodi, waiting for you' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Conversation with Claude Code' }).textContent).toMatch(/shown on the canvas/);
    await settle();
    expect(controller.getProposal).toHaveBeenCalledWith('p1');
  });

  it('adds up what the conversation uses in the bubble, and each turn’s share in the thread', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    act(() => {
      companion.begin(doc.metadata.id, 'r1', 'Explain this diagram', null);
      companion.apply('r1', { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'It is event driven.', costMicroUsd: 126_415, usage: { input: 60_953, cached: 30_392, output: 114 } });
      companion.begin(doc.metadata.id, 'r2', 'What are the risks?', null);
      companion.apply('r2', { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'Two writes.', costMicroUsd: 41_200, usage: { input: 48_169, cached: 46_000, output: 300 } });
    });
    const total = document.querySelector('.dc-companion-spent')!;
    // What the conversation added: everything less what the agent read again from the cache.
    expect(total.textContent).toContain('33k new tokens so far');
    expect(total.getAttribute('title')).toMatch(/33k new tokens over 2 turns\. The agent also re-sent 76k tokens it had already read/);
    // Signed in with a subscription: tokens, never a dollar figure that isn't what they pay.
    expect(total.textContent).not.toContain('$');
    // One line for it, not one per turn as well; the cache's share is explained, not hidden or made free.
    expect(screen.getByRole('region', { name: 'Conversation with Claude Code' }).textContent).not.toMatch(/tokens/);
    expect(total.getAttribute('title')).toMatch(/billed at a discount .*not free/);
  });

  it('shows the conversation whole in the bubble, folding all but the last two turns once it is long', async () => {
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    act(() => {
      companion.begin(doc.metadata.id, 'r1', 'What would you recommend?', null);
      companion.apply('r1', { type: 'message-chunk', text: 'A cache would help.' });
      companion.apply('r1', { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null });
    });
    // No toggle to find it: it is simply there, in the one bubble.
    expect(screen.queryByRole('button', { name: 'Show the conversation' })).toBeNull();
    const thread = screen.getByRole('region', { name: 'Conversation with Claude Code' });
    expect(thread.closest('.dc-companion-speech')).not.toBeNull();
    expect(thread.textContent).toContain('What would you recommend?');
    expect(document.querySelectorAll('.dc-companion-speech')).toHaveLength(1);
    act(() => {
      for (const id of ['r2', 'r3', 'r4']) {
        companion.begin(doc.metadata.id, id, `Question ${id}`, null);
        companion.apply(id, { type: 'stopped', reason: { kind: 'end-turn' }, summary: `Answer ${id}`, costMicroUsd: null, usage: null });
      }
    });
    expect(thread.querySelectorAll('.dc-companion-turn')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '2 earlier turns' }));
    expect(thread.querySelectorAll('.dc-companion-turn')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(controller.companionForget).toHaveBeenCalledWith(doc.metadata.id);
  });

  it('says why it can’t run and offers the fix, instead of a composer that would fail', async () => {
    desktopStore.update({ agent: { ...ACCESS, enabled: false } });
    useEditorStore.setState({ selection: { nodes: ['db'], edges: [] } });
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    expect(screen.getByRole('img', { name: 'Nodi, not set up' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Agent access is off, boss/);
    // No composer, selection chip or footer while there is nothing it could send.
    expect(screen.queryByLabelText('Message Claude Code')).toBeNull();
    expect(document.querySelector('.dc-companion-chip')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review changes first' })).toBeNull();
    // The next step is a reply in the box, focused for the keyboard, that lets Nodi in right there:
    // the person's click is the decision, so they aren't sent off to hunt for the switch.
    const step = screen.getByRole('button', { name: 'Let Nodi in' });
    expect(step.closest('.dc-companion-options')).not.toBeNull();
    expect(document.activeElement).toBe(step);
    // Settings is still one click away, for the finer controls.
    fireEvent.click(screen.getByRole('button', { name: 'Open agent settings' }));
    expect(controller.openAgentSettings).toHaveBeenCalled();
    expect(desktopStore.getSnapshot().agent?.enabled).toBe(false);
    await act(async () => fireEvent.click(step));
    expect(controller.configureAgent).toHaveBeenCalledWith({ enabled: true });
    // The step that had the focus is gone: the composer that replaces it takes it.
    expect(document.activeElement).toBe(screen.getByLabelText('Message Claude Code'));

    // Switched on: the composer and footer are back.
    expect(screen.getByLabelText('Message Claude Code')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review changes first' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Let Nodi in' })).toBeNull();
  });

  it('offers to set the agent up properly, one click each, and says when it is done', async () => {
    controller.agentClients.mockResolvedValue([{ client: 'claude-code', state: 'not-set-up', automatic: true, location: null, configuredCommand: null }]);
    controller.agentSkills.mockResolvedValue([{ target: 'claude-code', state: 'not-installed', location: null, installedVersion: null, bundledVersion: '10', backup: null }]);
    controller.connectAgentClient.mockResolvedValue({ client: 'claude-code', state: 'ready', automatic: true, location: null, configuredCommand: null });
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    const setup = screen.getByRole('list', { name: 'Set up' });
    expect(setup.textContent).toContain('Connect Claude Code everywhere');
    expect(setup.textContent).toContain('Teach Claude Code to draw');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect Claude Code everywhere' })));
    await settle();
    expect(controller.connectAgentClient).toHaveBeenCalledWith('claude-code');
    expect(screen.getByText(/finds Draft Canvas from anywhere now/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Claude Code everywhere' })).toBeNull();
    // The skill is still one click away.
    expect(screen.getByRole('button', { name: 'Teach Claude Code to draw' })).toBeTruthy();
  });

  it('gets cross when poked over and over', async () => {
    mount();
    await settle();
    for (let i = 0; i < 4; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: /^(Open|Hide) Nodi$/ }));
      await settle();
    }
    expect(screen.getByRole('img', { name: 'Nodi, fuming' })).toBeTruthy();
  });

  it('is not there at all once switched off in Settings', async () => {
    const { setNodiShown } = await import('../../src/desktop/nodiShown');
    mount();
    await settle();
    expect(screen.getByRole('button', { name: 'Open Nodi' })).toBeTruthy();
    act(() => setNodiShown(false));
    expect(screen.queryByRole('button', { name: 'Open Nodi' })).toBeNull();
    act(() => setNodiShown(true));
    expect(screen.getByRole('button', { name: 'Open Nodi' })).toBeTruthy();
  });

  it('asks to open the diagram’s folder to agents, and opens only that one', async () => {
    const doc = desktopStore.getSnapshot().doc;
    if (doc.kind !== 'file') throw new Error('expected a file');
    desktopStore.update({ agent: { ...ACCESS, projects: [{ handle: 'p1', name: 'Plans', displayPath: '~/Plans', agent: false }] } });
    desktopStore.update({ doc: { ...doc, displayPath: '~/Plans/orders.dcanvas' } });
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    expect(screen.getByRole('status').textContent).toMatch(/Agents can’t use Plans yet/);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Allow Plans' })));
    expect(controller.configureAgent).toHaveBeenCalledWith({ project: { handle: 'p1', agent: true } });
    expect(screen.getByLabelText('Message Claude Code')).toBeTruthy();
  });

  it('offers a copy of a read-only file through Save As', async () => {
    desktopStore.update({ doc: { kind: 'file', name: 'o', displayPath: 'o', dirty: false, readOnly: true } });
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    expect(screen.getByRole('status').textContent).toMatch(/read-only, boss/);
    expect(screen.queryByLabelText('Message Claude Code')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save a copy' }));
    expect(controller.saveAs).toHaveBeenCalledTimes(1);
  });


  it('never says access is off before the shell has said so, and asks again when opened', async () => {
    desktopStore.update({ agent: null });
    useUiStore.setState({ companionOpen: true });
    mount();
    await settle();
    expect(screen.queryByRole('button', { name: 'Open AI agents settings' })).toBeNull();
    expect(controller.refreshAgent).toHaveBeenCalled();
  });

  it('asks for a saved diagram, and steps aside for the review panel', async () => {
    desktopStore.update({ doc: { kind: 'quick', dirty: true } });
    useUiStore.setState({ companionOpen: true });
    const { unmount } = mount();
    await settle();
    expect(screen.getByRole('status').textContent).toMatch(/quick draft, boss/);
    expect(screen.queryByLabelText('Message Claude Code')).toBeNull();
    // The app's own first Save: the dialog that makes the draft a file.
    fireEvent.click(screen.getByRole('button', { name: 'Save it to a folder' }));
    expect(controller.save).toHaveBeenCalledTimes(1);
    unmount();

    desktopStore.update({ doc: { kind: 'file', name: 'o', displayPath: 'o', dirty: false, readOnly: false } });
    useUiStore.setState({ companionOpen: true, proposalPanelOpen: true });
    mount();
    await settle();
    // It shares their corner, so it makes way entirely rather than sit on their buttons.
    expect(screen.queryByLabelText('Message Claude Code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Nodi' })).toBeNull();
  });
});
