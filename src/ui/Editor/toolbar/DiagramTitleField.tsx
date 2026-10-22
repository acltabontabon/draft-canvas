import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isImeKeyEvent } from '../../../lib/isEditableTarget';
import { InkStroke } from '../../Library/InkedWords';

interface DiagramTitleFieldProps {
  title: string;
  onTitleChange: (title: string) => void;
  /** A shared diagram's name is shown, not edited. */
  readOnly?: boolean;
}

/**
 * The canvas's name, edited in place.
 *
 * Edited locally and committed only on blur/Enter, like every other text field in the app
 * (node/edge text, edge label, condition/response) — never written to the store per keystroke.
 * `setTitle` trims the committed value; running that trim on every keystroke instead of once
 * would strip a space the instant it's typed, since it's momentarily the last character.
 *
 * `localTitleRef` (not just the `localTitle` state) is what onBlur commits: Escape calls
 * `blur()` synchronously right after reverting, before React has re-rendered the input with
 * the reverted value, so onBlur can't trust the DOM's own `.value` or a `localTitle` closure —
 * only a ref is guaranteed current at that point.
 *
 * Blur commits only after the person typed (`dirtyTitleRef`). It once committed on every blur,
 * so focusing the title, letting a cross-tab or agent rename land, then clicking away wrote the
 * stale title back as a Rename undo step. Until they type, a title that changes underneath the
 * focused field is adopted rather than ignored.
 */
export function DiagramTitleField({ title, onTitleChange, readOnly = false }: DiagramTitleFieldProps) {
  const [localTitle, setLocalTitle] = useState(title);
  const localTitleRef = useRef(title);
  const editingTitleRef = useRef(false);
  const dirtyTitleRef = useRef(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const setLocalTitleValue = (value: string) => {
    localTitleRef.current = value;
    setLocalTitle(value);
  };
  useEffect(() => {
    if (!editingTitleRef.current || !dirtyTitleRef.current) {
      localTitleRef.current = title;
      setLocalTitle(title);
    }
  }, [title]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    // On its own island the name hugs its text, up to the column's width, rather than leaving an
    // empty run after a short name.
    const width = titleWidth(field, localTitle);
    if (width !== null) field.style.width = `${width}px`;
    field.style.height = 'auto';
    field.style.height = `${Math.max(28, field.scrollHeight + 2)}px`;
  }, [localTitle]);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field || typeof ResizeObserver === 'undefined') return;
    let width = field.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = field.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      field.style.height = 'auto';
      field.style.height = `${Math.max(28, field.scrollHeight + 2)}px`;
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  return (
    // Written like Home's headline — the same italic serif, underlined by the same hand.
    <span className="dc-title-field">
      <textarea
        ref={fieldRef}
        rows={1}
        className="dc-title-input"
        value={localTitle}
        maxLength={200}
        aria-label="Diagram title"
        readOnly={readOnly}
        aria-disabled={readOnly || undefined}
        onFocus={() => {
          editingTitleRef.current = true;
          dirtyTitleRef.current = false;
        }}
        onChange={(event) => {
          dirtyTitleRef.current = true;
          setLocalTitleValue(event.target.value.replace(/[\r\n]+/g, ' '));
        }}
        onBlur={() => {
          editingTitleRef.current = false;
          if (dirtyTitleRef.current) onTitleChange(localTitleRef.current);
          dirtyTitleRef.current = false;
          // Show what was kept, not what was typed: `setTitle` trims, and an emptied title falls back
          // to the default. When that leaves the stored title unchanged the effect above never runs,
          // so reset here; when it did change, that effect then lands the new title over this.
          setLocalTitleValue(title);
        }}
        onKeyDown={(event) => {
          // Without this, typing "s" in the title arms the Service tool: the editor's global
          // single-key shortcuts listen on `window`.
          event.stopPropagation();
          if (isImeKeyEvent(event)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            dirtyTitleRef.current = false;
            setLocalTitleValue(title);
            event.currentTarget.blur();
          }
        }}
      />
      <InkStroke className="dc-title-stroke" />
    </span>
  );
}

/** The narrowest and widest the name's field may be, in px. */
const TITLE_MIN = 72;
const TITLE_MAX = 240;
let measure: CanvasRenderingContext2D | null | undefined;

/** How wide `field` needs to be to show `text` on one line — or `null` where text can't be measured. */
function titleWidth(field: HTMLTextAreaElement, text: string): number | null {
  measure ??= typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!measure) return null;
  const style = getComputedStyle(field);
  measure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const chrome = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  // A pixel or two over the measured run, so the caret at the end never wraps the last letter.
  return Math.min(TITLE_MAX, Math.max(TITLE_MIN, Math.ceil(measure.measureText(text || ' ').width + chrome + 3)));
}
