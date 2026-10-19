import type { AgentClient, AgentClientSetup, AgentProject, AgentSettings, AgentSkillSetup, AgentSkillTarget } from '../../api';

/**
 * What Settings → AI agents says, worked out without React so it can be tested on its own: the
 * connection facts, the folder list as a tree, and the setups each client is given.
 */

export type FactTone = 'on' | 'off' | 'warn';

export interface Fact {
  term: string;
  value: string;
  tone: FactTone;
}

export interface ConnectionSummary {
  /** Access, the connector, and connected agents — three separate truths, each from its own field. */
  facts: Fact[];
  /** Whether agents can reach a hidden window. Only said while access is on. */
  background: { text: string; tone: 'on' | 'warn' } | null;
}

export function connectionSummary(agent: AgentSettings, platform: 'macos' | 'windows' | 'linux' | null): ConnectionSummary {
  const access: Fact = { term: 'Access', value: agent.enabled ? 'On' : 'Off', tone: agent.enabled ? 'on' : 'off' };
  const connector: Fact = !agent.enabled
    ? { term: 'Connector', value: 'Off', tone: 'off' }
    : agent.listening
      ? { term: 'Connector', value: 'Ready', tone: 'on' }
      : { term: 'Connector', value: 'Not ready yet', tone: 'warn' };
  const agents: Fact =
    agent.connections === 0
      ? { term: 'Agents', value: 'None connected', tone: 'off' }
      : { term: 'Agents', value: agent.connections === 1 ? '1 connected' : `${agent.connections} connected`, tone: 'on' };
  return { facts: [access, connector, agents], background: agent.enabled ? backgroundLine(agent, platform) : null };
}

function backgroundLine(agent: AgentSettings, platform: 'macos' | 'windows' | 'linux' | null): ConnectionSummary['background'] {
  if (agent.background === 'ready') return { text: 'Agents can reach it while the window is hidden.', tone: 'on' };
  if (agent.background === 'restart-needed') return { text: 'Restart Draft Canvas so agents can reach it while its window is hidden.', tone: 'warn' };
  return {
    text:
      platform === 'macos'
        ? 'This version of macOS may pause Draft Canvas while its window is hidden; keep the window open while an agent works.'
        : 'Keep the Draft Canvas window open while an agent works; a hidden window may be paused.',
    tone: 'warn',
  };
}

export interface FolderRow {
  project: AgentProject;
  /** How many listed folders this one sits inside. */
  depth: number;
  /** The nearest ticked folder containing this one — which already lets agents in here. */
  reachableThrough: string | null;
}

/**
 * The listed folders with each one under the folder it sits inside, keeping the shell's order
 * (most recently opened first) among siblings. Access is granted by path prefix, so a ticked
 * parent reaches every folder inside it whatever that folder's own box says; the row says so
 * rather than changing the box.
 */
export function folderRows(projects: readonly AgentProject[]): FolderRow[] {
  const byHandle = new Map(projects.map((project) => [project.handle, project]));
  const parentOf = (project: AgentProject) => (project.within ? byHandle.get(project.within) : undefined);
  const children = new Map<string | null, AgentProject[]>();
  for (const project of projects) {
    const key = parentOf(project) ? project.within! : null;
    children.set(key, [...(children.get(key) ?? []), project]);
  }

  const rows: FolderRow[] = [];
  const placed = new Set<string>();
  const visit = (project: AgentProject, depth: number, through: string | null) => {
    if (placed.has(project.handle)) return;
    placed.add(project.handle);
    rows.push({ project, depth, reachableThrough: through });
    const next = project.agent ? project.name : through;
    for (const child of children.get(project.handle) ?? []) visit(child, depth + 1, next);
  };
  for (const root of children.get(null) ?? []) visit(root, 0, null);
  // A `within` that loops back on itself can't come from the shell, but must not hide a folder.
  for (const project of projects) visit(project, 0, null);
  return rows;
}

/** The one server definition every setup below is built from, so the deeplink and the pasted config
 *  (Cursor's own, and the generic "other agents" one) can never quietly drift apart from each other. */
export function cursorServerConfig(sidecarPath: string) {
  return { command: sidecarPath };
}

export function genericConfigJson(sidecarPath: string): string {
  return JSON.stringify({ mcpServers: { 'draft-canvas': cursorServerConfig(sidecarPath) } }, null, 2);
}

/** Cursor writes its own config when this link is opened — Draft Canvas never edits another app's
 *  config file directly, which is what makes this the reliable "automatic setup" the other clients
 *  don't have. The pasted-JSON fallback (`genericConfigJson`) is for a machine with no `cursor://`
 *  handler registered, or a project-scoped `.cursor/mcp.json` someone wants to review before adding —
 *  built from the same `cursorServerConfig`, just wrapped for a different consumer. */
