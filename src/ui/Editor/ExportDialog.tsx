import { useState, type ReactNode } from 'react';
import {
  exportFlowGifFile,
  exportPngFile,
  exportProjectFile,
  exportSecureProjectFile,
  exportSequenceMermaidFile,
  exportSequencePlantUmlFile,
  exportSvgFile,
  sequenceSourceFor,
  type GifSpeed,
  type SequenceFormat,
} from '../../export';
import { flowIsPlayable } from '../../document/flow';
import { readPreference, writePreference } from '../../lib/preferences';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { usePersonality } from '../personality/usePersonality';
import { useTheme } from '../theme/useTheme';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import type { ThemeName } from '../../render/theme/tokens';

const SEQUENCE_FORMAT_PREFERENCE = 'sequence-export-format';

function readSequenceFormatPreference(): SequenceFormat {
  return readPreference(SEQUENCE_FORMAT_PREFERENCE) === 'plantuml' ? 'plantuml' : 'mermaid';
}

const SEQUENCE_FORMAT_LABEL: Record<SequenceFormat, string> = { mermaid: 'Mermaid', plantuml: 'PlantUML' };

/**
 * Export options are deliberately few: what you get, in which palette, and
 * whether the background is drawn. Anything more is a settings screen standing
 * between a diagram and a Slack message.
 *
 * Organized into three sections — Document, Image, Diagram Source — so growing the list of
 * formats doesn't turn this into an endless flat list. Options that only apply to Image exports
 * (Palette, Transparent background, Include canvas background, Selection only) live inside that
 * section rather than as global controls above everything, since Document and Diagram Source
 * exports ignore all four.
 */
