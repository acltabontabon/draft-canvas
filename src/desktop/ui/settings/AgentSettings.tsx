import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../../ui/common/Button';
import { Icon } from '../../../ui/common/Icon';
import { SegmentedControl } from '../../../ui/common/SegmentedControl';
import type { AgentClient, AgentClientSetup, AgentSettings as AgentState, AgentSkillSetup, AgentSkillTarget } from '../../api';
import { useDesktopController, useDesktopState } from '../../useDesktop';
import {
  agentOptions,
  type AgentChoice,
  claudeCodeCommand,
  clientLine,
  codexConfigToml,
  connectionSummary,
  connectStart,
  connectTitle,
  cursorDeeplink,
  firstAgent,
  folderRows,
  geminiCommand,
  genericConfigJson,
  opencodeConfigJson,
  skillLine,
  skillTargetOf,
  tryLine,
} from './agentModel';
import { ChoiceRow, CopyField, Disclosure, SettingRow, SettingsPage, SettingsSection } from '../../../ui/settings/layout';

type Platform = 'macos' | 'windows' | 'linux' | null;

/**
 * Settings → AI agents. First, whether an agent is connected and the one-click way to connect one;
 * then the page in the order someone sets it up: turn access on, choose the folders, set up an
 * agent — and, set apart, ending the connections that are open. Off until someone turns it on; a
 * folder is reachable only once its box (or a folder containing it) is ticked. The connection secret
 * never reaches this page — only the shell holds it — so "Disconnect agents" asks the shell to replace
 * it, which ends every open connection (a configured agent reads the new one on its next request:
 * only switching access off keeps agents out).
 */
export function AgentSettings() {
  const { agent, platform } = useDesktopState();
  const controller = useDesktopController();
  useEffect(() => {
    void controller.refreshAgent();
  }, [controller]);
  // What each agent's configuration says, asked once for the page: the block at the top and the steps
  // further down show the same answer, and a setup done in one is done in the other.
  const [setups, setSetups] = useState<AgentClientSetup[]>([]);
  const sidecarPath = agent?.sidecarPath;
  useEffect(() => {
    if (!sidecarPath) return;
    let live = true;
    void controller.agentClients().then((found) => live && setSetups(found));
    return () => {
      live = false;
    };
  }, [controller, sidecarPath]);
  const connected = (setup: AgentClientSetup) => setSetups((all) => [...all.filter((s) => s.client !== setup.client), setup]);

  return (
    <SettingsPage title="AI agents">
      <ConnectYourAgent agent={agent} setups={setups} onConnected={connected} />
      <SettingsSection title="Access" busy={!agent}>
        <ChoiceRow
          type="checkbox"
          toggle
          label="Allow agent access"
          description="Create and edit diagrams with a coding agent. Its AI provider can see what the agent reads."
          checked={agent?.enabled ?? false}
          disabled={!agent}
          onChange={(event) => void controller.configureAgent({ enabled: event.target.checked })}
        />
        {agent?.enabled && <ConnectionStatus agent={agent} platform={platform} />}
      </SettingsSection>
      {agent && (
        <>
          <Folders agent={agent} />
          <Connect agent={agent} platform={platform} setups={setups} onConnected={connected} />
          <Manage agent={agent} />
        </>
      )}
    </SettingsPage>
  );
}

/**
 * Connect your agent: Draft Canvas has no assistant of its own, so the page opens on the person's own
 * agent — whether one is connected right now and, while none is, the one-click setup for the first
 * agent found on this computer. Every other agent, the skill and the manual setup are in the steps
 * below (`Connect`).
 */
function ConnectYourAgent({ agent, setups, onConnected }: { agent: AgentState | null; setups: AgentClientSetup[]; onConnected: (setup: AgentClientSetup) => void }) {
  const start = agent ? connectStart(agent, setups) : null;
  return (
    <SettingsSection
      title="Connect your agent"
      description="Draft Canvas works with the coding agent you already use, such as Claude Code or Codex. It reaches your diagrams through this app, in the folders you allow."
      busy={!agent}
    >
      {agent && start && (
        <>
          <p className="dc-prefs-live" data-tone={start.live.tone} role="status">
            <span className="dc-prefs-dot" aria-hidden="true" />
            {start.live.text}
          </p>
          {start.setup && <OneClickButton setup={start.setup} blocked={!!agent.sidecarWarning} onConnected={onConnected} />}
          {start.hint && <p className="dc-prefs-description">{start.hint}</p>}
        </>
      )}
    </SettingsSection>
  );
}

