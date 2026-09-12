import { useRef, useState } from 'react';
import {
  exportFlowGifFile,
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
  type GifSpeed,
  type SequenceFormat,
} from '../../export';
import { flowIsPlayable } from '../../document/flow';
import { readPreference, writePreference } from '../../lib/preferences';
import { documentWithLiveViewport, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { usePersonality } from '../personality/usePersonality';
import { useTheme } from '../theme/useTheme';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { Modal } from '../common/Modal';
import { ExportModePicker } from './ExportModePicker';
import { ExportDocumentPanel } from './ExportDocumentPanel';
import { ExportImagePanel } from './ExportImagePanel';
import { ExportAnimatedPanel } from './ExportAnimatedPanel';
import { ExportSequencePanel } from './ExportSequencePanel';
import { ExportArtifact, type ArtifactVisual } from './ExportArtifact';
import { SecureExportPrompt } from './SecureExportPrompt';
import type { DocumentFormat, ExportMode, ImageFormat } from './exportTypes';
import type { ThemeName } from '../../render/theme/tokens';

const EXPORT_MODE_PREFERENCE = 'export-mode';
const EXPORT_DOCUMENT_FORMAT_PREFERENCE = 'export-document-format';
const EXPORT_IMAGE_FORMAT_PREFERENCE = 'export-image-format';
const SEQUENCE_FORMAT_PREFERENCE = 'sequence-export-format';

// First-ever open defaults to Image/PNG — the dominant "I just want a PNG" case — rather than
// Document, which was only ever first by accident of list order in the old flat layout.
function readExportModePreference(): ExportMode {
  const value = readPreference(EXPORT_MODE_PREFERENCE);
  return value === 'document' || value === 'image' || value === 'animated' || value === 'sequence'
    ? value
    : 'image';
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
const SPEED_LABEL: Record<GifSpeed, string> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
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
  const document = useEditorStore((state) => (open ? state.document : null));
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
  const [busy, setBusy] = useState(false);
  // A GIF of a long flow takes a while: its progress drives the button, and Cancel (or closing the
  // dialog) aborts it between frames.
  const [gifProgress, setGifProgress] = useState<number | null>(null);
  const gifAbort = useRef<AbortController | null>(null);
  const [securePromptOpen, setSecurePromptOpen] = useState(false);
  const [gifFlowIdChoice, setGifFlowIdChoice] = useState<string | null>(null);
  const [gifSpeed, setGifSpeed] = useState<GifSpeed>('normal');
  const [gifLoop, setGifLoop] = useState(true);
  const [sequenceFormat, setSequenceFormat] = useState<SequenceFormat>(readSequenceFormatPreference);

  // "Export selection…" from the command palette: the request simply reads as Image mode with the
  // checkbox on until the user touches it (a mode card, or the checkbox itself) or closes the
  // dialog — derived, not copied into state, so a later plain ⌘E reopens on the true last-used mode
  // rather than a stale one-time request.
  const selectionRequested = useUiStore((state) => state.exportSelectionRequested);
  const requestExportSelection = useUiStore((state) => state.requestExportSelection);
  const effectiveSelectionOnly = selectionOnly || selectionRequested;
  const effectiveMode: ExportMode = selectionRequested ? 'image' : mode;

  const close = () => {
    gifAbort.current?.abort();
    requestExportSelection(false);
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

  const title = document.metadata.title;
  const onlyKey = only ? selection.nodes.join(',') : '';
  const gifSteps = document.flows.find((flow) => flow.id === gifFlowId)?.steps.length ?? 0;

  const artifact: { fileName: string; visual: ArtifactVisual; empty?: boolean } =
    effectiveMode === 'document'
      ? documentFormat === 'editable'
        ? {
            fileName: fileNameFor(title),
            visual: {
              type: 'file',
              icon: 'pencil',
              badge: 'DRAFTCANVAS',
              meta: `${count(document.nodes.length, 'element')} · ${count(document.edges.length, 'connection')}`,
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
        : effectiveMode === 'animated'
          ? {
              fileName: fileNameFor(title, '.gif'),
              empty: !gifFlowId,
              visual: {
                type: 'thumbnail',
                document,
                theme: paletteName,
                options: { theme: paletteName, selectedFlowId: gifFlowId || undefined, preset },
                onlyKey: '',
                scale: 1,
                describe: () =>
                  `${count(gifSteps, 'step')} · ${SPEED_LABEL[gifSpeed]}${gifLoop ? ' · loop' : ''}`,
                motion: { speed: gifSpeed, loop: gifLoop },
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
    setBusy(true);
    try {
      await task();
      close();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return; // cancelled, not failed
      notify(
        error instanceof Error ? `${what} failed: ${error.message}` : `${what} failed.`,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const cta =
    effectiveMode === 'document'
      ? documentFormat === 'editable'
        ? {
            label: 'Export document',
            disabled: busy,
            onClick: () => void run(() => exportProjectFile(documentWithLiveViewport(useEditorStore.getState())), 'Document export'),
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
        : effectiveMode === 'animated'
          ? {
              label: 'Export GIF',
              disabled: busy || !gifFlowId,
              onClick: () =>
                void run(async () => {
                  const controller = new AbortController();
                  gifAbort.current = controller;
                  setGifProgress(0);
                  try {
                    await exportFlowGifFile(document, gifFlowId, {
                      theme: paletteName,
                      speed: gifSpeed,
                      loop: gifLoop,
                      includeBackground: options.includeBackground,
                      preset,
                      signal: controller.signal,
                      onProgress: (done, total) => setGifProgress(Math.floor((done / total) * 100)),
                    });
                  } finally {
                    gifAbort.current = null;
                    setGifProgress(null);
                  }
                }, 'GIF export'),
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
            {gifProgress !== null && (
              <Button variant="quiet" onClick={() => gifAbort.current?.abort()}>
                Cancel
              </Button>
            )}
            <Button variant="solid" icon="export" disabled={cta.disabled} aria-busy={busy || undefined} onClick={cta.onClick}>
              {gifProgress !== null ? `Rendering GIF… ${gifProgress}%` : busy ? 'Exporting…' : cta.label}
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
            />
          )}

          {effectiveMode === 'animated' && (
            <ExportAnimatedPanel
              flows={document.flows.map((flow) => ({ id: flow.id, title: flow.title }))}
              flowId={gifFlowId}
              onFlowChange={setGifFlowIdChoice}
              speed={gifSpeed}
              onSpeedChange={setGifSpeed}
              loop={gifLoop}
              onLoopChange={setGifLoop}
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
              await exportSecureProjectFile(documentWithLiveViewport(useEditorStore.getState()), passphrase);
              setSecurePromptOpen(false);
            }, 'Secure export')
          }
        />
      )}
    </Modal>
  );
}
