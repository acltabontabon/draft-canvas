import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../ui/common/Button';
import { Icon } from '../../../ui/common/Icon';
import { SegmentedControl } from '../../../ui/common/SegmentedControl';
import type { AgentSettings as AgentState } from '../../api';
import { useDesktopController, useDesktopState } from '../../useDesktop';
import { claudeCodeCommand, connectionSummary, cursorDeeplink, folderRows, genericConfigJson } from './agentModel';
import { ChoiceRow, CopyField, Disclosure, SettingRow, SettingsPage, SettingsSection } from './layout';

type Platform = 'macos' | 'windows' | 'linux' | null;

/**
 * Settings → AI agents, in the order someone sets it up: turn access on, choose the folders, connect
 * an agent — and, set apart, ending the connections that are open. Off until someone turns it on; a
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

  return (
    <SettingsPage title="AI agents" lead="Let a coding agent such as Claude Code create and edit diagrams in folders you choose.">
      <SettingsSection title="Access" busy={!agent}>
        <ChoiceRow
          type="checkbox"
          toggle
          label="Allow agent access"
          description="Agents can work only in the folders you allow below. Draft Canvas sends nothing anywhere; the agent’s own AI provider sees what the agent reads."
          checked={agent?.enabled ?? false}
          disabled={!agent}
          onChange={(event) => void controller.configureAgent({ enabled: event.target.checked })}
        />
        {agent && <ConnectionStatus agent={agent} platform={platform} />}
      </SettingsSection>
      {agent && (
        <>
          <Folders agent={agent} />
          <Connect agent={agent} platform={platform} />
          <Manage agent={agent} />
        </>
      )}
    </SettingsPage>
  );
}

function ConnectionStatus({ agent, platform }: { agent: AgentState; platform: Platform }) {
  const { facts, background } = connectionSummary(agent, platform);
  return (
    <div className="dc-prefs-status" role="status">
      <dl className="dc-prefs-facts">
        {facts.map((fact) => (
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
          : 'Access is off, so agents can’t reach any folder. Your choices are kept for when you turn it back on.'
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

type Client = 'claude-code' | 'cursor' | 'other';

const CLIENTS: { value: Client; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'other', label: 'Other MCP clients' },
];

/** How to point an agent at the connector — one client at a time, never every setup at once. */
function Connect({ agent, platform }: { agent: AgentState; platform: Platform }) {
  const [client, setClient] = useState<Client>('claude-code');
  const sidecarPath = agent.sidecarPath;
  return (
    <SettingsSection title="Connect an agent" description="Draft Canvas needs to be running while the agent works.">
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
          <SegmentedControl name="agent-client" legend="Agent to connect" value={client} options={CLIENTS} onChange={setClient} />
          <div className="dc-prefs-client">
            {client === 'claude-code' && (
              <>
                <p className="dc-prefs-step">Run this once in a terminal:</p>
                <CopyField label="Terminal command" value={claudeCodeCommand(sidecarPath)} />
              </>
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
            {client === 'other' && (
              <>
                <p className="dc-prefs-step">Add this server to your agent’s MCP configuration:</p>
                <CopyField label="MCP config" value={genericConfigJson(sidecarPath)} multiline />
              </>
            )}
          </div>
        </>
      )}
    </SettingsSection>
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
