import { useRef, useState } from 'react';
import { BACKGROUND_FITS, type BackgroundFit } from '../../document/types';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { getRepository } from '../../storage';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { PERSONALITY_PRESETS, usePersonality, type PersonalityPreset } from '../personality/usePersonality';

const FIT_LABELS: Record<BackgroundFit, string> = {
  cover: 'Cover',
  contain: 'Contain',
  tile: 'Tile',
};

const PRESET_LABELS: Record<PersonalityPreset, string> = {
  clean: 'Clean',
  draft: 'Draft',
  sketch: 'Sketch',
};

const PRESET_HINTS: Record<PersonalityPreset, string> = {
  clean: "Today's exact appearance.",
  draft: 'A restrained, slightly hand-drawn outline.',
  sketch: 'A more pronounced sketch quality.',
};

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp,image/gif';

/**
 * Canvas Settings — a small, deliberately single-surface dialog (Phase 5).
 * The Background section (5.1) lives here; the Personality section (5.2)
 * joins it on the same surface rather than opening a second settings screen.
 */
export function CanvasSettingsDialog() {
  const open = useUiStore((state) => state.settingsOpen);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  const notify = useUiStore((state) => state.notify);
  const bumpBackgroundImageVersion = useUiStore((state) => state.bumpBackgroundImageVersion);
  const document = useEditorStore((state) => state.document);
  const updateSettings = useEditorStore((state) => state.updateSettings);
  const { preset, setPreset } = usePersonality();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const background = document.settings.background;
  const documentId = document.metadata.id;

  const onFileChosen = async (file: File) => {
    setBusy(true);
    try {
      const bitmap = await createImageBitmap(file);
      const dims = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      const repository = await getRepository();
      await repository.saveBackgroundImage(documentId, file, dims);
      updateSettings({ background: { ...background, enabled: true } });
      bumpBackgroundImageVersion();
    } catch {
      notify("Couldn't use that image — try a different file.", 'error');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    try {
      const repository = await getRepository();
      await repository.removeBackgroundImage(documentId);
      updateSettings({ background: { ...background, enabled: false } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Canvas settings" width={480} onClose={() => setOpen(false)}>
      <div className="dc-settings">
        <section>
          <h3>Background</h3>
          <p className="dc-muted">
            A local image behind the diagram. Stays on this device — nothing is uploaded.
          </p>

          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED_TYPES}
            className="dc-sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void onFileChosen(file);
            }}
          />

          <div className="dc-settings-row">
            <Button
              variant="quiet"
              icon="upload"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {background.enabled ? 'Replace image…' : 'Choose image…'}
            </Button>
            {background.enabled && (
              <Button variant="quiet" icon="trash" disabled={busy} onClick={() => void onRemove()}>
                Remove
              </Button>
            )}
          </div>

          {background.enabled && (
            <>
              <label className="dc-field dc-field-inline">
                <span>Fit</span>
                <select
                  className="dc-select"
                  value={background.fit}
                  onChange={(event) =>
                    updateSettings({
                      background: { ...background, fit: event.target.value as BackgroundFit },
                    })
                  }
                >
                  {BACKGROUND_FITS.map((fit) => (
                    <option key={fit} value={fit}>
                      {FIT_LABELS[fit]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="dc-field dc-field-inline">
                <span>Dim</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(background.dim * 100)}
                  onChange={(event) =>
                    updateSettings({
                      background: { ...background, dim: Number(event.target.value) / 100 },
                    })
                  }
                />
              </label>

              <label className="dc-field dc-field-inline">
                <span>Blur</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(background.blur * 100)}
                  onChange={(event) =>
                    updateSettings({
                      background: { ...background, blur: Number(event.target.value) / 100 },
                    })
                  }
                />
              </label>
            </>
          )}
        </section>

        <section>
          <h3>Personality</h3>
          <p className="dc-muted">
            How the canvas draws its lines — a device preference, not part of this document.
          </p>
          <div className="dc-settings-personality">
            {PERSONALITY_PRESETS.map((p) => (
              <label key={p} className="dc-check">
                <input
                  type="radio"
                  name="personality"
                  checked={preset === p}
                  onChange={() => setPreset(p)}
                />
                <span>
                  {PRESET_LABELS[p]} <span className="dc-muted">— {PRESET_HINTS[p]}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}
