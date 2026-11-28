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

/** User scope, so every project sees it: `gemini mcp add` alone adds it to the folder the terminal
 *  happens to be in. No `--` before the path, which Gemini CLI would take for the end of its arguments. */
export function geminiCommand(sidecarPath: string): string {
  return `gemini mcp add --scope user draft-canvas ${JSON.stringify(sidecarPath)}`;
}

/** Matches `CODEX_TOOL_TIMEOUT_SECS` in `src-tauri/src/agent/clients.rs`: Codex's default 60 s
 *  would cut off a long layout before the connector's own two-minute answer arrives. */
export const CODEX_TOOL_TIMEOUT_SECS = 150;

/** What "Add to Codex" writes, for pasting by hand. A JSON string is a valid TOML basic string. */
export function codexConfigToml(sidecarPath: string): string {
  return `[mcp_servers.draft-canvas]\ncommand = ${JSON.stringify(sidecarPath)}\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECS}\n`;
}

/** What "Add to OpenCode" writes, for pasting by hand into the global `opencode.json` or a project's own.
 *  Servers sit directly under `mcp`, the layout OpenCode 1 and 2 both read; `mcp.servers` is OpenCode 2 only. */
export function opencodeConfigJson(sidecarPath: string): string {
  return JSON.stringify({ mcp: { 'draft-canvas': { type: 'local', command: [sidecarPath], enabled: true } } }, null, 2);
}

/** Every agent Settings can connect: the ones the shell sets up itself, Cursor (its own link does it) and
 *  any other MCP client (set up by hand). */
export type AgentChoice = AgentClient | 'cursor' | 'other';

const CLIENT_NAMES: Record<AgentChoice, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  junie: 'Junie',
  opencode: 'OpenCode',
  other: 'Other',
};

export interface AgentOption {
  value: AgentChoice;
  label: string;
  /** The full name, where the pill's is shortened. */
  name?: string;
  /** Where the agent's setup stands, shown on its pill: set up, or set up for another copy. */
  status?: { tone: 'on' | 'warn'; label: string };
}

/** The agents to choose from, each marked with what the shell found in its configuration, so what is
 *  already set up is seen without opening every one. Cursor and other clients keep their own
 *  configuration out of the shell's sight, and carry no mark. */
export function agentOptions(setups: readonly AgentClientSetup[]): AgentOption[] {
  const order: AgentChoice[] = ['claude-code', 'codex', 'cursor', 'gemini', 'junie', 'opencode', 'other'];
  return order.map((value) => {
    const state = setups.find((setup) => setup.client === value)?.state;
    const option: AgentOption = { value, label: CLIENT_NAMES[value] };
    if (value === 'other') option.name = 'Other MCP clients';
    if (state === 'ready') option.status = { tone: 'on', label: 'set up' };
    if (state === 'outdated') option.status = { tone: 'warn', label: 'needs an update' };
    return option;
  });
}

/** The agent Settings opens on: the first one already set up, so a returning person lands on what they
 *  use; Claude Code when nothing is. */
export function firstAgent(setups: readonly AgentClientSetup[]): AgentChoice {
  return agentOptions(setups).find((option) => option.status)?.value ?? 'claude-code';
}

/** What the first step is called: connecting this agent. */
export function connectTitle(client: AgentChoice): string {
  return client === 'other' ? 'Connect your agent' : `Connect ${CLIENT_NAMES[client]}`;
}

/** How a client picks up a new server: each reads its MCP configuration as a session starts. Gemini CLI
 *  turns every server off, its user-level ones too, in a folder the person hasn't trusted. OpenCode 1
 *  reads its configuration once, as it starts. */
const FRESH_START: Record<AgentChoice, string> = {
  'claude-code': 'Start a new Claude Code session',
  codex: 'Start a new Codex chat',
  cursor: 'Start a new chat in Cursor',
  gemini: 'Start a new Gemini CLI session in a trusted folder',
  junie: 'Start a new Junie session',
  opencode: 'Restart OpenCode',
  other: 'Restart your agent',
};

/** The agent's own command that starts each server and says whether it connected, where it has one that
 *  was checked to say so. It reads everything the agent does: a project's own configuration can override
 *  the entry Settings wrote, out of this app's sight. */
const CHECK_COMMANDS: Partial<Record<AgentChoice, string>> = {
  'claude-code': 'claude mcp list',
  opencode: 'opencode mcp list',
};

export interface TryLine {
  /** What to do in the agent, in a sentence. */
  text: string;
  /** Whether an agent is connected right now: the app's own count, the same for every agent. */
  live: { text: string; tone: FactTone };
  /** A terminal command that reports the connection from the agent's side, when it has one. */
  command: string | null;
}

/** The last step, the same for every agent: "set up" is what a configuration file says, and only an
 *  agent reaching Draft Canvas shows that it worked. The connector opens its connection on the agent's
 *  first request, so the step asks for one. */
