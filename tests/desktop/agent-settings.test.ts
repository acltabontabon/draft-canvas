import { describe, expect, it } from 'vitest';
import type { AgentClientSetup, AgentProject, AgentSettings, AgentSkillSetup } from '../../src/desktop/api';
import { claudeCodeCommand, clientLine, codexConfigToml, connectionSummary, folderRows, geminiCommand, skillLine, skillTargetOf } from '../../src/desktop/ui/settings/agentModel';

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

describe('geminiCommand', () => {
  it('adds the server for every project, with no `--` before the quoted path', () => {
    expect(geminiCommand(AGENT.sidecarPath!)).toBe('gemini mcp add --scope user draft-canvas "/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp"');
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
    expect(clientLine(setup({ client: 'gemini' }))).toMatchObject({ action: 'Add to Gemini CLI', text: expect.stringContaining('gemini mcp add') });
    expect(clientLine(setup({ client: 'junie', location: '~/.junie/mcp/mcp.json' }))).toMatchObject({
      action: 'Add to Junie',
      text: 'Adds Draft Canvas to Junie’s MCP servers in ~/.junie/mcp/mcp.json — Junie in JetBrains IDEs and the Junie CLI both use it.',
    });
    expect(clientLine(setup({ client: 'junie', state: 'outdated' }))?.action).toBe('Update Junie');
    const outdated = clientLine(setup({ state: 'outdated', configuredCommand: '/old/draft-canvas-mcp' }));
    expect(outdated).toMatchObject({ action: 'Update Codex', tone: 'warn' });
    expect(outdated?.text).toContain('/old/draft-canvas-mcp');
    expect(clientLine(setup({ state: 'ready' }))).toEqual({
      action: null,
      text: 'Set up in ~/.codex/config.toml. Start a new Codex chat to use it.',
      tone: 'on',
    });
    expect(clientLine(setup({ client: 'gemini', state: 'ready', location: '~/.gemini/settings.json' }))?.text).toBe(
      'Set up in ~/.gemini/settings.json. Start a new Gemini CLI session in a trusted folder to use it.',
    );
  });

  it('says nothing before the shell has answered', () => {
    expect(clientLine(undefined)).toBeNull();
  });
});

describe('skillLine', () => {
  const skill = (patch: Partial<AgentSkillSetup>): AgentSkillSetup => ({
    target: 'claude-code',
    state: 'not-installed',
    location: '~/.claude/skills/draft-canvas',
    installedVersion: null,
    bundledVersion: '2',
    backup: null,
    ...patch,
  });

  it('installs for Claude Code in its own folder, and for Codex, Cursor, Gemini CLI, Junie and others in the shared one', () => {
    expect(skillTargetOf('claude-code')).toBe('claude-code');
    expect(skillTargetOf('codex')).toBe('agents');
    expect(skillTargetOf('cursor')).toBe('agents');
    expect(skillTargetOf('gemini')).toBe('agents');
    expect(skillTargetOf('junie')).toBe('agents');
    expect(skillTargetOf('other')).toBe('agents');
    const line = skillLine(skill({}));
    expect(line).toMatchObject({ action: 'Install skill', removable: false });
    expect(line?.text).toContain('Installs in ~/.claude/skills for every project.');
    expect(skillLine(skill({ target: 'agents', location: '~/.agents/skills/draft-canvas' }))?.text).toContain('Teaches Codex, Cursor, Gemini CLI and Junie');
  });

  it('says the skill updates with the app, and never offers to touch a newer copy', () => {
    expect(skillLine(skill({ state: 'ready', installedVersion: '2' }))).toEqual({
      action: null,
      text: 'Skill installed in ~/.claude/skills/draft-canvas. It updates when Draft Canvas does.',
      tone: 'on',
      removable: true,
    });
    expect(skillLine(skill({ state: 'outdated', installedVersion: '1' }))).toMatchObject({ action: 'Update skill', tone: 'warn' });
    expect(skillLine(skill({ state: 'newer', installedVersion: '3' }))).toMatchObject({ action: null, removable: false });
    expect(skillLine(skill({ state: 'newer', installedVersion: '3' }))?.text).toContain('(3)');
  });

  it('leaves an edited copy alone until asked, and says where it was kept', () => {
    const edited = skillLine(skill({ state: 'modified' }));
    expect(edited).toMatchObject({ action: 'Replace skill', tone: 'warn', removable: true });
    expect(edited?.text).toContain('keeps your copy as a backup');
    expect(skillLine(skill({ state: 'ready', backup: '~/Library/Application Support/x/draft-canvas-1' }))?.text).toContain(
      'Your edited copy is in ~/Library/Application Support/x/draft-canvas-1.',
    );
  });

  it('says nothing before the shell has answered', () => {
    expect(skillLine(undefined)).toBeNull();
  });
});
