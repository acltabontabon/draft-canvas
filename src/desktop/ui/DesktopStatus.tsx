import { Button } from '../../ui/common/Button';
import { Icon } from '../../ui/common/Icon';
import { desktopStore } from '../store';
import { useDesktopController, useDesktopState } from '../useDesktop';
import { UpdateChip } from './Updates';

/**
 * The desktop's stand-in for the browser's "Saved locally" indicator. The file is the document
 * here, so it says where the file is and whether what's on screen is in it — and for a Quick Draft,
 * which has no file yet, where the work is being kept until it does. An update, when there is one,
 * waits at the end of the line.
 */
export function DesktopStatus() {
  const { doc, saving, agent } = useDesktopState();
  const controller = useDesktopController();
  // Only while access is on: a status bar that mentioned agents to someone who never turned them on
  // would make the setup look like a prerequisite. Off, it says nothing.
  const agents = agent?.enabled ? (
    <button
      type="button"
      className="dc-muted dc-status-hint dc-status-agents"
      title="Agent access is on — Settings → AI agents"
      onClick={() => desktopStore.update({ settingsOpen: true, settingsCategory: 'agents' })}
    >
      {agent.connections > 0 ? `${agent.connections === 1 ? '1 agent' : `${agent.connections} agents`} connected` : 'Agents: on'}
    </button>
  ) : null;

  if (doc.kind === 'quick') {
    return (
      <div className="dc-status-left">
        <span className="dc-save" data-status={doc.dirty ? 'dirty' : 'saved'}>
          Quick Draft
        </span>
        <span className="dc-muted dc-status-hint">Kept on this computer until you save it.</span>
        <Button variant="quiet" onClick={() => void controller.save()}>
          Save…
        </Button>
        {agents}
        <UpdateChip placement="status" />
      </div>
    );
  }

  if (doc.kind !== 'file') {
    return (
      <div className="dc-status-left">
        {agents}
        <UpdateChip placement="status" />
      </div>
    );
  }

  const state = saving ? 'saving' : doc.dirty ? 'dirty' : 'saved';
  return (
    <div className="dc-status-left">
      <span className="dc-save" data-status={state}>
        {saving ? (
          'Saving…'
        ) : doc.dirty ? (
          'Unsaved changes'
        ) : (
          <>
            <Icon name="lock" /> Saved
          </>
        )}
      </span>
      {/* Said apart from the label, which changes with every edit. Only news is announced. */}
      <span className="dc-sr-only" role="status">
        {doc.outside === 'changed'
          ? `${doc.name} was changed on disk.`
          : doc.outside === 'missing'
            ? `${doc.name} was moved or deleted.`
            : ''}
      </span>
      <span className="dc-muted dc-status-hint" title={doc.displayPath}>
        {doc.outside === 'changed'
          ? 'Changed on disk since you opened it. Saving will ask before replacing it.'
          : doc.outside === 'missing'
            ? 'This file was moved or deleted. Save As… keeps your work.'
            : doc.readOnly
              ? `${doc.displayPath} · read-only`
              : doc.displayPath}
      </span>
      {agents}
      <UpdateChip placement="status" />
    </div>
  );
}
