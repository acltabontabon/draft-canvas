import { useEffect, useRef, useState } from 'react';
import {
  backgroundTravels,
  collectLevels,
  copyImage,
  copySource,
  copySvg,
  countPlayableFlows,
  exportEveryLevel,
  exportPngFile,
  exportProjectFile,
  exportSecureProjectFile,
  exportSourceFile,
  exportSvgFile,
  fileNameFor,
  hasRooms,
  LEVELS_EXTENSION,
  SECURE_EXPORT_FILE_EXTENSION,
  SOURCE_FORMAT_INFO,
  sourceFileNameFor,
  sourceTextFor,
  type CopyResult,
  type SourceFormat,
} from '../../export';
import { readPreference, writePreference } from '../../lib/preferences';
import {
  readEditableImagePreference,
  readSourceFormatPreference,
  writeEditableImagePreference,
  writeSourceFormatPreference,
} from './exportPreferences';
import { fileOf, fileWithLiveViewport, useEditorStore } from '../../store/editorStore';
import { ownerAt } from '../../depth/tree';
import { displayNameFor } from '../../document/factory';
import { useUiStore } from '../../store/uiStore';
import { hostKind } from '../../host/hostInfo';
import { copyShareLink } from '../../share';
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
import { DEFAULT_PNG_SCALE, PNG_SCALES, type DocumentFormat, type ExportMode, type ImageFormat, type PngScale } from './exportTypes';
import type { ThemeName } from '../../render/theme/tokens';
import { fittedScale } from '../../render/png/rasterize';
import { count } from '../../lib/plural';
import { hasUnresolvedIn } from '../../openPoints/collect';

const EXPORT_MODE_PREFERENCE = 'export-mode';
const EXPORT_DOCUMENT_FORMAT_PREFERENCE = 'export-document-format';
const EXPORT_IMAGE_FORMAT_PREFERENCE = 'export-image-format';
const EXPORT_PNG_SCALE_PREFERENCE = 'export-png-scale';

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

function readPngScalePreference(): PngScale {
  const value = readPreference(EXPORT_PNG_SCALE_PREFERENCE);
  return PNG_SCALES.find((scale) => scale === value) ?? DEFAULT_PNG_SCALE;
}

/**
 * "4000 × 3000 px · 2×", or "… · 2× (fitted to 1.4×)" when the browser's canvas limits would not
 * let the chosen scale through — the tile must never claim a resolution the file will not have.
 */
function describePng(width: number, height: number, scale: PngScale): string {
  const chosen = Number(scale);
  const fitted = fittedScale(width, height, chosen);
  const size = `${Math.round(width * fitted)} × ${Math.round(height * fitted)} px · ${scale}×`;
  return fitted < chosen ? `${size} (fitted to ${fitted.toFixed(1)}×)` : size;
}

