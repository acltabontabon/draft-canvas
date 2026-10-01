import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { countLabelMatches, type ReplaceOptions } from '../../document/operations';
import { roomsOf } from '../../depth/tree';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { count } from '../../lib/plural';
import { fileOf, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

/**
 * Find and replace across the whole file — every room, not just the one on screen — as one undo
 * step. The count is live: it is the same `countLabelMatches` the store's `findAndReplace` runs,
 * over the same rooms, so what the dialog promises is exactly what Replace all does.
 *
 * Mounted by `FindReplaceHost` below, which owns the ⌘⌥F / Ctrl+H chord and the open flag, so the toolbar
 * can carry it without the editor screen knowing the dialog exists.
 */
export function FindReplaceDialog({ onClose }: { onClose: () => void }) {
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const countId = useId();
  const notify = useUiStore((state) => state.notify);
  const findAndReplace = useEditorStore((state) => state.findAndReplace);
  // The three slices `fileOf` reads, subscribed so the count follows an edit made while it is open.
  const document = useEditorStore((state) => state.document);
  const path = useEditorStore((state) => state.path);
  const outer = useEditorStore((state) => state.outer);

  const options = useMemo<ReplaceOptions>(() => ({ matchCase, wholeWord }), [matchCase, wholeWord]);
  const matches = useMemo(() => {
    if (find.length === 0) return 0;
    return roomsOf(fileOf({ document, path, outer })).reduce((sum, room) => sum + countLabelMatches(room.graph, find, options), 0);
  }, [document, path, outer, find, options]);

  useEffect(() => {
    findInput.current?.focus();
  }, []);

  const replaceAll = () => {
    if (matches === 0) return;
    const changed = findAndReplace(find, replace, options);
    if (changed === 0) {
      // A gesture was under way, or the text changed between the count and the commit.
      notify('Nothing was replaced — try again.', 'error');
      return;
    }
    notify(`Replaced ${count(changed, 'occurrence')} of “${find}”.`);
    onClose();
  };

  // Keys stay in the dialog: the canvas's own shortcuts (Delete, the tool letters) must not fire
  // while someone is typing the word to find.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !isImeKeyEvent(event)) {
      event.preventDefault();
      replaceAll();
    }
  };

  const status = find.length === 0 ? 'Type what to find.' : matches === 0 ? 'No matches.' : `${matches === 1 ? '1 match' : `${matches} matches`} across the file.`;

  return (
    <Modal
      title="Find and replace"
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" onClick={replaceAll} disabled={matches === 0} aria-describedby={countId}>
            Replace all
          </Button>
        </>
      }
    >
      <div className="dc-find-replace">
        <label className="dc-field">
          <span>Find</span>
          <input ref={findInput} type="text" value={find} onChange={(event) => setFind(event.target.value)} onKeyDown={onKeyDown} />
        </label>
        <label className="dc-field">
          <span>Replace with</span>
          <input type="text" value={replace} onChange={(event) => setReplace(event.target.value)} onKeyDown={onKeyDown} />
        </label>
        <div className="dc-export-checks">
          <label className="dc-check">
            <input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} />
            <span>Match case</span>
          </label>
          <label className="dc-check">
            <input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} />
            <span>Whole word</span>
          </label>
        </div>
        <p id={countId} className="dc-export-note" aria-live="polite">
          {status}
        </p>
      </div>
    </Modal>
  );
}

/**
 * Owns the dialog's open state and the ⌘⌥F (Ctrl+H) chord. The chord is bound here rather than in the
 * editor's key map so the dialog travels with the toolbar that mounts this host. Never while
 * presenting, and never over another dialog — a modal over a modal is two things asking for Escape.
 */
export function FindReplaceHost() {
  const open = useUiStore((state) => state.findReplaceOpen);
  const setOpen = useUiStore((state) => state.setFindReplaceOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌘⌥F on a Mac — ⌘H is the OS's "Hide" and never reaches the page — and Ctrl+H elsewhere.
      const key = event.key.toLowerCase();
      const mac = event.metaKey && event.altKey && !event.ctrlKey && key === 'f';
      const other = event.ctrlKey && !event.metaKey && !event.altKey && key === 'h';
      if (!mac && !other) return;
      if (isImeKeyEvent(event)) return;
      if (useEditorStore.getState().mode === 'present') return;
      if (window.document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);

  if (!open) return null;
  return <FindReplaceDialog onClose={() => setOpen(false)} />;
}