export function cursorDeeplink(sidecarPath: string): string {
  const encoded = encodeURIComponent(btoa(JSON.stringify(cursorServerConfig(sidecarPath))));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=draft-canvas&config=${encoded}`;
}

/** User scope, so every project sees it: `claude mcp add` alone adds it to the folder the terminal
 *  happens to be in, and nowhere else. */
export function claudeCodeCommand(sidecarPath: string): string {
  return `claude mcp add --scope user draft-canvas -- ${JSON.stringify(sidecarPath)}`;
}

/** Matches `CODEX_TOOL_TIMEOUT_SECS` in `src-tauri/src/agent/clients.rs`: Codex's default 60 s
 *  would cut off a long layout before the connector's own two-minute answer arrives. */
export const CODEX_TOOL_TIMEOUT_SECS = 150;

/** What "Add to Codex" writes, for pasting by hand. A JSON string is a valid TOML basic string. */
export function codexConfigToml(sidecarPath: string): string {
  return `[mcp_servers.draft-canvas]\ncommand = ${JSON.stringify(sidecarPath)}\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECS}\n`;
}

const CLIENT_NAMES: Record<AgentClient, string> = { codex: 'Codex', 'claude-code': 'Claude Code' };

export interface ClientLine {
  /** The button's label, or null when there's nothing left to do. */
  action: string | null;
  /** Where the setup stands, in a sentence. */
  text: string;
  tone: 'on' | 'warn' | null;
}

/** What Settings says beside the one-click setup for `setup.client`. */
export function clientLine(setup: AgentClientSetup | undefined): ClientLine | null {
  if (!setup) return null;
  const name = CLIENT_NAMES[setup.client];
  const where = setup.location ? ` in ${setup.location}` : '';
  const restart = setup.client === 'codex' ? 'Start a new Codex chat to use it.' : 'Start a new Claude Code session to use it.';
  if (setup.state === 'ready') return { action: null, text: `Set up${where}. ${restart}`, tone: 'on' };
  if (setup.state === 'outdated') {
    return {
      action: `Update ${name}`,
      text: `${name} is set up for a different copy of Draft Canvas${setup.configuredCommand ? ` (${setup.configuredCommand})` : ''}, or has it turned off.`,
      tone: 'warn',
    };
  }
  return {
    action: `Add to ${name}`,
    text:
      setup.client === 'codex'
        ? `Adds Draft Canvas to Codex’s MCP servers${where} — the Codex app, CLI and IDE extension all use it.`
        : `Runs claude mcp add for you, so every project can use Draft Canvas.`,
    tone: null,
  };
}

/** Which skills folder a client in Settings reads: Claude Code its own; Codex, Cursor and other agents
 *  the shared `~/.agents/skills` (`src-tauri/src/agent/skill.rs`). */
export function skillTargetOf(client: AgentClient | 'cursor' | 'other'): AgentSkillTarget {
  return client === 'claude-code' ? 'claude-code' : 'agents';
}

const SKILL_READERS: Record<AgentSkillTarget, string> = { 'claude-code': 'Claude Code', agents: 'Codex and Cursor' };

export interface SkillLine {
  /** The main button's label, or null when there's nothing to do. */
  action: string | null;
  text: string;
  tone: 'on' | 'warn' | null;
  /** Whether a quiet Remove is offered beside it. */
  removable: boolean;
}

/** What Settings says about the agent skill in one target. The skill only helps an agent that can
 *  reach Draft Canvas, so it sits under the connector's setup, as the second half of connecting. */
export function skillLine(setup: AgentSkillSetup | undefined): SkillLine | null {
  if (!setup) return null;
  const readers = SKILL_READERS[setup.target];
  const where = setup.location ?? (setup.target === 'claude-code' ? '~/.claude/skills' : '~/.agents/skills');
  const kept = setup.backup ? ` Your edited copy is in ${setup.backup}.` : '';
  switch (setup.state) {
    case 'not-installed':
      return {
        action: 'Install skill',
        text: `Teaches ${readers} to draw a repository well — C4 levels, flows to present, notes and source evidence. Installs in ${where.replace(/[/\\]draft-canvas$/, '')} for every project.`,
        tone: null,
        removable: false,
      };
    case 'ready':
      return { action: null, text: `Skill installed in ${where}. It updates when Draft Canvas does.${kept}`, tone: 'on', removable: true };
    case 'outdated':
      return {
        action: 'Update skill',
        text: `The skill in ${where} is from an earlier Draft Canvas. It’s replaced the next time Draft Canvas starts, or now.`,
        tone: 'warn',
        removable: true,
      };
    case 'modified':
      return {
        action: 'Replace skill',
        text: `The skill in ${where} has been changed, so Draft Canvas leaves it alone. Replacing it keeps your copy as a backup.`,
        tone: 'warn',
        removable: true,
      };
    case 'newer':
      return {
        action: null,
        text: `A newer version of the skill${setup.installedVersion ? ` (${setup.installedVersion})` : ''} is in ${where}, from a newer Draft Canvas.`,
        tone: 'on',
        removable: false,
      };
  }
}
