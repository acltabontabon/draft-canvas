import { useEffect, useRef } from 'react';
import { useUiStore } from '../../../store/uiStore';
import { DEV_PRESETS, PRESETS, SELECT_TOOLTIP, tooltipContentFor, type Preset } from '../../../canvas/presets';
import { Button } from '../../common/Button';
import { Tooltip } from '../../common/Tooltip';

/**
 * What you can put on the canvas — the toolbar's centre of gravity, since drawing architecture is
 * the whole point of the app.
 *
 * One recessed rail holding exactly one active segment: the tool currently in your hand. The
 * trough is the `SegmentedControl` idiom (`--dc-canvas` in a hairline border), which the codebase
 * already uses wherever one option of several is chosen — so this reads as native rather than as
 * a new kind of container invented for the toolbar.
 *
 * Names, not icons. "Data Store" and "Queue" say what they are, and a developer sketching a
 * system should never have to learn a diagramming app's private glyph vocabulary first.
 *
 * The three families are separated by whitespace alone — interaction, annotation, architecture —
 * because a divider between every pair is what made the old bar read as an inventory.
 */
export function CreateRail() {
  const armed = useUiStore((state) => state.armed);
  const arm = useUiStore((state) => state.arm);
  const railRef = useRef<HTMLDivElement>(null);

  const segments = () => [...(railRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];

  // One tab stop for the whole rail, per the ARIA toolbar pattern: eleven separate stops made
  // reaching the canvas by keyboard a chore. The stop lives on the tool you actually have in
  // hand, so tabbing in and pressing an arrow starts from where you already are.
  useEffect(() => {
    const items = segments();
    const active = items.findIndex((button) => button.getAttribute('aria-pressed') === 'true');
    const home = active === -1 ? 0 : active;
    for (const [index, button] of items.entries()) button.tabIndex = index === home ? 0 : -1;
  }, [armed]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = segments();
    const from = items.indexOf(document.activeElement as HTMLButtonElement);
    if (from === -1) return;
    // Both are load-bearing. `EditorScreen`'s window key handler nudges the selected element on
    // arrow keys and only bails on editable targets — a focused button is not one — so without
    // `stopPropagation` here, arrowing along the rail would quietly move the user's diagram.
    // Escape is deliberately not intercepted: `Tooltip` documents that contract.
    event.preventDefault();
    event.stopPropagation();
    const to =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowLeft'
            ? Math.max(0, from - 1)
            : Math.min(items.length - 1, from + 1);
    for (const [index, button] of items.entries()) button.tabIndex = index === to ? 0 : -1;
    items[to]?.focus();
  };

  const toolButton = (preset: Preset) => (
    <Tooltip key={preset.id} content={tooltipContentFor(preset)}>
      {(tip) => (
        <Button
          variant="ghost"
          active={armed?.id === preset.id}
          aria-pressed={armed?.id === preset.id}
          onClick={() => arm(armed?.id === preset.id ? null : preset)}
          {...tip}
        >
          {preset.label}
        </Button>
      )}
    </Tooltip>
  );

  return (
    <div
      ref={railRef}
      className="dc-create-rail"
      role="toolbar"
      aria-label="Create"
      onKeyDown={onKeyDown}
    >
      <div className="dc-create-family">
        <Tooltip content={SELECT_TOOLTIP}>
          {(tip) => (
            <Button
              variant="ghost"
              active={armed === null}
              aria-pressed={armed === null}
              onClick={() => arm(null)}
              {...tip}
            >
              Select
            </Button>
          )}
        </Tooltip>
      </div>
      <div className="dc-create-family">{PRESETS.map(toolButton)}</div>
      <div className="dc-create-family">{DEV_PRESETS.map(toolButton)}</div>
    </div>
  );
}
