import { describe, expect, it } from 'vitest';
import type { AgentClientSetup, AgentProject, AgentSettings } from '../../src/desktop/api';
import { claudeCodeCommand, clientLine, codexConfigToml, connectionSummary, folderRows } from '../../src/desktop/ui/settings/agentModel';

const AGENT: AgentSettings = {
  enabled: true,
  listening: true,
  connections: 0,
  sidecarPath: '/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp',
  sidecarWarning: null,
  background: 'ready',
  projects: [],
};

const facts = (agent: Partial<AgentSettings>) => connectionSummary({ ...AGENT, ...agent }, 'macos').facts.map((fact) => `${fact.term}: ${fact.value}`);

describe('connectionSummary', () => {
  it('keeps access, the connector and connected agents as three separate facts', () => {
    expect(facts({})).toEqual(['Access: On', 'Connector: Ready', 'Agents: None connected']);
    expect(facts({ connections: 1 })).toContain('Agents: 1 connected');
    expect(facts({ connections: 3 })).toContain('Agents: 3 connected');
    expect(facts({ listening: false })).toContain('Connector: Not ready yet');
  });

  it('says nothing is running, and nothing about hidden windows, while access is off', () => {
    const off = connectionSummary({ ...AGENT, enabled: false, listening: false }, 'macos');
    expect(off.facts.map((fact) => fact.value)).toEqual(['Off', 'Off', 'None connected']);
    expect(off.background).toBeNull();
  });

  it('asks for a restart, or for the window to stay open, only when a hidden window may not answer', () => {
    expect(connectionSummary(AGENT, 'macos').background).toEqual({ text: 'Agents can reach it while the window is hidden.', tone: 'on' });
    expect(connectionSummary({ ...AGENT, background: 'restart-needed' }, 'macos').background?.tone).toBe('warn');
    expect(connectionSummary({ ...AGENT, background: 'unverified' }, 'windows').background?.text).toMatch(/^Keep the Draft Canvas window open/);
    expect(connectionSummary({ ...AGENT, background: 'unverified' }, 'macos').background?.text).toMatch(/macOS/);
  });
});

const folder = (handle: string, name: string, agent: boolean, within: string | null = null): AgentProject => ({
  handle,
  name,
  displayPath: `~/work/${name}`,
  agent,
  within,
});

const shape = (projects: AgentProject[]) => folderRows(projects).map((row) => [row.project.handle, row.depth, row.reachableThrough]);

describe('folderRows', () => {
  it('is empty when no folder is listed', () => {
    expect(folderRows([])).toEqual([]);
  });

  it('puts each folder under the one it sits in, keeping the list order among siblings', () => {
    const projects = [folder('web', 'web', false, 'app'), folder('app-web', 'app-web', false), folder('app', 'app', false)];
    expect(shape(projects)).toEqual([
      ['app-web', 0, null],
      ['app', 0, null],
      ['web', 1, null],
    ]);
  });

  it('names the nearest ticked folder a row is already reachable through, at any depth', () => {
    const projects = [folder('app', 'app', true), folder('web', 'web', false, 'app'), folder('docs', 'docs', false, 'web'), folder('app-web', 'app-web', false)];
    expect(shape(projects)).toEqual([
      ['app', 0, null],
      ['web', 1, 'app'],
      ['docs', 2, 'app'],
      ['app-web', 0, null],
    ]);
    const nearer = [folder('app', 'app', true), folder('web', 'web', true, 'app'), folder('docs', 'docs', false, 'web')];
    expect(shape(nearer)).toContainEqual(['docs', 2, 'web']);
  });

  it('never marks a folder reachable through an unticked parent', () => {
    expect(shape([folder('app', 'app', false), folder('web', 'web', false, 'app')])).toEqual([
      ['app', 0, null],
      ['web', 1, null],
    ]);
  });

  it('still lists a folder whose parent is missing or that loops back on itself', () => {
    const rows = shape([folder('a', 'a', false, 'b'), folder('b', 'b', false, 'a'), folder('c', 'c', false, 'gone')]);
    expect(rows.map(([handle]) => handle).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('claudeCodeCommand', () => {
  it('adds the server for every project, quoting a path with spaces', () => {
    expect(claudeCodeCommand(AGENT.sidecarPath!)).toBe('claude mcp add --scope user draft-canvas -- "/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp"');
  });
});

describe('codexConfigToml', () => {
  it('is the table Add to Codex writes, with Windows backslashes escaped for TOML', () => {
    expect(codexConfigToml(AGENT.sidecarPath!)).toBe(
      '[mcp_servers.draft-canvas]\ncommand = "/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp"\ntool_timeout_sec = 150\n',
    );
    expect(codexConfigToml('C:\\Program Files\\Draft Canvas\\draft-canvas-mcp.exe')).toContain('command = "C:\\\\Program Files\\\\Draft Canvas\\\\draft-canvas-mcp.exe"');
  });
});

describe('clientLine', () => {
  const setup = (patch: Partial<AgentClientSetup>): AgentClientSetup => ({
    client: 'codex',
    state: 'not-set-up',
    automatic: true,
    location: '~/.codex/config.toml',
    configuredCommand: null,
    ...patch,
  });

  it('offers to add, update, or says it is done', () => {
    expect(clientLine(setup({}))?.action).toBe('Add to Codex');
    expect(clientLine(setup({ client: 'claude-code' }))?.action).toBe('Add to Claude Code');
    const outdated = clientLine(setup({ state: 'outdated', configuredCommand: '/old/draft-canvas-mcp' }));
    expect(outdated).toMatchObject({ action: 'Update Codex', tone: 'warn' });
    expect(outdated?.text).toContain('/old/draft-canvas-mcp');
    expect(clientLine(setup({ state: 'ready' }))).toEqual({
      action: null,
      text: 'Set up in ~/.codex/config.toml. Start a new Codex chat to use it.',
      tone: 'on',
    });
  });

  it('says nothing before the shell has answered', () => {
    expect(clientLine(undefined)).toBeNull();
  });
});
