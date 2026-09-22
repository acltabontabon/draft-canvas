import { Button } from '../../ui/common/Button';
import { Modal } from '../../ui/common/Modal';
import { desktopStore } from '../store';
import { canCheck, describeUpdate, inlineParts, parseNotes, updateStatusLine, type UpdateView } from '../updates';
import { useDesktopController, useDesktopState } from '../useDesktop';

/**
 * Updating, as the page shows it: a chip that appears only when there is something to take (or a
 * download under way), a panel that says what and asks, and a section in Settings. Every word comes
 * from `describeUpdate`; every decision is the shell's.
 */

/** The notice. Absent unless there is news, and never in the way. */
export function UpdateChip({ placement }: { placement: 'home' | 'status' }) {
  const { update } = useDesktopState();
  const view = describeUpdate(update);
  if (!view.chip) return null;
  return (
    <button
      type="button"
      className="dc-update-chip"
      data-placement={placement}
      data-tone={view.tone}
      onClick={() => desktopStore.update({ updateOpen: true })}
    >
      <span className="dc-update-chip-dot" aria-hidden="true" />
      {view.chip}
      {view.progress !== undefined && (
        <span className="dc-update-chip-gauge" aria-hidden="true">
          <span style={view.progress === null ? undefined : { width: `${view.progress * 100}%` }} data-unknown={view.progress === null} />
        </span>
      )}
    </button>
  );
}

/** What the chip opens: which version, what changed, and the one next step. */
export function UpdatePanel() {
  const { update, updateOpen } = useDesktopState();
  const controller = useDesktopController();
  const view = describeUpdate(update);
  if (!updateOpen || !update || !view.version) return null;
  const close = () => desktopStore.update({ updateOpen: false });

  return (
    <Modal
      title="A new version of Draft Canvas"
      onClose={close}
      width={520}
      footer={<UpdateActions view={view} onLater={() => void controller.dismissUpdate()} />}
    >
      <div className="dc-update">
        <div className="dc-update-route" aria-label={`From version ${update.currentVersion} to version ${view.version}`}>
          <span className="dc-update-node" data-kind="current">
            <span className="dc-update-node-label">Installed</span>
            {update.currentVersion}
          </span>
          <svg className="dc-update-edge" viewBox="0 0 64 12" aria-hidden="true">
            <path d="M1 6h56" />
            <path className="dc-update-edge-head" d="M56 2l6 4-6 4" />
          </svg>
          <span className="dc-update-node" data-kind="next">
            <span className="dc-update-node-label">New</span>
            {view.version}
          </span>
        </div>

        {view.progress !== undefined && (
          <div
            className="dc-update-gauge"
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={view.progress === null ? undefined : Math.round(view.progress * 100)}
            data-unknown={view.progress === null}
          >
            <span style={view.progress === null ? undefined : { width: `${view.progress * 100}%` }} />
          </div>
        )}

        {view.detail && <p className="dc-update-detail">{view.detail}</p>}
        {view.problem && (
          <p className="dc-update-problem" role="alert">
            {view.problem}
          </p>
        )}

        <ReleaseNotes notes={view.notes} />
      </div>
    </Modal>
  );
}

function UpdateActions({ view, onLater }: { view: UpdateView; onLater: () => void }) {
  const controller = useDesktopController();
  return (
    <div className="dc-update-actions">
      {view.actions.includes('later') && (
        <Button variant="quiet" onClick={onLater}>
          Later
        </Button>
      )}
      {view.actions.includes('download') && (
        <Button variant="solid" onClick={() => void controller.downloadUpdate()}>
          Download
        </Button>
      )}
      {view.actions.includes('install') && (
        <Button variant="solid" onClick={() => void controller.installUpdate()}>
          Update and restart
        </Button>
      )}
    </div>
  );
}

/** The release's changelog section: headings and bullets, plain text only — nothing in it is HTML. */
function ReleaseNotes({ notes }: { notes: string | null }) {
  const blocks = parseNotes(notes);
  if (blocks.length === 0) return null;
  return (
    <section className="dc-update-notes" aria-label="What’s new">
      {blocks.map((block, index) =>
        block.kind === 'heading' ? (
          <h3 key={index}>{block.text}</h3>
        ) : (
          <p key={index} data-kind={block.kind}>
            {inlineParts(block.text).map((part, at) =>
              part.kind === 'strong' ? <strong key={at}>{part.text}</strong> : part.kind === 'code' ? <code key={at}>{part.text}</code> : part.text,
            )}
          </p>
        ),
      )}
    </section>
  );
}

/** Settings → Updates: the switch, where things stand, and a way to look now. */
export function UpdateSettings() {
  const { update, settings } = useDesktopState();
  const controller = useDesktopController();
  const view = describeUpdate(update);
  return (
    <fieldset className="dc-settings-group">
      <legend>Updates</legend>
      <label className="dc-settings-choice">
        <input type="checkbox" checked={settings.autoCheckUpdates} onChange={(event) => void controller.setAutoCheckUpdates(event.target.checked)} />
        <span>
          Check for updates automatically
          <span className="dc-muted dc-settings-hint">Once a day, and only to look. Nothing is downloaded or installed until you say so.</span>
        </span>
      </label>
      <div className="dc-settings-update">
        <span className="dc-muted" role="status">
          {update ? `${update.currentVersion} installed. ` : ''}
          {updateStatusLine(update)}
        </span>
        {view.version ? (
          <Button variant="quiet" onClick={() => desktopStore.update({ settingsOpen: false, updateOpen: true })}>
            Show update
          </Button>
        ) : (
          <Button variant="quiet" disabled={!canCheck(update)} onClick={() => void controller.checkForUpdate()}>
            Check for updates
          </Button>
        )}
      </div>
    </fieldset>
  );
}
