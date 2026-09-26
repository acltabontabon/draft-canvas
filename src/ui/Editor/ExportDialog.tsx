import { useRef, useState } from 'react';
import {
  exportPngFile,
  exportProjectFile,
  exportSecureProjectFile,
  exportSequenceMermaidFile,
  exportSequencePlantUmlFile,
  exportSvgFile,
  fileNameFor,
  MERMAID_EXTENSION,
  PLANTUML_EXTENSION,
  SECURE_EXPORT_FILE_EXTENSION,
  type SequenceFormat,
} from '../../export';
import { flowIsPlayable } from '../../document/flow';
import { readPreference, writePreference } from '../../lib/preferences';
import { fileOf, fileWithLiveViewport, useEditorStore } from '../../store/editorStore';
import { ownerAt } from '../../depth/tree';
import { displayNameFor } from '../../document/factory';
import { useUiStore } from '../../store/uiStore';
import { usePersonality } from '../personality/usePersonality';
import { useTheme } from '../theme/useTheme';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { Modal } from '../common/Modal';
import { ExportModePicker } from './ExportModePicker';
import { ExportDocumentPanel } from './ExportDocumentPanel';
import { ExportImagePanel } from './ExportImagePanel';
import { ExportSequencePanel } from './ExportSequencePanel';
import { ExportArtifact, type ArtifactVisual } from './ExportArtifact';
import { SecureExportPrompt } from './SecureExportPrompt';
import type { DocumentFormat, ExportMode, ImageFormat } from './exportTypes';
import type { ThemeName } from '../../render/theme/tokens';
import { count } from '../../lib/plural';
import { hasUnresolvedIn } from '../../openPoints/collect';

const EXPORT_MODE_PREFERENCE = 'export-mode';
const EXPORT_DOCUMENT_FORMAT_PREFERENCE = 'export-document-format';
const EXPORT_IMAGE_FORMAT_PREFERENCE = 'export-image-format';
const SEQUENCE_FORMAT_PREFERENCE = 'sequence-export-format';

// First-ever open defaults to Image/PNG — the dominant "I just want a PNG" case — rather than
// Document, which was only ever first by accident of list order in the old flat layout.
function readExportModePreference(): ExportMode {
  const value = readPreference(EXPORT_MODE_PREFERENCE);
  // 'animated' (the retired GIF export) reads as the default, like any other stale value.
  return value === 'document' || value === 'image' || value === 'sequence' ? value : 'image';
}

function readDocumentFormatPreference(): DocumentFormat {
  return readPreference(EXPORT_DOCUMENT_FORMAT_PREFERENCE) === 'secure' ? 'secure' : 'editable';
}

function readImageFormatPreference(): ImageFormat {
  return readPreference(EXPORT_IMAGE_FORMAT_PREFERENCE) === 'svg' ? 'svg' : 'png';
}

function readSequenceFormatPreference(): SequenceFormat {
  return readPreference(SEQUENCE_FORMAT_PREFERENCE) === 'plantuml' ? 'plantuml' : 'mermaid';
}

const SEQUENCE_FORMAT_LABEL: Record<SequenceFormat, string> = { mermaid: 'Mermaid', plantuml: 'PlantUML' };

/**
 * Export is choose → configure → export: one mode picker, one contextual panel for whatever's
 * selected, one dominant CTA, and — beside it — the artifact you're about to get. The dialog
 * remembers the last mode/format used (`readPreference`/`writePreference`, the same mechanism
 * `sequenceFormat` already used) so reopening lands where the user left off.
 */
