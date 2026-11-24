import { useUiStore } from '../../store/uiStore';
import { ChoiceRow, SettingsPage, SettingsSection } from './layout';

/**
 * Settings → Canvas, on the web and the desktop: how the canvas behaves. This device's preferences
 * hold for every diagram. What is behind a diagram (its canvas colour and backdrop) is part of its
 * style, in Appearance.
 */
export function CanvasSettings() {
  return (
    <SettingsPage title="Canvas" lead="Suggestions are yours, on this device.">
      <SettingsSection
        title="Next-shape suggestions"
        description="Select a shape with an obvious follow-on — a queue after a topic, a worker after a queue — and Draft Canvas sketches it in place. The shape picker a dropped connector opens still lists these first."
      >
        <NextShapeSuggestions />
      </SettingsSection>
    </SettingsPage>
  );
}

/** The one switch: whether a likely next shape is sketched in place. Also in the Appearance panel's Canvas tab. */
export function NextShapeSuggestions() {
  const continuationsEnabled = useUiStore((state) => state.continuationsEnabled);
  const setContinuationsEnabled = useUiStore((state) => state.setContinuationsEnabled);
  return (
    <ChoiceRow
      type="checkbox"
      toggle
      label="Suggest the next shape while drawing"
      description={
        <>
          <kbd>Tab</kbd> adds it, <kbd>]</kbd> shows the alternatives, <kbd>Esc</kbd> waves it away.
        </>
      }
      checked={continuationsEnabled}
      onChange={(event) => setContinuationsEnabled(event.target.checked)}
    />
  );
}
