import { ACCENTS, type Accent } from '../document/types';
import { useThemeValue } from '../theme/useTheme';

export function InspectorColourButton({ label, accent, open, onClick }: {
  label: string;
  accent?: Accent;
  open: boolean;
  onClick: () => void;
}) {
  const theme = useThemeValue();
  const colour = accent ?? 'neutral';
  return (
    <button
      type="button"
      className="dc-inspector-color-swatch"
      aria-label={label}
      aria-expanded={open}
      title={colour === 'neutral' ? 'Colour: default. Change colour' : 'Change colour'}
      style={{ background: theme.accents[colour].chip }}
      onClick={onClick}
    />
  );
}

export function InspectorColourPalette({ accent, onChange }: {
  accent?: Accent;
  onChange: (accent: Accent | undefined) => void;
}) {
  const theme = useThemeValue();
  return (
    <div className="dc-popover-panel dc-swatches">
      {ACCENTS.map((colour) => (
        <button
          key={colour}
          type="button"
          className="dc-swatch"
          title={colour === 'neutral' ? 'Default colour' : colour}
          aria-label={`Colour ${colour}`}
          aria-pressed={(accent ?? 'neutral') === colour}
          style={{ background: theme.accents[colour].chip }}
          onClick={() => onChange(colour === 'neutral' ? undefined : colour)}
        />
      ))}
    </div>
  );
}