export function ExportDialog() {
  const open = useUiStore((state) => state.exportOpen);
  const setOpen = useUiStore((state) => state.setExportOpen);
  const notify = useUiStore((state) => state.notify);
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  const { name } = useTheme();
  const { preset } = usePersonality();

  const [paletteName, setPaletteName] = useState<ThemeName>(name);
  const [transparent, setTransparent] = useState(false);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [includeBackground, setIncludeBackground] = useState(true);
  const [busy, setBusy] = useState(false);
  const [securePromptOpen, setSecurePromptOpen] = useState(false);
  const [gifFlowIdChoice, setGifFlowIdChoice] = useState<string | null>(null);
  const [gifSpeed, setGifSpeed] = useState<GifSpeed>('normal');
  const [gifLoop, setGifLoop] = useState(true);
  const [sequenceFormat, setSequenceFormat] = useState<SequenceFormat>(readSequenceFormatPreference);

  // "Export selection…" from the command palette: the request simply reads as the checkbox
  // being on until the user touches it or closes the dialog — derived, not copied into state, so
  // a later plain ⌘E opens with whatever was last chosen here rather than a stale request.
  const selectionRequested = useUiStore((state) => state.exportSelectionRequested);
  const requestExportSelection = useUiStore((state) => state.requestExportSelection);
  const effectiveSelectionOnly = selectionOnly || selectionRequested;
  const close = () => {
    requestExportSelection(false);
    setOpen(false);
  };

  if (!open) return null;

  // Re-derived every render rather than a `useState` default: a flow created
  // after this dialog first mounted must still show up without a remount.
  const gifFlowId =
    (gifFlowIdChoice && document.flows.some((flow) => flow.id === gifFlowIdChoice)
      ? gifFlowIdChoice
      : null) ??
    selectedFlowId ??
    document.flows[0]?.id ??
    '';

  const only =
    effectiveSelectionOnly && selection.nodes.length > 0 ? new Set(selection.nodes) : undefined;
  const hasBackground = document.settings.background.enabled;
  const options = {
    theme: paletteName,
    transparent,
    only,
    selectedFlowId: selectedFlowId ?? undefined,
    includeBackground: hasBackground ? includeBackground : false,
    preset,
  };

  const playableFlowCount = document.flows.filter((flow) => flowIsPlayable(document, flow)).length;
  const setSequenceFormatValue = (next: SequenceFormat) => {
    setSequenceFormat(next);
    writePreference(SEQUENCE_FORMAT_PREFERENCE, next);
  };

  const run = async (task: () => void | Promise<void>, what: string) => {
    setBusy(true);
    try {
      await task();
      close();
    } catch (error) {
      notify(
        error instanceof Error ? `${what} failed: ${error.message}` : `${what} failed.`,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const copySequenceSource = async (asMarkdown: boolean) => {
    const source = sequenceSourceFor(document, sequenceFormat);
    const text = asMarkdown ? `\`\`\`mermaid\n${source}\`\`\`\n` : source;
    try {
      await navigator.clipboard.writeText(text);
      notify(asMarkdown ? 'Copied as Markdown' : `Copied as ${SEQUENCE_FORMAT_LABEL[sequenceFormat]}`, 'info');
    } catch {
      notify('Copy failed — check clipboard permissions.', 'error');
    }
  };

  return (
    <Modal title="Export" width={560} onClose={close}>
      <ExportSection title="Document">
        <ExportChoice
          title="Editable document"
          detail="Anyone with this .draftcanvas file can read the diagram — plain, diffable JSON."
          action="Export document"
          busy={busy}
          onClick={() => void run(() => exportProjectFile(document), 'Document export')}
        />
        <ExportChoice
          title="Secure editable document"
          detail="A passphrase-protected .dcenc file. Only someone with the passphrase can read it."
          action="Export securely…"
          busy={busy}
          onClick={() => setSecurePromptOpen(true)}
        />
      </ExportSection>

      <ExportSection title="Image">
        <div className="dc-export-options">
          <label className="dc-field dc-field-inline">
            <span>Palette</span>
            <select
              className="dc-select"
              value={paletteName}
              onChange={(event) => setPaletteName(event.target.value as ThemeName)}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>

          <label className="dc-check">
            <input
              type="checkbox"
              checked={transparent}
              onChange={(event) => setTransparent(event.target.checked)}
            />
            <span>Transparent background</span>
          </label>

          {hasBackground && (
            <label className="dc-check">
              <input
                type="checkbox"
                checked={includeBackground}
                onChange={(event) => setIncludeBackground(event.target.checked)}
              />
              <span>Include canvas background</span>
            </label>
          )}

          <label className="dc-check" data-disabled={selection.nodes.length === 0 ? 'true' : undefined}>
            <input
              type="checkbox"
              checked={effectiveSelectionOnly}
              disabled={selection.nodes.length === 0}
              onChange={(event) => {
                setSelectionOnly(event.target.checked);
                requestExportSelection(false);
              }}
            />
            <span>
              Selection only
              {selection.nodes.length > 0 && (
                <span className="dc-muted"> ({selection.nodes.length} selected)</span>
              )}
            </span>
          </label>
        </div>

        <ExportChoice
          title="Vector image"
          detail="SVG with real text and shapes — renders in a README, scales cleanly."
          action="Export SVG"
          busy={busy}
          onClick={() => void run(() => exportSvgFile(document, options), 'SVG export')}
        />
        <ExportChoice
          title="Image"
          detail="PNG at 2× — for Slack, Teams, or a slide."
          action="Export PNG"
          busy={busy}
          onClick={() => void run(() => exportPngFile(document, options), 'PNG export')}
        />
        {document.flows.length > 0 && (
          <ExportChoice
            title="Animated flow"
            detail="A GIF walkthrough of a Flow's steps — camera moves, connectors pulse, drop it in a ticket."
            action="Export GIF"
            busy={busy || !gifFlowId}
            onClick={() =>
              void run(
                () =>
                  exportFlowGifFile(document, gifFlowId, {
                    theme: paletteName,
                    speed: gifSpeed,
                    loop: gifLoop,
                    includeBackground: options.includeBackground,
                    preset,
                  }),
                'GIF export',
              )
            }
          >
            {document.flows.length > 1 && (
              <label className="dc-field dc-field-inline">
                <span>Flow</span>
                <select
                  className="dc-select"
                  value={gifFlowId}
                  onChange={(event) => setGifFlowIdChoice(event.target.value)}
                >
                  {document.flows.map((flow) => (
                    <option key={flow.id} value={flow.id}>
                      {flow.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="dc-field dc-field-inline">
              <span>Speed</span>
              <select
                className="dc-select"
                value={gifSpeed}
                onChange={(event) => setGifSpeed(event.target.value as GifSpeed)}
              >
                <option value="slow">Slow</option>
                <option value="normal">Normal</option>
                <option value="fast">Fast</option>
              </select>
            </label>
            <label className="dc-check">
              <input type="checkbox" checked={gifLoop} onChange={(event) => setGifLoop(event.target.checked)} />
              <span>Loop continuously</span>
            </label>
          </ExportChoice>
        )}
      </ExportSection>

      <ExportSection title="Diagram Source" last>
        <ExportChoice
          title="Sequence Diagram"
          detail={
            playableFlowCount > 0
              ? 'Mermaid or PlantUML source, built from your Flows — paste it into any diagram tool.'
              : 'Add a Flow to export sequence diagram source.'
          }
          action={`Export ${SEQUENCE_FORMAT_LABEL[sequenceFormat]}`}
          busy={busy}
          disabled={playableFlowCount === 0}
          onClick={() =>
            void run(
              () =>
                sequenceFormat === 'mermaid'
                  ? exportSequenceMermaidFile(document)
                  : exportSequencePlantUmlFile(document),
              'Sequence Diagram export',
            )
          }
        >
          <label className="dc-field dc-field-inline">
            <span>Format</span>
            <select
              className="dc-select"
              value={sequenceFormat}
              disabled={playableFlowCount === 0}
              onChange={(event) => setSequenceFormatValue(event.target.value as SequenceFormat)}
            >
              <option value="mermaid">Mermaid</option>
              <option value="plantuml">PlantUML</option>
            </select>
          </label>
          {playableFlowCount > 0 && (
            <div className="dc-export-secondary-actions">
              <Button variant="quiet" onClick={() => void copySequenceSource(false)}>
                Copy source
              </Button>
              {sequenceFormat === 'mermaid' && (
                <Button variant="quiet" onClick={() => void copySequenceSource(true)}>
                  Copy as Markdown
                </Button>
              )}
            </div>
          )}
        </ExportChoice>
      </ExportSection>

      <p className="dc-muted dc-export-note">
        Exports are generated in this browser and downloaded straight to your machine.
      </p>

      {securePromptOpen && (
        <SecureExportPrompt
          busy={busy}
          onCancel={() => setSecurePromptOpen(false)}
          onConfirm={(passphrase) =>
            void run(async () => {
              await exportSecureProjectFile(document, passphrase);
              setSecurePromptOpen(false);
            }, 'Secure export')
          }
        />
      )}
    </Modal>
  );
}

/**
 * Passphrase entered twice, confirmed match required before the export
 * button is enabled — the usual "don't let a typo lock you out of your own
 * file" discipline for a secret with no recovery path.
 */
function SecureExportPrompt({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (passphrase: string) => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');

  const tooShort = passphrase.length > 0 && passphrase.length < 8;
  const mismatch = confirmPassphrase.length > 0 && passphrase !== confirmPassphrase;
  const canExport = passphrase.length >= 8 && passphrase === confirmPassphrase;

  return (
    <Modal
      title="Export securely"
      width={420}
      onClose={onCancel}
      footer={
        <>
          <Button variant="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="solid"
            icon="export"
            disabled={!canExport || busy}
            onClick={() => onConfirm(passphrase)}
          >
            Export securely
          </Button>
        </>
      }
    >
      <p className="dc-muted">
        Anyone who wants to open this file will need this passphrase. Draft Canvas does not store
        it and cannot recover it — if it's lost, the file is unreadable.
      </p>
      <label className="dc-field">
        <span>Passphrase</span>
        <input
          autoFocus
          type="password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </label>
      {tooShort && <p className="dc-muted dc-export-note">At least 8 characters.</p>}
      <label className="dc-field">
        <span>Confirm passphrase</span>
        <input
          type="password"
          value={confirmPassphrase}
          onChange={(event) => setConfirmPassphrase(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && canExport) onConfirm(passphrase);
          }}
        />
      </label>
      {mismatch && <p className="dc-muted dc-export-note">Passphrases don't match.</p>}
    </Modal>
  );
}

/** A labeled group of `ExportChoice` cards — plain text heading, never a `<details>` disclosure,
 *  so the modal's existing focus-trap/Tab-wrap logic (`Modal.tsx`) needs no changes: every control
 *  inside stays the same button/select/checkbox kind it already handles. `last` drops the section's
 *  own bottom margin/divider, since the dialog's closing note follows immediately after. */
function ExportSection({ title, last, children }: { title: string; last?: boolean; children: ReactNode }) {
  return (
    <section className={last ? 'dc-export-section dc-export-section-last' : 'dc-export-section'}>
      <h3 className="dc-export-section-title">{title}</h3>
      <div className="dc-export-actions">{children}</div>
    </section>
  );
}

function ExportChoice({
  title,
  detail,
  action,
  busy,
  disabled,
  onClick,
  children,
}: {
  title: string;
  detail: string;
  action: string;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="dc-export-choice" data-disabled={disabled ? 'true' : undefined}>
      <div>
        <strong>{title}</strong>
        <p className="dc-muted">{detail}</p>
        {children && <div className="dc-export-choice-options">{children}</div>}
      </div>
      <Button variant="solid" icon="export" disabled={busy || disabled} onClick={onClick}>
        {action}
      </Button>
    </div>
  );
}
