import { useRef, useState } from 'react';
import { BACKGROUND_FITS, type BackgroundFit } from '../../document/types';
import { createId } from '../../document/ids';
import { prepareBackgroundImage } from '../../lib/backgroundImage';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { getRepository } from '../../storage';
import { QuotaExceededError } from '../../storage/DraftRepository';
import { Button } from '../common/Button';
import { SegmentedControl } from '../common/SegmentedControl';
import { PERSONALITY_PRESETS, usePersonality, type PersonalityPreset } from '../personality/usePersonality';
import { PersonalityPreview } from '../personality/PersonalityPreview';
import { useTheme } from '../theme/useTheme';
import { ChoiceRow, RangeRow, SettingRow, SettingsPage, SettingsSection } from './layout';

const STYLES: Record<PersonalityPreset, { label: string; description: string }> = {
  clean: { label: 'Clean', description: 'Crisp, exact lines.' },
  draft: { label: 'Draft', description: 'A restrained, slightly hand-drawn outline.' },
  sketch: { label: 'Sketch', description: 'A more pronounced sketch quality.' },
};

const FIT_LABELS: Record<BackgroundFit, string> = {
  cover: 'Cover',
  contain: 'Contain',
  tile: 'Tile',
};

const FITS = BACKGROUND_FITS.map((fit) => ({ value: fit, label: FIT_LABELS[fit] }));

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp,image/gif';

/**
 * Settings → Canvas, on the web and the desktop: how the canvas looks and behaves. This device's preferences come first — they hold for
 * every diagram — and the open diagram's own Background last, set apart, because it is saved with the
 * file. Desktop Settings can open on Home, with no diagram: `documentOpen` says whether there is one.
 */
export function CanvasSettings({ documentOpen = true }: { documentOpen?: boolean }) {
  // A shared diagram keeps the device preferences but not the Background, which is part of the
  // document: the store refuses the change, and choosing an image would first have stored its bytes
  // in IndexedDB for a document this tab can't save.
  const readOnly = useUiStore((state) => Boolean(state.readOnly));
  const continuationsEnabled = useUiStore((state) => state.continuationsEnabled);
  const setContinuationsEnabled = useUiStore((state) => state.setContinuationsEnabled);
  const { preset, setPreset } = usePersonality();
  const { theme } = useTheme();

  return (
    <SettingsPage title="Canvas" lead="How diagrams look and behave while you draw.">
      <SettingsSection title="Drawing style" description="How shapes and connectors are drawn on this device, in every diagram." group list>
        {PERSONALITY_PRESETS.map((p) => (
          <ChoiceRow
            key={p}
            type="radio"
            name="personality"
            label={STYLES[p].label}
            description={STYLES[p].description}
            checked={preset === p}
            onChange={() => setPreset(p)}
            aside={<PersonalityPreview preset={p} theme={theme} />}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Intent Continuation"
        description="Select a shape with an obvious next move — a queue after a topic, a worker after a queue — and Draft Canvas sketches it in place."
      >
        <ChoiceRow
          type="checkbox"
          toggle
          label="Suggest the next move while drawing"
          description={
            <>
              <kbd>Tab</kbd> adds it, <kbd>]</kbd> shows the alternatives, <kbd>Esc</kbd> waves it away.
            </>
          }
          checked={continuationsEnabled}
          onChange={(event) => setContinuationsEnabled(event.target.checked)}
        />
      </SettingsSection>

      {!readOnly &&
        (documentOpen ? (
          <BackgroundSection />
        ) : (
          <SettingsSection title="Background" description="An image behind a diagram, saved with it." apart>
            <p className="dc-prefs-empty">Open a diagram to give it a background.</p>
          </SettingsSection>
        ))}
    </SettingsPage>
  );
}

/** The open diagram's background image: chosen here, stored on this device, saved with the diagram. */
function BackgroundSection() {
  const notify = useUiStore((state) => state.notify);
  // Only the two values this section shows: subscribing to the whole document would re-render it on
  // every drag frame behind the dialog.
  const background = useEditorStore((state) => state.document.settings.background);
  const documentId = useEditorStore((state) => state.document.metadata.id);
  const updateSettings = useEditorStore((state) => state.updateSettings);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onFileChosen = async (file: File) => {
    if (useUiStore.getState().readOnly) return;
    setBusy(true);
    try {
      // Oversized photos are stored downscaled — see `MAX_BACKGROUND_SIDE`.
      const { blob, width, height } = await prepareBackgroundImage(file);
      const repository = await getRepository();
      // A fresh id per image, never an overwrite: choosing or replacing one is then a plain settings
      // change, and ⌘Z steps back to the previous image, whose bytes are still stored.
      const imageId = createId('bg');
      await repository.saveBackgroundImage(documentId, blob, { width, height }, imageId);
      // A large photo takes a moment. Should another canvas be open by now, the image belongs to the
      // one it was chosen for, not to whichever is showing.
      if (useEditorStore.getState().document.metadata.id !== documentId) return;
      // Read now, not from this render: Dim or Blur may have changed while a large photo was saving.
      const current = useEditorStore.getState().document.settings.background;
      updateSettings({ background: { ...current, enabled: true, imageId } });
    } catch (error) {
      // A full disk isn't the file's fault — say what actually happened.
      notify(error instanceof QuotaExceededError ? error.message : "Couldn't use that image — try a different file.", 'error');
    } finally {
      setBusy(false);
    }
  };

  // Remove only switches the background off; stored images stay until the canvas is closed (see
  // `useDocumentSession`'s `closeDocument`), so ⌘Z brings it straight back.
  const onRemove = () => updateSettings({ background: { ...background, enabled: false } });

  return (
    <SettingsSection
      title="Background"
      description="An image behind this diagram, saved with it. It stays on this device — nothing is uploaded."
      apart
      list
      busy={busy}
    >
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_TYPES}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void onFileChosen(file);
        }}
      />
      <SettingRow
        label="Image"
        description={background.enabled ? 'Shown behind the diagram.' : 'None — the plain canvas.'}
        control={
          <>
            <Button variant="quiet" icon="upload" className="dc-prefs-outline" disabled={busy} onClick={() => fileInput.current?.click()}>
              {background.enabled ? 'Replace image…' : 'Choose image…'}
            </Button>
            {background.enabled && (
              <Button variant="quiet" icon="trash" className="dc-prefs-outline" disabled={busy} onClick={onRemove}>
                Remove
              </Button>
            )}
          </>
        }
      />
      {background.enabled && (
        <>
          <SettingRow
            label="Fit"
            control={
              <SegmentedControl
                name="background-fit"
                legend="Fit"
                value={background.fit}
                options={FITS}
                onChange={(fit) => updateSettings({ background: { ...background, fit } })}
              />
            }
          />
          <RangeRow
            label="Dim"
            value={Math.round(background.dim * 100)}
            onChange={(value) => updateSettings({ background: { ...background, dim: value / 100 } }, { coalesceKey: 'background-dim' })}
          />
          <RangeRow
            label="Blur"
            value={Math.round(background.blur * 100)}
            onChange={(value) => updateSettings({ background: { ...background, blur: value / 100 } }, { coalesceKey: 'background-blur' })}
          />
        </>
      )}
    </SettingsSection>
  );
}
