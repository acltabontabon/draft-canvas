import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isImeKeyEvent } from '../../../lib/isEditableTarget';

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
 */
export function DiagramTitleField({ title, onTitleChange, readOnly = false }: DiagramTitleFieldProps) {
  const [localTitle, setLocalTitle] = useState(title);
  const localTitleRef = useRef(title);
  const editingTitleRef = useRef(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const setLocalTitleValue = (value: string) => {
    localTitleRef.current = value;
    setLocalTitle(value);
  };
  useEffect(() => {
    if (!editingTitleRef.current) {
      localTitleRef.current = title;
      setLocalTitle(title);
    }
  }, [title]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
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
      }}
      onChange={(event) => setLocalTitleValue(event.target.value.replace(/[\r\n]+/g, ' '))}
      onBlur={() => {
        editingTitleRef.current = false;
        onTitleChange(localTitleRef.current);
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
          setLocalTitleValue(title);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
