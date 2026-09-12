import { useEffect, useRef, useState } from 'react';

interface DiagramTitleFieldProps {
  title: string;
  onTitleChange: (title: string) => void;
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
export function DiagramTitleField({ title, onTitleChange }: DiagramTitleFieldProps) {
  const [localTitle, setLocalTitle] = useState(title);
  const localTitleRef = useRef(title);
  const editingTitleRef = useRef(false);
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

  return (
    <input
      className="dc-title-input"
      value={localTitle}
      maxLength={200}
      aria-label="Diagram title"
      onFocus={() => {
        editingTitleRef.current = true;
      }}
      onChange={(event) => setLocalTitleValue(event.target.value)}
      onBlur={() => {
        editingTitleRef.current = false;
        onTitleChange(localTitleRef.current);
      }}
      onKeyDown={(event) => {
        // Without this, typing "s" in the title arms the Service tool: the editor's global
        // single-key shortcuts listen on `window`.
        event.stopPropagation();
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
