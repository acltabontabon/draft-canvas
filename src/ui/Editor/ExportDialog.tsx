import { useState, type ReactNode } from 'react';
import {
  exportFlowGifFile,
  exportPngFile,
  exportProjectFile,
  exportSecureProjectFile,
  exportSvgFile,
  type GifSpeed,
} from '../../export';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { usePersonality } from '../personality/usePersonality';
import { useTheme } from '../theme/useTheme';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import type { ThemeName } from '../../render/theme/tokens';

/**
 * Export options are deliberately few: what you get, in which palette, and
 * whether the background is drawn. Anything more is a settings screen standing
 * between a diagram and a Slack message.
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
    selectionOnly && selection.nodes.length > 0 ? new Set(selection.nodes) : undefined;
  const hasBackground = document.settings.background.enabled;
  const options = {
    theme: paletteName,
    transparent,
    only,
    selectedFlowId: selectedFlowId ?? undefined,
    includeBackground: hasBackground ? includeBackground : false,
    preset,
  };

  const run = async (task: () => void | Promise<void>, what: string) => {
    setBusy(true);
    try {
      await task();
      setOpen(false);
    } catch (error) {
      notify(
        error instanceof Error ? `${what} failed: ${error.message}` : `${what} failed.`,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export" width={520} onClose={() => setOpen(false)}>
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
            checked={selectionOnly}
            disabled={selection.nodes.length === 0}
            onChange={(event) => setSelectionOnly(event.target.checked)}
          />
          <span>
            Selection only
            {selection.nodes.length > 0 && (
              <span className="dc-muted"> ({selection.nodes.length} selected)</span>
            )}
          </span>
        </label>
      </div>

      <div className="dc-export-actions">
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
      </div>

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

function ExportChoice({
  title,
  detail,
  action,
  busy,
  onClick,
  children,
}: {
  title: string;
  detail: string;
  action: string;
  busy: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="dc-export-choice">
      <div>
        <strong>{title}</strong>
        <p className="dc-muted">{detail}</p>
        {children && <div className="dc-export-choice-options">{children}</div>}
      </div>
      <Button variant="solid" icon="export" disabled={busy} onClick={onClick}>
        {action}
      </Button>
    </div>
  );
}
