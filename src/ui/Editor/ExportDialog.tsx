import { useState } from 'react';
import { exportPngFile, exportProjectFile, exportSvgFile } from '../../export';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
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

  const [paletteName, setPaletteName] = useState<ThemeName>(name);
  const [transparent, setTransparent] = useState(false);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const only =
    selectionOnly && selection.nodes.length > 0 ? new Set(selection.nodes) : undefined;
  const options = {
    theme: paletteName,
    transparent,
    only,
    selectedFlowId: selectedFlowId ?? undefined,
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
          detail=".draftcanvas — everything needed to reopen and keep editing."
          action="Export document"
          busy={busy}
          onClick={() => void run(() => exportProjectFile(document), 'Document export')}
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
      </div>

      <p className="dc-muted dc-export-note">
        Exports are generated in this browser and downloaded straight to your machine.
      </p>
    </Modal>
  );
}

function ExportChoice({
  title,
  detail,
  action,
  busy,
  onClick,
}: {
  title: string;
  detail: string;
  action: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <div className="dc-export-choice">
      <div>
        <strong>{title}</strong>
        <p className="dc-muted">{detail}</p>
      </div>
      <Button variant="solid" icon="export" disabled={busy} onClick={onClick}>
        {action}
      </Button>
    </div>
  );
}
