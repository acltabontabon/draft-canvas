import { useEffect, useState } from 'react';
import { Button } from '../../ui/common/Button';
import { useEditorStore } from '../../store/editorStore';
import type { AgentSettings as AgentState } from '../api';
import { useDesktopController, useDesktopState } from '../useDesktop';

/**
 * Settings → AI agents: whether a coding agent on this computer may reach Draft Canvas at all, which
 * folders it may read and change, and how to connect one. Off until someone turns it on; a folder is
 * reachable only once its own box is ticked. The connection secret never reaches this page — only
 * the shell holds it — so "Disconnect agents" asks the shell to replace it, which ends every open
 * connection (a configured agent reads the new one on its next request: only switching access off
 * keeps agents out).
 */
export function AgentSettings() {
  const { agent, platform } = useDesktopState();
  const controller = useDesktopController();
  useEffect(() => {
    void controller.refreshAgent();
  }, [controller]);

  return (
    <fieldset className="dc-settings-group" aria-busy={agent ? undefined : true}>
      <legend>AI agents</legend>
      <label className="dc-settings-choice">
        <input
          type="checkbox"
          checked={agent?.enabled ?? false}
          disabled={!agent}
          onChange={(event) => void controller.configureAgent({ enabled: event.target.checked })}
        />
        <span>
          Let coding agents on this computer draw diagrams
          <span className="dc-muted dc-settings-hint">
            An agent such as Claude Code can create and edit diagrams in the folders you tick below. Draft Canvas sends nothing
            anywhere; the agent’s own AI provider sees what the agent reads.
          </span>
        </span>
      </label>
      {agent?.enabled && <Enabled agent={agent} platform={platform} />}
    </fieldset>
  );
}

function Enabled({ agent, platform }: { agent: AgentState; platform: 'macos' | 'windows' | 'linux' | null }) {
  const controller = useDesktopController();
  return (
    <>
      <div className="dc-agent-folders" role="group" aria-label="Folders agents may use">
        {agent.projects.length === 0 ? (
          <p className="dc-muted dc-settings-hint">Open a folder in Draft Canvas first. Agents can only reach folders you allow here.</p>
        ) : (
          agent.projects.map((project) => (
            <label key={project.handle} className="dc-settings-choice">
              <input
                type="checkbox"
                checked={project.agent}
                onChange={(event) => void controller.configureAgent({ project: { handle: project.handle, agent: event.target.checked } })}
              />
              <span>
                {project.name}
                <span className="dc-muted dc-settings-hint">{project.displayPath}</span>
              </span>
            </label>
          ))
        )}
      </div>
      <p className="dc-muted dc-agent-status" role="status">
        {statusLine(agent)}
        {backgroundLine(agent, platform)}
      </p>
      <Connect agent={agent} />
      <div className="dc-settings-update">
        <span className="dc-muted">Ends every open connection and replaces the secret. Agents you set up reconnect on their next request; to keep them out, turn access off.</span>
        <Button variant="quiet" onClick={() => void controller.configureAgent({ rotate: true })}>
          Disconnect agents
        </Button>
      </div>
    </>
  );
}

function statusLine(agent: AgentState): string {
  if (!agent.listening) return 'Not accepting connections yet. ';
  if (agent.connections === 0) return 'Ready. No agent is connected. ';
  return agent.connections === 1 ? 'One agent is connected. ' : `${agent.connections} agents are connected. `;
}

function backgroundLine(agent: AgentState, platform: 'macos' | 'windows' | 'linux' | null): string {
  if (agent.background === 'ready') return 'Agents can reach it while the window is hidden.';
  if (agent.background === 'restart-needed') return 'Restart Draft Canvas so agents can reach it while its window is hidden.';
  return platform === 'macos'
    ? 'This version of macOS may pause Draft Canvas while its window is hidden; keep the window open while an agent works.'
    : 'Keep the Draft Canvas window open while an agent works; a hidden window may be paused.';
}

/** How to point an agent at the connector: its path, and the two setups most clients use. */
function Connect({ agent }: { agent: AgentState }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!agent.sidecarPath) {
    return <p className="dc-muted dc-settings-hint">This build of Draft Canvas doesn’t include the agent connector.</p>;
  }
  const quoted = JSON.stringify(agent.sidecarPath);
  const setups = [
    { id: 'claude-code', label: 'Claude Code', text: `claude mcp add draft-canvas -- ${quoted}` },
    { id: 'json', label: 'Other agents (MCP config)', text: JSON.stringify({ mcpServers: { 'draft-canvas': { command: agent.sidecarPath } } }, null, 2) },
  ];
  const copy = async (id: string, text: string) => {
    if (await useEditorStore.getState().copyText(text)) setCopied(id);
  };
  return (
    <div className="dc-agent-connect">
      {agent.sidecarWarning && (
        <p className="dc-agent-warning" role="note">
          {agent.sidecarWarning}
        </p>
      )}
      {setups.map((setup) => (
        <div key={setup.id} className="dc-agent-setup">
          <div className="dc-agent-setup-head">
            <span>{setup.label}</span>
            <Button variant="quiet" onClick={() => void copy(setup.id, setup.text)}>
              {copied === setup.id ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <pre>{setup.text}</pre>
        </div>
      ))}
    </div>
  );
}