function ConnectionStatus({ agent, platform }: { agent: AgentState; platform: Platform }) {
  const { facts, background } = connectionSummary(agent, platform);
  return (
    <div className="dc-prefs-status" role="status">
      <dl className="dc-prefs-facts">
        {/* Access is already expressed by the switch above. */}
        {facts.slice(1).map((fact) => (
          <div key={fact.term} className="dc-prefs-fact" data-tone={fact.tone}>
            <dt>{fact.term}</dt>
            <dd>
              <span className="dc-prefs-dot" aria-hidden="true" />
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
      {background && (
        <p className="dc-prefs-note" data-tone={background.tone}>
          <Icon name={background.tone === 'warn' ? 'alert' : 'check'} size={13} />
          <span>{background.text}</span>
        </p>
      )}
    </div>
  );
}

function Folders({ agent }: { agent: AgentState }) {
  const controller = useDesktopController();
  const rows = folderRows(agent.projects);
  return (
    <SettingsSection
      title="Allowed folders"
      group
      list={rows.length > 0}
      disabled={!agent.enabled}
      description={
        agent.enabled
          ? 'An agent can reach a ticked folder and everything inside it.'
          : 'Turn on access to choose folders. Your existing choices are kept.'
      }
    >
      {rows.length === 0 ? (
        <p className="dc-prefs-empty">No folders yet. Open a folder in Draft Canvas and it appears here.</p>
      ) : (
        rows.map(({ project, depth, reachableThrough }) => (
          <ChoiceRow
            key={project.handle}
            type="checkbox"
            depth={depth}
            label={project.name}
            detail={project.displayPath}
            description={!project.agent && reachableThrough ? `Already reachable through ${reachableThrough}` : undefined}
            data-inherited={!project.agent && reachableThrough ? '' : undefined}
            checked={project.agent}
            onChange={(event) => void controller.configureAgent({ project: { handle: project.handle, agent: event.target.checked } })}
          />
        ))
      )}
    </SettingsSection>
  );
}

/**
 * Connecting an agent, one agent at a time and the same three steps for each: point it at the
 * connector, add the skill, then try it. A step's number becomes a tick once it is done, and the one
 * solid button on show is the step to take next.
 */
function Connect({ agent, platform, setups, onConnected }: { agent: AgentState; platform: Platform; setups: AgentClientSetup[]; onConnected: (setup: AgentClientSetup) => void }) {
  const controller = useDesktopController();
  const [picked, setPicked] = useState<AgentChoice | null>(null);
  const sidecarPath = agent.sidecarPath;
  const setupOf = (which: AgentClient) => setups.find((setup) => setup.client === which);
  const [skills, setSkills] = useState<AgentSkillSetup[]>([]);
  useEffect(() => {
    if (!sidecarPath) return;
    let live = true;
    void controller.agentSkills().then((found) => live && setSkills(found));
    return () => {
      live = false;
    };
  }, [controller, sidecarPath]);
  const skillOf = (target: AgentSkillTarget) => skills.find((skill) => skill.target === target);
  const skillChanged = (setup: AgentSkillSetup) => setSkills((all) => [...all.filter((s) => s.target !== setup.target), setup]);

  // Opens on an agent that is already set up; once the person picks one, it stays picked.
  const client = picked ?? firstAgent(setups);
  const setup = client === 'cursor' || client === 'other' ? undefined : setupOf(client);
  const oneClick = { setup, blocked: !!agent.sidecarWarning, onConnected };
  // Cursor's link is a button too, though nothing here can tell whether it has been used.
  const connectPending = client === 'cursor' || !!(setup?.automatic && clientLine(setup)?.action);
  const skill = skillOf(skillTargetOf(client));
  const skillState = skillLine(skill);
  const trial = tryLine(client, agent);

  return (
    <SettingsSection title="Set up an agent" description="Draft Canvas needs to be running while the agent works.">
      {!sidecarPath ? (
        <p className="dc-prefs-empty">This build of Draft Canvas doesn’t include the agent connector.</p>
      ) : (
        <>
          {agent.sidecarWarning && (
            <p className="dc-prefs-note" data-tone="error" role="note">
              <Icon name="alert" size={13} />
              <span>{agent.sidecarWarning}</span>
            </p>
          )}
          <div className="dc-prefs-agents">
            <SegmentedControl name="agent-client" legend="Agent to connect" value={client} options={agentOptions(setups)} onChange={setPicked} />
          </div>
          {/* The role is said outright: Safari drops it from a list drawn without markers. */}
          <ol className="dc-agent-steps" role="list" aria-label={`Steps to ${connectTitle(client).replace(/^C/, 'c')}`}>
            <Step number={1} title={connectTitle(client)} done={setup?.state === 'ready'}>
              {client === 'claude-code' && (
                <OneClick {...oneClick}>
                  <p className="dc-prefs-step">Run this once in a terminal:</p>
                  <CopyField label="Terminal command" value={claudeCodeCommand(sidecarPath)} />
                </OneClick>
              )}
              {client === 'codex' && (
                <OneClick {...oneClick}>
                  <p className="dc-prefs-step">Paste into {setup?.location ?? (platform === 'windows' ? '.codex\\config.toml in your user folder' : '~/.codex/config.toml')}:</p>
                  <CopyField label="Codex MCP config" value={codexConfigToml(sidecarPath)} multiline />
                </OneClick>
              )}
              {client === 'cursor' && (
                <>
                  <div className="dc-prefs-inline">
                    <a className="dc-button dc-button-solid" href={cursorDeeplink(sidecarPath)}>
                      <Icon name="external" size={14} />
                      Add to Cursor
                    </a>
                    <span className="dc-prefs-description">Opens Cursor and adds Draft Canvas to its MCP servers.</span>
                  </div>
                  <Disclosure summary="Copy the config instead">
                    <p className="dc-prefs-step">
                      {platform === 'windows'
                        ? 'Paste into .cursor\\mcp.json in your user folder, or a project’s .cursor\\mcp.json:'
                        : 'Paste into ~/.cursor/mcp.json, or a project’s .cursor/mcp.json:'}
                    </p>
                    <CopyField label="Cursor MCP config" value={genericConfigJson(sidecarPath)} multiline />
                  </Disclosure>
                </>
              )}
              {client === 'gemini' && (
                <OneClick {...oneClick}>
                  <p className="dc-prefs-step">Run this once in a terminal:</p>
                  <CopyField label="Terminal command" value={geminiCommand(sidecarPath)} />
                </OneClick>
              )}
              {client === 'junie' && (
                <OneClick {...oneClick}>
                  <p className="dc-prefs-step">Paste into {setup?.location ?? (platform === 'windows' ? '.junie\\mcp\\mcp.json in your user folder' : '~/.junie/mcp/mcp.json')}:</p>
                  <CopyField label="Junie MCP config" value={genericConfigJson(sidecarPath)} multiline />
                </OneClick>
              )}
              {client === 'opencode' && (
                <OneClick {...oneClick}>
                  <p className="dc-prefs-step">
                    Paste into {setup?.location ?? (platform === 'windows' ? '.config\\opencode\\opencode.json in your user folder' : '~/.config/opencode/opencode.json')}, or a project’s
                    opencode.json:
                  </p>
                  <CopyField label="OpenCode MCP config" value={opencodeConfigJson(sidecarPath)} multiline />
                </OneClick>
              )}
              {client === 'other' && (
                <>
                  <p className="dc-prefs-step">Add this server to your agent’s MCP configuration:</p>
                  <CopyField label="MCP config" value={genericConfigJson(sidecarPath)} multiline />
                </>
              )}
            </Step>
            {skill && skillState && (
              <Step number={2} title="Add the skill" done={skill.state === 'ready' || skill.state === 'newer'}>
                <SkillStep setup={skill} primary={!connectPending} onChanged={skillChanged} />
              </Step>
            )}
            <Step number={skill && skillState ? 3 : 2} title="Try it" done={trial.live.tone === 'on'}>
              <p className="dc-prefs-description">{trial.text}</p>
              {/* "Set up" is what a configuration file says. Whether an agent got through is the app's own
                  to tell, and it tells it the same way for every agent. */}
              <p className="dc-prefs-live" data-tone={trial.live.tone} role="status">
                <span className="dc-prefs-dot" aria-hidden="true" />
                {trial.live.text}
              </p>
              {trial.command && (
                <Disclosure summary="Check from a terminal instead">
                  <p className="dc-prefs-step">Run this in your project folder. It should list draft-canvas as connected; a project’s own configuration can override this setup.</p>
                  <CopyField label="Terminal command" value={trial.command} />
                </Disclosure>
              )}
            </Step>
          </ol>
        </>
      )}
    </SettingsSection>
  );
}

/** One step of connecting an agent: its number, or a tick once it is done, and what it is called. */
function Step({ number, title, done, children }: { number: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="dc-agent-step" data-done={done ? '' : undefined}>
      <span className="dc-agent-step-mark" aria-hidden="true">
        {done ? <Icon name="check" size={12} /> : number}
      </span>
      <div className="dc-agent-step-body">
        <h5 className="dc-agent-step-title">
          {title}
          {done && <span className="dc-sr-only"> (done)</span>}
        </h5>
        {children}
      </div>
    </li>
  );
}

/**
 * The button that writes an agent's setup for the person (`agent/clients.rs`), what it found there,
 * and — tucked away — the manual setup (`children`). The manual setup is all there is while the
 * shell is still looking, or when it can't do it (Claude Code or Gemini CLI without its command where
 * it can be found).
 */
function OneClick({
  setup,
  blocked,
  onConnected,
  children,
}: {
  setup: AgentClientSetup | undefined;
  blocked: boolean;
  onConnected: (setup: AgentClientSetup) => void;
  children: ReactNode;
}) {
  if (!setup || !clientLine(setup) || (!setup.automatic && setup.state !== 'ready')) return <>{children}</>;
  return (
    <>
      <OneClickButton setup={setup} blocked={blocked} onConnected={onConnected} />
      <Disclosure summary="Set it up by hand instead">{children}</Disclosure>
    </>
  );
}

/** The one-click setup itself: its button and what it would do, or where the setup already is. */
function OneClickButton({ setup, blocked, onConnected }: { setup: AgentClientSetup; blocked: boolean; onConnected: (setup: AgentClientSetup) => void }) {
  const controller = useDesktopController();
  const [busy, setBusy] = useState(false);
  const line = clientLine(setup);
  if (!line) return null;
  const connect = async () => {
    setBusy(true);
    const after = await controller.connectAgentClient(setup.client);
    setBusy(false);
    if (after) onConnected(after);
  };
  return line.action ? (
    <div className="dc-prefs-inline">
      <Button variant="solid" disabled={busy || blocked} onClick={() => void connect()}>
        {busy ? 'Setting up…' : line.action}
      </Button>
      <span className="dc-prefs-description" data-tone={line.tone ?? undefined}>
        {line.text}
      </span>
    </div>
  ) : (
    // The step's tick says it is done; this says where.
    <p className="dc-prefs-description" role="status">
      {line.text}
    </p>
  );
}

/**
 * The agent skill (`agent/skill.rs`): what teaches the agent to draw a repository well, installed in
 * the folder the chosen agent reads skills from. After the connector's setup because it only helps an
 * agent that can reach Draft Canvas; its button is the solid one once that is done (`primary`). An
 * edited copy is never replaced without the person asking, and then kept as a backup.
 */
function SkillStep({ setup, primary, onChanged }: { setup: AgentSkillSetup; primary: boolean; onChanged: (setup: AgentSkillSetup) => void }) {
  const controller = useDesktopController();
  const [busy, setBusy] = useState<'install' | 'remove' | null>(null);
  const line = skillLine(setup);
  if (!line) return null;
  const run = async (what: 'install' | 'remove') => {
    setBusy(what);
    const after = what === 'install' ? await controller.installAgentSkill(setup.target) : await controller.removeAgentSkill(setup.target);
    setBusy(null);
    if (after) onChanged(after);
  };
  return (
    <>
      {line.action ? (
        <div className="dc-prefs-inline">
          <Button variant={primary ? 'solid' : undefined} className={primary ? undefined : 'dc-prefs-outline'} disabled={busy !== null} onClick={() => void run('install')}>
            {busy === 'install' ? 'Installing…' : line.action}
          </Button>
          <span className="dc-prefs-description" data-tone={line.tone ?? undefined}>
            {line.text}
          </span>
        </div>
      ) : (
        <p className="dc-prefs-description" role="status">
          {line.text}
        </p>
      )}
      {line.removable && (
        <Button className="dc-prefs-outline dc-prefs-skill-remove" disabled={busy !== null} onClick={() => void run('remove')}>
          {busy === 'remove' ? 'Removing…' : 'Remove skill'}
        </Button>
      )}
    </>
  );
}

function Manage({ agent }: { agent: AgentState }) {
  const controller = useDesktopController();
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const disconnect = async () => {
    if (!(await controller.configureAgent({ rotate: true }))) return;
    setDone(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 2000);
  };
  return (
    <SettingsSection title="Manage connections" apart>
      <SettingRow
        label="Disconnect agents"
        description={
          agent.listening
            ? 'Ends every open connection now. Agents you’ve set up reconnect on their next request; to keep them out, turn access off.'
            : agent.enabled
              ? 'The connector isn’t running, so nothing is connected.'
              : 'Nothing to disconnect while access is off.'
        }
        control={
          <Button className="dc-prefs-outline" disabled={!agent.listening} aria-label="Disconnect agents" onClick={() => void disconnect()}>
            {done ? 'Disconnected' : 'Disconnect'}
          </Button>
        }
      />
    </SettingsSection>
  );
}