/** What the Copy toast says: the clipboard took it, or a file went out instead and why. */
function describeCopy(what: string, result: CopyResult): string {
  return result.copied ? `${what} copied.` : `${what} downloaded — this browser can't copy it to the clipboard.`;
}

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
  const [pngScale, setPngScaleState] = useState<PngScale>(readPngScalePreference);
  const [paletteName, setPaletteName] = useState<ThemeName>(name);
  const [transparent, setTransparent] = useState(false);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [includeBackground, setIncludeBackground] = useState(true);
  const [includeOpenPoints, setIncludeOpenPoints] = useState(true);
  // One image per room, zipped. Per open, like "Selection only": it is a choice about this picture.
  const [everyLevel, setEveryLevel] = useState(false);
  // Whether the background image rides along in the `.draftcanvas` file (up to 2 MB) — looked up
  // once per open document, since it needs the stored image's size.
  const [backgroundState, setBackgroundState] = useState<'embedded' | 'too-large' | 'none'>('none');
  useEffect(() => {
    if (!open || !document) return;
    let cancelled = false;
    void backgroundTravels(document)
      .then((state) => {
        if (!cancelled) setBackgroundState(state);
      })
      .catch(() => {
        if (!cancelled) setBackgroundState('none');
      });
    return () => {
      cancelled = true;
    };
  }, [open, document]);
  const [busy, setBusy] = useState(false);
  const [securePromptOpen, setSecurePromptOpen] = useState(false);
  const running = useRef(false);
  const [sourceFormat, setSourceFormat] = useState<SourceFormat>(readSourceFormatPreference);
  // Per image format, remembered: a few kilobytes of text inside an SVG is nothing, so it is on by
  // default there; a PNG is usually meant as just a picture, so it is off until asked for.
  const [editableSvg, setEditableSvg] = useState(() => readEditableImagePreference('svg'));
  const [editablePng, setEditablePng] = useState(() => readEditableImagePreference('png'));

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
    setEveryLevel(false);
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
  const setPngScale = (next: PngScale) => {
    setPngScaleState(next);
    writePreference(EXPORT_PNG_SCALE_PREFERENCE, next);
  };
  const setSourceFormatValue = (next: SourceFormat) => {
    setSourceFormat(next);
    writeSourceFormatPreference(next);
  };
  const editable = imageFormat === 'png' ? editablePng : editableSvg;
  const setEditable = (next: boolean) => {
    (imageFormat === 'png' ? setEditablePng : setEditableSvg)(next);
    writeEditableImagePreference(imageFormat, next);
  };
  // The whole file goes inside an editable image, every room, the way a `.draftcanvas` carries it —
  // whatever room the picture itself shows.
  const embedded = () => (editable ? fileWithLiveViewport(useEditorStore.getState()) : undefined);

  // Re-derived every render rather than a `useState` default: a flow created
  // after this dialog first mounted must still show up without a remount. Only a
  // flow with something to play is counted — an empty one would just fail to export — and the
  // count spans every room, since the source does.
  const playableFlowCount = countPlayableFlows(document);
  const sourceInfo = SOURCE_FORMAT_INFO[sourceFormat];
  const sourceEmpty = sourceInfo.family === 'sequence' && playableFlowCount === 0;
  // The text itself, generated on every render the Source panel shows — a few milliseconds for a
  // large canvas, and it is exactly what the file and the clipboard will get.
  const sourceText = effectiveMode === 'sequence' && !sourceEmpty ? sourceTextFor(document, sourceFormat) : null;

  // "Every level" is only a question when there is a level below this one; a flat canvas has one
  // picture. A selection belongs to one room, so the two cannot combine.
  const roomsBelow = hasRooms(document);
  const levelsOn = effectiveMode === 'image' && roomsBelow && everyLevel;
  const backgroundNote =
    backgroundState === 'embedded' ? ' · background inside' : backgroundState === 'too-large' ? ' · background over 2 MB, not included' : '';
  const only =
    effectiveSelectionOnly && !levelsOn && selection.nodes.length > 0 ? new Set(selection.nodes) : undefined;
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
              meta: `${count(document.nodes.length, 'element')} · ${count(document.edges.length, 'connector')}${backgroundNote}`,
            },
          }
        : {
            fileName: fileNameFor(title, SECURE_EXPORT_FILE_EXTENSION),
            visual: { type: 'file', icon: 'lock', badge: 'DCENC', meta: 'AES-GCM · passphrase required' },
          }
      : levelsOn
        ? {
            fileName: fileNameFor(title, LEVELS_EXTENSION),
            visual: {
              type: 'file',
              icon: 'file',
              badge: 'ZIP',
              meta: `${count(collectLevels(document).length, 'image')} · ${imageFormat.toUpperCase()}`,
            },
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
              describe: (width, height) =>
                `${imageFormat === 'png' ? describePng(width, height, pngScale) : `${width} × ${height} · vector`}${editable ? ' · diagram inside' : ''}`,
            },
          }
        : {
            fileName: sourceFileNameFor(document, sourceFormat),
            empty: sourceEmpty,
            visual: {
              type: 'file',
              icon: 'code',
              badge: sourceInfo.badge,
              meta: sourceEmpty
                ? 'No Flow yet'
                : sourceInfo.family === 'sequence'
                  ? `${count(playableFlowCount, 'Flow')} · plain text`
                  : `${count(sourceText?.split('\n').length ?? 0, 'line')} · ${sourceFormat === 'drawio' ? 'XML' : 'plain text'}`,
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
      : levelsOn
        ? {
            label: 'Export every level',
            disabled: busy,
            onClick: () =>
              void run(
                () => exportEveryLevel(document, { ...options, format: imageFormat, scale: Number(pngScale) }),
                'Every level export',
              ),
          }
      : effectiveMode === 'image'
        ? imageFormat === 'png'
          ? {
              label: 'Export PNG',
              disabled: busy,
              onClick: () =>
                void run(() => exportPngFile(document, { ...options, scale: Number(pngScale), editable: embedded() }), 'PNG export'),
            }
          : {
              label: 'Export SVG',
              disabled: busy,
              onClick: () => void run(() => exportSvgFile(document, { ...options, editable: embedded() }), 'SVG export'),
            }
        : {
            label: `Export ${sourceInfo.label}`,
            disabled: busy || sourceEmpty,
            onClick: () => void run(() => exportSourceFile(document, sourceFormat), `${sourceInfo.label} export`),
          };

  // The same export, pointed at the clipboard. The dialog stays open: a copy is often the first of
  // several, and nothing was downloaded to go and look at.
  const copy =
    effectiveMode === 'image' && !levelsOn
      ? {
          what: imageFormat === 'png' ? 'Image' : 'SVG',
          disabled: busy,
          task: () =>
            imageFormat === 'png'
              ? copyImage(document, { ...options, scale: Number(pngScale), editable: embedded() })
              : copySvg(document, { ...options, editable: embedded() }),
        }
      : effectiveMode === 'sequence'
        ? { what: `${sourceInfo.label} source`, disabled: busy || sourceEmpty, task: () => copySource(document, sourceFormat) }
        : null;
  const runCopy = async () => {
    if (!copy || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      notify(describeCopy(copy.what, await copy.task()));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      notify(error instanceof Error ? `Copy failed: ${error.message}` : 'Copy failed.', 'error');
    } finally {
      running.current = false;
      setBusy(false);
    }
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
            {copy && (
              <Button icon="copy" disabled={copy.disabled} onClick={() => void runCopy()}>
                Copy
              </Button>
            )}
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
            <>
              <ExportDocumentPanel format={documentFormat} onChange={setDocumentFormat} />
              {/* The web app only — see the matching command in `commands/registry.ts`. The whole
                  file goes into the link, every room, which is why this ignores the room scope. */}
              {!hostKind() && (
                <div className="dc-export-share">
                  <Button
                    icon="copy"
                    onClick={() => void copyShareLink(fileWithLiveViewport(useEditorStore.getState()), notify)}
                  >
                    Copy share link
                  </Button>
                  <p className="dc-export-panel-description">
                    Read-only, and the whole diagram is in the link itself — anyone who has it can open it. Nothing is uploaded.
                  </p>
                </div>
              )}
            </>
          )}

          {inRoom && effectiveMode !== 'document' && (
            <ExportScope whole={wholeCanvas} roomName={roomName} onChange={setWholeCanvas} />
          )}

          {effectiveMode === 'image' && (
            <ExportImagePanel
              format={imageFormat}
              onFormatChange={setImageFormat}
              scale={pngScale}
              onScaleChange={setPngScale}
              paletteName={paletteName}
              onPaletteChange={setPaletteName}
              transparent={transparent}
              onTransparentChange={setTransparent}
              hasBackground={hasBackground}
              includeBackground={includeBackground}
              onIncludeBackgroundChange={setIncludeBackground}
              selectionCount={levelsOn ? 0 : selection.nodes.length}
              selectionOnly={effectiveSelectionOnly && !levelsOn}
              onSelectionOnlyChange={(checked) => {
                setSelectionOnly(checked);
                requestExportSelection(false);
              }}
              hasOpenPoints={hasOpenPoints}
              includeOpenPoints={includeOpenPoints}
              onIncludeOpenPointsChange={setIncludeOpenPoints}
              hasRooms={roomsBelow}
              everyLevel={levelsOn}
              onEveryLevelChange={setEveryLevel}
              editable={editable}
              onEditableChange={setEditable}
            />
          )}

          {effectiveMode === 'sequence' && (
            <ExportSequencePanel
              format={sourceFormat}
              onFormatChange={setSourceFormatValue}
              playableFlowCount={playableFlowCount}
              source={sourceText}
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
