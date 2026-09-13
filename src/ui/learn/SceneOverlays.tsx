import type { SceneControl, SceneCursor, SceneOverlay } from '../../learn/types';
import { Icon } from '../common/Icon';
import { keyCap } from './keys';
import { at } from './stage';

/**
 * The product UI a scene borrows for a beat — a popover, a picker, key caps, the palette. Each is a
 * cut-down likeness built on the real tokens (`--dc-surface-raised`, `--dc-shadow-panel`, radii), not
 * the real component: a demo shows the one control that matters, and must never drag the editor's
 * stores into a documentation drawer.
 *
 * Everything is placed in stage units (`--u`, one 560th of the stage width), so a scene scales as a
 * single picture at any drawer width.
 */

function Control({ control }: { control: SceneControl }) {
  switch (control.type) {
    case 'select':
      return (
        <span className="dc-learn-ctl dc-learn-ctl-select">
          <span className="dc-learn-ctl-label">{control.label}</span>
          <span className="dc-learn-ctl-field" data-open={control.options ? 'true' : undefined}>
            {control.value}
            <svg viewBox="0 0 10 6" aria-hidden="true">
              <path d="M1 1l4 4 4-4" />
            </svg>
          </span>
          {control.options && (
            <span className="dc-learn-ctl-options">
              {control.options.map((option) => (
                <span key={option} data-highlight={option === control.highlight ? 'true' : undefined}>
                  {option}
                </span>
              ))}
            </span>
          )}
        </span>
      );
    case 'button':
      return (
        <span className="dc-learn-ctl dc-learn-ctl-button" data-pressed={control.pressed ? 'true' : undefined}>
          {control.icon && <Icon name={control.icon} size={12} />}
          {control.text}
        </span>
      );
    case 'chip':
      return (
        <span
          className="dc-learn-ctl dc-learn-ctl-chip"
          data-pressed={control.pressed ? 'true' : undefined}
          data-accent={control.accent ? 'true' : undefined}
        >
          <Icon name="flow" size={11} />
          {control.text}
        </span>
      );
    case 'toggle':
      return (
        <span className="dc-learn-ctl dc-learn-ctl-toggle" data-pressed={control.pressed ? 'true' : undefined}>
          <span className="dc-learn-ctl-label">{control.label}</span>
          <span className="dc-learn-ctl-switch" data-on={control.on ? 'true' : undefined}>
            {control.on ? 'On' : 'Off'}
          </span>
        </span>
      );
  }
}

export function Overlay({ overlay }: { overlay: SceneOverlay }) {
  switch (overlay.kind) {
    case 'popover':
      return (
        <div className="dc-learn-ui dc-learn-pop" data-placement={overlay.placement ?? 'above'} style={at(overlay.at)}>
          {overlay.controls.map((control, i) => (
            <Control key={i} control={control} />
          ))}
        </div>
      );
    case 'keys':
      return (
        <div className="dc-learn-ui dc-learn-keys" style={overlay.at ? at(overlay.at) : undefined} data-free={overlay.at ? undefined : 'true'}>
          {overlay.keys.map((key, i) => (
            <kbd key={`${key}-${i}`}>{keyCap(key)}</kbd>
          ))}
        </div>
      );
    case 'picker':
      return (
        <div className="dc-learn-ui dc-learn-picker" style={at(overlay.at)}>
          {overlay.title && <span className="dc-learn-picker-title">{overlay.title}</span>}
          {overlay.items.map((item) => (
            <span key={item} data-highlight={item === overlay.highlight ? 'true' : undefined}>
              {item}
            </span>
          ))}
        </div>
      );
    case 'pill':
      return (
        <div className="dc-learn-ui dc-learn-hint" style={at(overlay.at)}>
          {overlay.text}
          {overlay.keys?.map((key, i) => (
            <kbd key={`${key}-${i}`}>{keyCap(key)}</kbd>
          ))}
        </div>
      );
    case 'palette':
      return (
        <div className="dc-learn-ui dc-learn-palette">
          <span className="dc-learn-palette-input">
            <Icon name="search" size={11} />
            <span>{overlay.query}</span>
            <span className="dc-learn-caret" />
          </span>
          {overlay.rows.map((row, i) => (
            <span key={row.title} className="dc-learn-palette-row" data-highlight={i === overlay.highlight ? 'true' : undefined}>
              <span>{row.title}</span>
              {row.hint && <span className="dc-learn-palette-hint">{row.hint}</span>}
            </span>
          ))}
        </div>
      );
    case 'flowbar':
      return (
        <div className="dc-learn-ui dc-learn-flowbar">
          <span className="dc-learn-flowbar-count">
            Step {overlay.step} / {overlay.total}
          </span>
          <span className="dc-learn-flowbar-dots" aria-hidden="true">
            {Array.from({ length: overlay.total }, (_, i) => (
              <span key={i} data-state={i + 1 < overlay.step ? 'done' : i + 1 === overlay.step ? 'active' : undefined} />
            ))}
          </span>
          <span className="dc-learn-flowbar-caption">{overlay.caption}</span>
        </div>
      );
    case 'code':
      return (
        <div className="dc-learn-ui dc-learn-code" style={at(overlay.at)}>
          <span className="dc-learn-code-title">{overlay.title}</span>
          {overlay.lines.map((line, i) => (
            <code key={i}>{line}</code>
          ))}
        </div>
      );
    case 'marquee':
      return (
        <div
          className="dc-learn-marquee"
          style={{ ...at(overlay.at), width: `calc(${overlay.width} * var(--u))`, height: `calc(${overlay.height} * var(--u))` }}
        />
      );
  }
}

/** The pointer. Its move between beats is a CSS transition; a click replays a single ripple. */
export function Cursor({ cursor, beat }: { cursor: SceneCursor; beat: number }) {
  return (
    <div
      className="dc-learn-cursor"
      data-down={cursor.down ? 'true' : undefined}
      style={{ ...at(cursor), transitionDuration: `${cursor.travel ?? 480}ms` }}
    >
      {cursor.click && <span key={beat} className="dc-learn-ripple" />}
      <svg viewBox="0 0 16 20" aria-hidden="true">
        <path d="M2 1.5v14.2l3.9-3.6 2.6 6 2.5-1.1-2.6-5.9 5.3-.3z" />
      </svg>
    </div>
  );
}
