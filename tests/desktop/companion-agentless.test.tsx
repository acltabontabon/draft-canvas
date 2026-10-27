import { ReactFlowProvider } from '@xyflow/react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentSettings } from '../../src/desktop/api';

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
const { createDocument } = await import('../../src/document/factory');
const { useEditorStore } = await import('../../src/store/editorStore');
const { useUiStore } = await import('../../src/store/uiStore');

/**
 * Which agents there are is asked once per app run (it can start a login shell), so this file has the
 * module to itself: an answer of none is asked again when Nodi opens, so an agent installed while the
 * app runs (or a shell that failed to answer at first) doesn't leave Nodi without one until a restart.
 */

const CLAUDE: AgentInfo = { agent: 'claude-code', name: 'Claude Code', availability: 'installed', version: '2.1.295', signIn: { loggedIn: true, method: 'claude.ai', transcripts: null } };
const ACCESS: AgentSettings = { enabled: true, listening: true, connections: 0, sidecarPath: null, sidecarWarning: null, background: 'ready', projects: [{ handle: 'ready', name: 'Work', displayPath: '~/work', agent: true }] };

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  setDesktopController(null as never);
});

it('asks again for an agent when opened after none was found', async () => {
  companion.__reset();
  const companionAgents = vi.fn<() => Promise<AgentInfo[]>>().mockRejectedValueOnce(new Error('login shell timed out')).mockResolvedValue([CLAUDE]);
  setDesktopController({
    companionAgents: async () => companionAgents().catch(() => []),
    refreshCompanionProposals: vi.fn(async () => {}),
    refreshAgent: vi.fn(async () => {}),
    agentClients: vi.fn(async () => []),
    agentSkills: vi.fn(async () => []),
    getProposal: vi.fn(async () => null),
    onProposalsChanged: vi.fn(() => () => {}),
  } as never);
  useEditorStore.setState({ document: createDocument('Orders'), path: [], outer: null, selection: { nodes: [], edges: [] } });
  useUiStore.setState({ companionOpen: false, proposalPanelOpen: false, openPointsPanelOpen: false, readOnly: null });
  desktopStore.update({ doc: { kind: 'file', name: 'orders.draftcanvas', displayPath: '~/work/orders.draftcanvas', dirty: false, readOnly: false }, agent: ACCESS, explorerMode: null });
  render(
    <ReactFlowProvider>
      <Companion />
    </ReactFlowProvider>,
  );
  await settle();
  expect(companionAgents).toHaveBeenCalledTimes(1);
  act(() => useUiStore.setState({ companionOpen: true }));
  await settle();
  expect(companionAgents).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('Message Claude Code')).toBeTruthy();
  // Found now: not asked again on the next opening.
  act(() => useUiStore.setState({ companionOpen: false }));
  act(() => useUiStore.setState({ companionOpen: true }));
  await settle();
  expect(companionAgents).toHaveBeenCalledTimes(2);
});
