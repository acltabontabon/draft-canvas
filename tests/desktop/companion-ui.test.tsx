import { ReactFlowProvider } from '@xyflow/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentSettings, PromptRequest } from '../../src/desktop/api';

// The apply mode is a preference; a real `localStorage` would leak it from one test into the next.
const prefs = new Map<string, string>();
vi.mock('../../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => void prefs.set(key, value),
  removePreference: (key: string) => void prefs.delete(key),
}));

const { Companion } = await import('../../src/desktop/ui/Companion');
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
    companionForget: vi.fn(async (diagramId: string) => companion.clear(diagramId)),
    refreshCompanionProposals: vi.fn(async () => {}),
    refreshAgent: vi.fn(async () => {}),
    openAgentSettings: vi.fn(),
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
    // The next step is a reply in the box, focused for the keyboard, and it opens the setting: turning
    // access on is the person's to do there, never Nodi's.
    const step = screen.getByRole('button', { name: 'Turn on agent access in Settings' });
    expect(step.closest('.dc-companion-options')).not.toBeNull();
    expect(document.activeElement).toBe(step);
    fireEvent.click(step);
    expect(controller.openAgentSettings).toHaveBeenCalled();
    expect(desktopStore.getSnapshot().agent?.enabled).toBe(false);

    // Switched on: the composer and footer are back.
    act(() => desktopStore.update({ agent: ACCESS }));
    expect(screen.getByLabelText('Message Claude Code')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review changes first' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn on agent access in Settings' })).toBeNull();
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
