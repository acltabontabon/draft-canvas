import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { downloadBlob } from '../../export/download';
import { fileNameFor } from '../../export/project';
import { readPreference, removePreference, writePreference } from '../../lib/preferences';
import { HISTORY_PREFS, historyEnabled, historyService } from '../../store/evolution/bridge';
import { useEvolutionStore } from '../../store/evolution/evolutionStore';
import { Button } from '../common/Button';
import { ChoiceRow, SettingRow, SettingsPage, SettingsSection } from './layout';
import '../Editor/history/history.css';

/**
 * Settings → History: Canvas Evolution's controls, on the web and the desktop.
 *
 * Deliberately short. The defaults need nothing set up; what is here is how often history is
 * recorded, who it says recorded it, and the controls that keep people in charge of what is kept —
 * each a separate, plainly named action: stop recording, export the history, remove it.
 */

const INTERVALS: { label: string; seconds: number }[] = [
  { label: '15 seconds', seconds: 15 },
  { label: '30 seconds', seconds: 30 },
  { label: '1 minute', seconds: 60 },
  { label: '2 minutes', seconds: 120 },
  { label: '5 minutes', seconds: 300 },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function IntervalSelect({ prefKey, fallback, label }: { prefKey: string; fallback: number; label: string }) {
  const [value, setValue] = useState(() => Number(readPreference(prefKey)) || fallback);
  return (
    <select
      className="dc-select"
      aria-label={label}
      value={value}
      onChange={(event) => {
        const next = Number(event.target.value);
        setValue(next);
        if (next === fallback) removePreference(prefKey);
        else writePreference(prefKey, String(next));
      }}
    >
      {INTERVALS.map((interval) => (
        <option key={interval.seconds} value={interval.seconds}>
          {interval.label}
        </option>
      ))}
    </select>
  );
}

function TextPref({ prefKey, label, placeholder }: { prefKey: string; label: string; placeholder: string }) {
  const [value, setValue] = useState(() => readPreference(prefKey) ?? '');
  return (
    <span className="dc-field">
    <input
      aria-label={label}
      placeholder={placeholder}
      maxLength={64}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        const next = value.trim();
        if (next) writePreference(prefKey, next);
        else removePreference(prefKey);
      }}
    />
    </span>
  );
}

/** A destructive action asked twice, with what it does and does not do said before the second press. */
function ConfirmAction({ label, confirmLabel, warning, onConfirm, disabled }: { label: string; confirmLabel: string; warning: ReactNode; onConfirm: () => Promise<void> | void; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) cancel.current?.focus();
  }, [asking]);
  if (!asking) {
    return (
      <Button variant="quiet" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="dc-history-confirm" role="group" aria-label={label}>
      <span className="dc-prefs-description">{warning}</span>
      <Button
        variant="danger"
        onClick={() => {
          setAsking(false);
          void onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button ref={cancel} variant="quiet" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  );
}

export function HistorySettings() {
  const [enabled, setEnabled] = useState(historyEnabled);
  const [usage, setUsage] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [paused, setPaused] = useState(() => historyService().paused);
  const fileInput = useRef<HTMLInputElement>(null);
  const { repoId, changes } = useEvolutionStore(useShallow((state) => ({ repoId: state.repoId, changes: state.changes })));

  useEffect(() => {
    let live = true;
    historyService()
      .usage()
      .then((bytes) => live && setUsage(bytes))
      .catch(() => live && setUsage(null));
    return () => {
      live = false;
    };
  }, [changes]);

  const exportHistory = async () => {
    setMessage(null);
    try {
      const result = await historyService().exportHistory({ archived: true });
      if (!result) {
        setMessage('This diagram has no history yet.');
        return;
      }
      await downloadBlob(new Blob([result.bytes as BlobPart], { type: 'application/x-git-bundle' }), fileNameFor(`${result.title} history`, '.bundle'));
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      setMessage('The history could not be exported.');
    }
  };

  const importHistory = async (file: File) => {
    setMessage(null);
    try {
      const imported = await historyService().importHistory(new Uint8Array(await file.arrayBuffer()));
      await historyService().adoptHistory(imported.repoId);
      setMessage(
        `Imported ${imported.revisions} revision${imported.revisions === 1 ? '' : 's'}. This diagram now continues that history; its earlier history is still on this device.${imported.ignored.length ? ` ${imported.ignored.length} branch${imported.ignored.length === 1 ? '' : 'es'} from another tool were left out.` : ''}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That file could not be imported.');
    }
  };

  return (
    <SettingsPage title="History" lead="Draft Canvas keeps each diagram’s history on this device as you work, in standard Git. Nothing is uploaded.">
      <SettingsSection title="Recording">
        <ChoiceRow
          type="checkbox"
          toggle
          label="Keep a history of every diagram"
          description="Revisions are added in the background while you draw. Turning this off stops recording; history already kept stays."
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            if (event.target.checked) removePreference(HISTORY_PREFS.enabled);
            else writePreference(HISTORY_PREFS.enabled, 'off');
          }}
        />
        <SettingRow label="Add a revision after" description="this long without changes." control={<IntervalSelect prefKey={HISTORY_PREFS.idle} fallback={30} label="Add a revision after" />} />
        <SettingRow label="While drawing steadily, at least every" control={<IntervalSelect prefKey={HISTORY_PREFS.max} fallback={120} label="At least every" />} />
      </SettingsSection>

      <SettingsSection
        title="Recorded as"
        description="The name and email history’s revisions carry. Left empty, they say “Draft Canvas”. This is a label, not a sign-in or proof of who drew what."
      >
        <SettingRow label="Name" control={<TextPref prefKey={HISTORY_PREFS.name} label="Name" placeholder="Draft Canvas" />} />
        <SettingRow label="Email" control={<TextPref prefKey={HISTORY_PREFS.email} label="Email" placeholder="history@draftcanvas.invalid" />} />
      </SettingsSection>

      <SettingsSection
        title="This diagram"
        description="History keeps earlier versions — including shapes and text you later deleted. Exporting the diagram itself never includes its history."
      >
        <ChoiceRow
          type="checkbox"
          toggle
          label="Record this diagram’s history"
          checked={!paused}
          disabled={!repoId}
          onChange={(event) => {
            const next = !event.target.checked;
            setPaused(next);
            void historyService().setPaused(next);
          }}
        />
        <div className="dc-history-settings-actions">
          <Button variant="quiet" disabled={!repoId} onClick={() => void exportHistory()}>
            Export history…
          </Button>
          <Button variant="quiet" onClick={() => fileInput.current?.click()}>
            Import history…
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".bundle,application/x-git-bundle"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importHistory(file);
            }}
          />
          <ConfirmAction
            label="Remove this diagram’s history…"
            confirmLabel="Remove history"
            disabled={!repoId}
            warning="Every revision of this diagram on this device is deleted. The diagram stays as it is. Exported or published copies are not affected. Recording starts again with your next change unless you turn it off above first."
            onConfirm={async () => {
              await historyService().removeHistory();
              setMessage('This diagram’s history was removed from this device.');
            }}
          />
        </div>
        {message && (
          <p className="dc-prefs-description" role="status">
            {message}
          </p>
        )}
      </SettingsSection>

      <SettingsSection title="Storage">
        <SettingRow
          label="History on this device"
          description={
            __DESKTOP__
              ? 'Kept in the app’s data folder.'
              : 'Kept in this browser. Clearing site data, or the browser making room, can remove it — export a diagram’s history to keep a copy.'
          }
          control={<span className="dc-muted">{usage === null ? '—' : formatBytes(usage)}</span>}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