export function ExportDialog() {
  const open = useUiStore((state) => state.exportOpen);
  const setOpen = useUiStore((state) => state.setExportOpen);
  const notify = useUiStore((state) => state.notify);
  // Stays mounted after its first open (so in-session choices survive) — but only subscribes to the
  // document while actually open, or every drag frame would re-render a hidden dialog.
  // Inside a shape, a picture of "the canvas" is an ambiguous thing to ask for: the room being
  // drawn, or the architecture it belongs to. At the top level there is no question, so there is
  // no control — see `ExportScope` below.
  const [wholeCanvas, setWholeCanvas] = useState(false);
  const inRoom = useEditorStore((state) => state.path.length > 0);
  const roomName = useEditorStore((state) => {
    const owner = open && state.path.length > 0 ? ownerAt(fileOf(state), state.path) : undefined;
    return owner ? displayNameFor(owner) : 'this shape';
  });
  const scopeIsWhole = inRoom && wholeCanvas;
  const document = useEditorStore((state) =>
    open ? (state.path.length > 0 && wholeCanvas ? fileOf(state) : state.document) : null,
  );
  const selection = useEditorStore((state) => (open ? state.selection : null));
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  const { name } = useTheme();
  const { preset } = usePersonality();

  const [mode, setModeState] = useState<ExportMode>(readExportModePreference);
  const [documentFormat, setDocumentFormatState] = useState<DocumentFormat>(readDocumentFormatPreference);
  const [imageFormat, setImageFormatState] = useState<ImageFormat>(readImageFormatPreference);
  const [paletteName, setPaletteName] = useState<ThemeName>(name);
  const [transparent, setTransparent] = useState(false);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [includeBackground, setIncludeBackground] = useState(true);
  const [includeOpenPoints, setIncludeOpenPoints] = useState(true);
  const [busy, setBusy] = useState(false);
  const [securePromptOpen, setSecurePromptOpen] = useState(false);
  const running = useRef(false);
  const [sequenceFormat, setSequenceFormat] = useState<SequenceFormat>(readSequenceFormatPreference);

  // "Export selection…" from the command palette: the request simply reads as Image mode with the
  // checkbox on until the user touches it (a mode card, or the checkbox itself) or closes the
  // dialog — derived, not copied into state, so a later plain ⌘E reopens on the true last-used mode
  // rather than a stale one-time request.
  const selectionRequested = useUiStore((state) => state.exportSelectionRequested);
  const requestExportSelection = useUiStore((state) => state.requestExportSelection);
  // A selection belongs to the room it was made in, so it means nothing about the whole file.
  const effectiveSelectionOnly = (selectionOnly || selectionRequested) && !scopeIsWhole;
  const effectiveMode: ExportMode = selectionRequested ? 'image' : mode;

  const close = () => {
    requestExportSelection(false);
    // The checkbox is per open: left ticked, a reopen with nothing selected shows it ticked and
    // disabled, and a later single selection would export only that.
    setSelectionOnly(false);
    setOpen(false);
  };

  if (!open || !document || !selection) return null;

  const setMode = (next: ExportMode) => {
    setModeState(next);
    writePreference(EXPORT_MODE_PREFERENCE, next);
    requestExportSelection(false);
  };
  const setDocumentFormat = (next: DocumentFormat) => {
    setDocumentFormatState(next);
    writePreference(EXPORT_DOCUMENT_FORMAT_PREFERENCE, next);
  };
  const setImageFormat = (next: ImageFormat) => {
    setImageFormatState(next);
    writePreference(EXPORT_IMAGE_FORMAT_PREFERENCE, next);
  };
  const setSequenceFormatValue = (next: SequenceFormat) => {
    setSequenceFormat(next);
    writePreference(SEQUENCE_FORMAT_PREFERENCE, next);
  };

  // Re-derived every render rather than a `useState` default: a flow created
  // after this dialog first mounted must still show up without a remount. Only a
  // flow with something to play is offered — an empty one would just fail to export.
  const playableFlows = document.flows.filter((flow) => flowIsPlayable(document, flow));

  const only =
    effectiveSelectionOnly && selection.nodes.length > 0 ? new Set(selection.nodes) : undefined;
  const hasBackground = document.settings.background.enabled;
  // Only what is in the picture counts: a selection-only export of an unmarked corner has no
  // markers to offer leaving out.
  const hasOpenPoints = hasUnresolvedIn(
    only ? { ...document, nodes: document.nodes.filter((node) => only.has(node.id)), edges: document.edges.filter((edge) => only.has(edge.source) && only.has(edge.target)) } : document,
  );
  const options = {
    theme: paletteName,
    transparent,
    only,
    selectedFlowId: selectedFlowId ?? undefined,
    includeBackground: hasBackground ? includeBackground : false,
    preset,
    openPoints: hasOpenPoints ? includeOpenPoints : false,
  };

  const playableFlowCount = playableFlows.length;

  const title = document.metadata.title;
  const onlyKey = only ? selection.nodes.join(',') : '';

  const artifact: { fileName: string; visual: ArtifactVisual; empty?: boolean } =
    effectiveMode === 'document'
      ? documentFormat === 'editable'
        ? {
            fileName: fileNameFor(title),
            visual: {
              type: 'file',
              icon: 'pencil',
              badge: 'DRAFTCANVAS',
              meta: `${count(document.nodes.length, 'element')} · ${count(document.edges.length, 'connector')}`,
            },
          }
        : {
            fileName: fileNameFor(title, SECURE_EXPORT_FILE_EXTENSION),
            visual: { type: 'file', icon: 'lock', badge: 'DCENC', meta: 'AES-GCM · passphrase required' },
          }
      : effectiveMode === 'image'
        ? {
            fileName: fileNameFor(title, imageFormat === 'png' ? '.png' : '.svg'),
            visual: {
              type: 'thumbnail',
              document,
              theme: paletteName,
              options,
              onlyKey,
              scale: imageFormat === 'png' ? 2 : 1,
              describe: (width, height) =>
                imageFormat === 'png' ? `${width} × ${height} px · 2×` : `${width} × ${height} · vector`,
            },
          }
        : {
            fileName: fileNameFor(title, sequenceFormat === 'mermaid' ? MERMAID_EXTENSION : PLANTUML_EXTENSION),
            empty: playableFlowCount === 0,
            visual: {
              type: 'file',
              icon: 'code',
              badge: sequenceFormat === 'mermaid' ? 'MMD' : 'PUML',
              meta: playableFlowCount > 0 ? `${count(playableFlowCount, 'Flow')} · plain text` : 'No Flow yet',
            },
          };

  const run = async (task: () => void | Promise<void>, what: string) => {
    // `busy` only lands on the next render: a second Enter in the same moment would run it again
    // (for a secure export, a second 600k-iteration derivation and a second download).
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await task();
      close();
    } catch (error) {
      // A cancelled native Save dialog (the desktop's file saver) aborts the export: nothing failed.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      notify(
        error instanceof Error ? `${what} failed: ${error.message}` : `${what} failed.`,
        'error',
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const cta =
    effectiveMode === 'document'
      ? documentFormat === 'editable'
        ? {
            label: 'Export document',
            disabled: busy,
            onClick: () => void run(() => exportProjectFile(fileWithLiveViewport(useEditorStore.getState())), 'Document export'),
          }
        : { label: 'Export securely…', disabled: busy, onClick: () => setSecurePromptOpen(true) }
      : effectiveMode === 'image'
        ? imageFormat === 'png'
          ? {
              label: 'Export PNG',
              disabled: busy,
              onClick: () => void run(() => exportPngFile(document, options), 'PNG export'),
            }
          : {
              label: 'Export SVG',
              disabled: busy,
              onClick: () => void run(() => exportSvgFile(document, options), 'SVG export'),
            }
        : {
            label: `Export ${SEQUENCE_FORMAT_LABEL[sequenceFormat]}`,
            disabled: busy || playableFlowCount === 0,
            onClick: () =>
              void run(
                () =>
                  sequenceFormat === 'mermaid'
                    ? exportSequenceMermaidFile(document)
                    : exportSequencePlantUmlFile(document),
                'Sequence Diagram export',
              ),
          };

  return (
    <Modal
      title="Export"
      width={640}
      className="dc-modal-export"
      onClose={close}
      footer={
        <div className="dc-export-footer">
          <span
            className="dc-export-footer-note"
            title="Nothing about this diagram leaves your browser during export."
          >
            <Icon name="lock" size={13} />
            Generated locally in your browser.
          </span>
          <span className="dc-export-footer-actions">
            <Button variant="solid" icon="export" disabled={cta.disabled} aria-busy={busy || undefined} onClick={cta.onClick}>
              {busy ? 'Exporting…' : cta.label}
            </Button>
          </span>
        </div>
      }
    >
      <ExportModePicker mode={effectiveMode} onChange={setMode} />

      <div className="dc-export-body">
        <div className="dc-export-config" key={effectiveMode}>
          {effectiveMode === 'document' && (
            <ExportDocumentPanel format={documentFormat} onChange={setDocumentFormat} />
          )}

          {inRoom && effectiveMode !== 'document' && (
            <ExportScope whole={wholeCanvas} roomName={roomName} onChange={setWholeCanvas} />
          )}

          {effectiveMode === 'image' && (
            <ExportImagePanel
              format={imageFormat}
              onFormatChange={setImageFormat}
              paletteName={paletteName}
              onPaletteChange={setPaletteName}
              transparent={transparent}
              onTransparentChange={setTransparent}
              hasBackground={hasBackground}
              includeBackground={includeBackground}
              onIncludeBackgroundChange={setIncludeBackground}
              selectionCount={selection.nodes.length}
              selectionOnly={effectiveSelectionOnly}
              onSelectionOnlyChange={(checked) => {
                setSelectionOnly(checked);
                requestExportSelection(false);
              }}
              hasOpenPoints={hasOpenPoints}
              includeOpenPoints={includeOpenPoints}
              onIncludeOpenPointsChange={setIncludeOpenPoints}
            />
          )}

          {effectiveMode === 'sequence' && (
            <ExportSequencePanel
              format={sequenceFormat}
              onFormatChange={setSequenceFormatValue}
              playableFlowCount={playableFlowCount}
            />
          )}
        </div>
        <ExportArtifact fileName={artifact.fileName} visual={artifact.visual} empty={artifact.empty} />
      </div>

      {securePromptOpen && (
        <SecureExportPrompt
          busy={busy}
          onCancel={() => setSecurePromptOpen(false)}
          onConfirm={(passphrase) =>
            void run(async () => {
              await exportSecureProjectFile(fileWithLiveViewport(useEditorStore.getState()), passphrase);
              setSecurePromptOpen(false);
            }, 'Secure export')
          }
        />
      )}
    </Modal>
  );
}

/**
 * This room, or the whole canvas.
 *
 * Only ever on screen while standing inside a shape: at the top level there is one answer, and a
 * control offering it would be a question about a thing that is not in doubt. A canvas file always
 * carries every room, so the choice is about pictures — which is where "what you see" and "the
 * architecture this belongs to" genuinely differ.
 */
function ExportScope({
  whole,
  roomName,
  onChange,
}: {
  whole: boolean;
  roomName: string;
  onChange: (whole: boolean) => void;
}) {
  return (
    <fieldset className="dc-export-scope">
      <legend>What to export</legend>
      <label>
        <input type="radio" name="dc-export-scope" checked={!whole} onChange={() => onChange(false)} />
        <span>Inside {roomName}</span>
      </label>
      <label>
        <input type="radio" name="dc-export-scope" checked={whole} onChange={() => onChange(true)} />
        <span>The whole canvas</span>
      </label>
    </fieldset>
  );
}
