import { useEffect, useId, useRef, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import { Icon } from '../../../ui/common/Icon';
import { useEditorStore } from '../../../store/editorStore';

/**
 * The few pieces every Settings page is built from, so a new setting is a row in an existing section
 * and a new page is one entry in `SettingsDialog`'s list — never new layout. Presentation only: each
 * page reads the desktop store and calls the controller itself.
 */

export function SettingsPage({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="dc-prefs-page">
      <header className="dc-prefs-page-head">
        <h3>{title}</h3>
        {lead && <p>{lead}</p>}
      </header>
      {children}
    </div>
  );
}

interface SectionProps {
  title: string;
  description?: ReactNode;
  /** A set of choices answering one question (radios, a folder list): a fieldset, so its title names the group. */
  group?: boolean;
  /** Only with `group`: every control inside is disabled, and says so through the fieldset. */
  disabled?: boolean;
  /** Set apart by a rule, for something that isn't routine setup. */
  apart?: boolean;
  /** A list of like rows (folders): framed once, hairlines between, rather than spaced apart. */
  list?: boolean;
  busy?: boolean;
  children: ReactNode;
}

export function SettingsSection({ title, description, group, disabled, apart, list, busy, children }: SectionProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const head = description && (
    <p id={descriptionId} className="dc-prefs-section-description">
      {description}
    </p>
  );
  if (group) {
    return (
      <fieldset
        className="dc-prefs-section"
        data-apart={apart ? '' : undefined}
        disabled={disabled}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
      >
        <legend className="dc-prefs-section-title">{title}</legend>
        {head}
        <div className="dc-prefs-rows" data-list={list ? '' : undefined}>
          {children}
        </div>
      </fieldset>
    );
  }
  return (
    <section
      className="dc-prefs-section"
      data-apart={apart ? '' : undefined}
      aria-labelledby={`${id}-title`}
      aria-describedby={descriptionId}
      aria-busy={busy || undefined}
    >
      <h4 id={`${id}-title`} className="dc-prefs-section-title">
        {title}
      </h4>
      {head}
      <div className="dc-prefs-rows" data-list={list ? '' : undefined}>
          {children}
        </div>
    </section>
  );
}

interface ChoiceRowProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'> {
  type: 'checkbox' | 'radio';
  label: ReactNode;
  /** Part of what identifies the choice (a folder's path): shown under the label, and part of its name. */
  detail?: ReactNode;
  description?: ReactNode;
  /** A master on/off: drawn as a switch at the end of the row. */
  toggle?: boolean;
  /** How far in a nested row sits. */
  depth?: number;
}

/** A checkbox, radio or switch with its label, the whole row a click target. */
export function ChoiceRow({ type, label, detail, description, toggle, depth, ...input }: ChoiceRowProps) {
  const id = useId();
  const labelledBy = detail ? `${id}-label ${id}-detail` : `${id}-label`;
  return (
    <label
      className="dc-prefs-row dc-prefs-choice"
      data-toggle={toggle ? '' : undefined}
      style={depth ? ({ '--dc-prefs-depth': Math.min(depth, 4) } as CSSProperties) : undefined}
    >
      <input
        {...input}
        type={type}
        role={toggle ? 'switch' : undefined}
        className={toggle ? 'dc-prefs-switch' : undefined}
        aria-labelledby={labelledBy}
        aria-describedby={description ? `${id}-description` : undefined}
      />
      <span className="dc-prefs-row-text">
        <span id={`${id}-label`} className="dc-prefs-label">
          {label}
        </span>
        {detail && (
          <span id={`${id}-detail`} className="dc-prefs-detail">
            {detail}
          </span>
        )}
        {description && (
          <span id={`${id}-description`} className="dc-prefs-description">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

/** A label and its explanation, with an action at the end of the row (under it, when space runs out). */
export function SettingRow({ label, description, control }: { label: ReactNode; description?: ReactNode; control: ReactNode }) {
  return (
    <div className="dc-prefs-row dc-prefs-action">
      <div className="dc-prefs-row-text">
        <span className="dc-prefs-label">{label}</span>
        {description && <span className="dc-prefs-description">{description}</span>}
      </div>
      <div className="dc-prefs-control">{control}</div>
    </div>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Something to paste elsewhere: shown whole (long content scrolls inside the block, never the dialog)
 * and copied whole. The button says what happened for two seconds, and a live region says it to a
 * screen reader.
 */
export function CopyField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const id = useId();
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await useEditorStore.getState().copyText(value);
    setState(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  };

  return (
    <div className="dc-prefs-copy" data-multiline={multiline ? '' : undefined}>
      <div className="dc-prefs-copy-head">
        <span id={`${id}-label`}>{label}</span>
        <button type="button" className="dc-prefs-copy-button" data-state={state} aria-describedby={`${id}-label`} onClick={() => void copy()}>
          <Icon name={state === 'copied' ? 'check' : state === 'failed' ? 'alert' : 'copy'} size={13} />
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy'}
        </button>
      </div>
      {/* Focusable so a keyboard can scroll a line wider than the block. */}
      <pre tabIndex={0} aria-labelledby={`${id}-label`}>
        {value}
      </pre>
      <span className="dc-sr-only" aria-live="polite">
        {state === 'copied' ? `${label} copied` : state === 'failed' ? `Couldn’t copy the ${label.toLowerCase()}` : ''}
      </span>
    </div>
  );
}

/** Something most people won't need, one click away. */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="dc-prefs-disclosure">
      <button type="button" className="dc-prefs-disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((was) => !was)}>
        <Icon name={open ? 'down' : 'forward'} size={12} />
        {summary}
      </button>
      <div id={id} className="dc-prefs-disclosure-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