export function tryLine(client: AgentChoice, agent: Pick<AgentSettings, 'enabled' | 'listening' | 'connections'>): TryLine {
  const live: TryLine['live'] = !agent.enabled
    ? { text: 'Agent access is off, so nothing can connect. Turn it on above.', tone: 'warn' }
    : !agent.listening
      ? { text: 'The connector isn’t ready yet.', tone: 'warn' }
      : agent.connections === 0
        ? { text: 'No agent connected yet.', tone: 'off' }
        : { text: agent.connections === 1 ? '1 agent connected.' : `${agent.connections} agents connected.`, tone: 'on' };
  return { text: `${FRESH_START[client]}, then ask it to list your Draft Canvas diagrams.`, live, command: CHECK_COMMANDS[client] ?? null };
}

export interface ConnectStart {
  /** Whether an agent is connected right now: the app's own count, as `tryLine` reads it. */
  live: { text: string; tone: FactTone };
  /** The agent to set up with one click: the first the shell can do itself, while none is set up. */
  setup: AgentClientSetup | null;
  /** What to do next when there is no button for it. */
  hint: string | null;
}

/**
 * The top of Settings → AI agents: whether an agent is connected and, while none is, the one thing to
 * do about it. Access comes first, since nothing connects without it; a connected agent needs nothing;
 * one that is set up needs a fresh start; otherwise the first agent the shell can set up itself is
 * offered with its one-click setup, and anything else is left to the steps further down.
 */
export function connectStart(agent: Pick<AgentSettings, 'enabled' | 'listening' | 'connections' | 'sidecarPath'>, setups: readonly AgentClientSetup[]): ConnectStart {
  if (!agent.enabled) return { live: { text: 'Agent access is off, so no agent can connect.', tone: 'warn' }, setup: null, hint: 'Turn on agent access below, then set up your agent.' };
  if (!agent.listening) return { live: { text: 'The connector isn’t ready yet.', tone: 'warn' }, setup: null, hint: null };
  if (agent.connections > 0) return { live: { text: agent.connections === 1 ? '1 agent is connected.' : `${agent.connections} agents are connected.`, tone: 'on' }, setup: null, hint: null };
  const live: ConnectStart['live'] = { text: 'No agent is connected yet.', tone: 'off' };
  // A build without the connector says so in the steps.
  if (!agent.sidecarPath) return { live, setup: null, hint: null };
  const ready = setups.find((setup) => setup.state === 'ready');
  if (ready) return { live, setup: null, hint: `${CLIENT_NAMES[ready.client]} is set up. ${FRESH_START[ready.client]}, then ask it to list your Draft Canvas diagrams.` };
  const setup = setups.find((candidate) => candidate.automatic) ?? null;
  return { live, setup, hint: setup ? null : 'Choose your agent under Set up an agent, below.' };
}

/** What the one-click button does, before it's done. */
function addText(client: AgentClient, where: string): string {
  switch (client) {
    case 'codex':
      return `Adds Draft Canvas to Codex’s MCP servers${where} — the Codex app, CLI and IDE extension all use it.`;
    case 'claude-code':
      return 'Runs claude mcp add for you, so every project can use Draft Canvas.';
    case 'gemini':
      return 'Runs gemini mcp add for you, so every project can use Draft Canvas.';
    case 'junie':
      return `Adds Draft Canvas to Junie’s MCP servers${where} — Junie in JetBrains IDEs and the Junie CLI both use it.`;
    case 'opencode':
      return `Adds Draft Canvas to OpenCode’s MCP servers${where}, for every project.`;
  }
}

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
  // What comes next (a fresh session, a first request) is the last step's to say: `tryLine`.
  if (setup.state === 'ready') return { action: null, text: `Set up${where}.`, tone: 'on' };
  if (setup.state === 'outdated') {
    return {
      action: `Update ${name}`,
      // OpenCode reads two files in two layouts, so its entry can also be there twice, or be another server by that name.
      text: `${name} is set up for a different copy of Draft Canvas${setup.configuredCommand ? ` (${setup.configuredCommand})` : ''}, ${setup.client === 'opencode' ? 'has it turned off, or has more than one entry for it' : 'or has it turned off'}.`,
      tone: 'warn',
    };
  }
  return { action: `Add to ${name}`, text: addText(setup.client, where), tone: null };
}

/** Which skills folder a client in Settings reads: Claude Code its own; Codex, Cursor, Gemini CLI, Junie,
 *  OpenCode and other agents the shared `~/.agents/skills` (`src-tauri/src/agent/skill.rs`). */
export function skillTargetOf(client: AgentChoice): AgentSkillTarget {
  return client === 'claude-code' ? 'claude-code' : 'agents';
}

const SKILL_READERS: Record<AgentSkillTarget, string> = { 'claude-code': 'Claude Code', agents: 'Codex, Cursor, Gemini CLI, Junie and OpenCode' };

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
