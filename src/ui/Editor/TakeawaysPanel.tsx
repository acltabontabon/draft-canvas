import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CommandContext } from '../../commands/types';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { count } from '../../lib/plural';
import { motionMs } from '../../lib/motion';
import type { FlowPlaybackController } from '../../presentation/useFlowPlayback';
import { fileOf, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import type { DraftAction } from '../../document/types';
import {
  indexFile,
  isEmpty,
  resolveTarget,
  takeawaysFor,
  type TakeawayNote,
  type TakeawayTarget,
  type Takeaways,
} from '../../takeaways/collect';
import { takeawaysMarkdown } from '../../takeaways/markdown';
import { CAPTURE_ACTION_KEY, captureAnchorFor } from '../../takeaways/capture';
import { usePopoverPresence } from '../../canvas/usePopoverPresence';
import { navigateToElement } from './depthNavigation';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';

/**
 * Takeaways — what came out of the discussion, and the one-line capture that puts things into it.
 *
 * Anchored to the bottom-right with its bottom edge flush against the status bar, because it is
 * meant to read as that bar having grown rather than a panel that arrived: the count in the bar
 * is what opens it, and this is where that count expands to. Bottom-right is also the only corner
 * free in every mode — the depth map owns top-left, Flows and the present-mode exit share
 * top-right, and the inspector strip and the flow bar share bottom-centre.
 *
 * Two faces, one surface (`uiStore.takeawaysView`). `actions` is the working list you add to
 * during a meeting; `readout` is everything the meeting produced — decisions and open questions
 * included, read straight off the notes already on the canvas — for the end of it. A third panel
 * for the summary would have been a second place to look for the same information.
 *
 * The capture line is deliberately independent of whether the panel is open, and is the one piece
 * of chrome here allowed on screen while presenting. Somebody asking "can we verify this?"
 * mid-walkthrough should cost one key, six words and Enter — not a detour out of the flow.
 */

const EXIT_MS = 140;

interface TakeawaysPanelProps {
  playback: FlowPlaybackController;
  buildCommandContext: () => CommandContext;
}

export function TakeawaysPanel({ playback, buildCommandContext }: TakeawaysPanelProps) {
  const open = useUiStore((state) => state.takeawaysOpen);
  const capturing = useUiStore((state) => state.actionCaptureOpen);
  const presenting = useEditorStore((state) => state.mode === 'present');
  // Presentation shows the capture line and nothing else: the canvas carries the story, and a
  // list of chores over the top of it is exactly the kind of chrome present mode exists without.
  const showPanel = open && !presenting;
  const { mounted, closing } = usePopoverPresence(showPanel || capturing, EXIT_MS);

  if (!mounted) return null;
  return (
    <div
      className="dc-takeaways"
      data-mode={showPanel ? 'panel' : 'line'}
      data-presenting={presenting || undefined}
      data-closing={closing || undefined}
      // Bare keys are shape shortcuts on the canvas; inside here they are letters being typed, or
      // list navigation. Same opt-in the Learn drawer and the Flows panel use.
      data-dc-keyboard-region=""
      role={showPanel ? 'complementary' : 'group'}
      aria-label="Takeaways"
    >
      {showPanel && <TakeawaysHeader />}
      {capturing && <CaptureLine playback={playback} />}
      {showPanel && <TakeawaysBody buildCommandContext={buildCommandContext} />}
    </div>
  );
}

function TakeawaysHeader() {
  const view = useUiStore((state) => state.takeawaysView);
  return (
    <div className="dc-takeaways-header">
      <strong className="dc-takeaways-title">Takeaways</strong>
      {view === 'readout' && (
        <Button variant="quiet" onClick={() => useUiStore.getState().setTakeawaysView('actions')}>
          Back to actions
        </Button>
      )}
      <Button
        variant="quiet"
        icon="close"
        aria-label="Close takeaways"
        onClick={() => useUiStore.getState().setTakeawaysOpen(false)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ capture -- */

/**
 * One line, one Enter.
 *
 * The context it will keep is worked out once, when the line opens, and shown as a chip — so what
 * the action is about to remember is visible before it is committed rather than discovered in the
 * list afterwards. Backspace on an empty line drops that chip, which is the standard gesture for
 * removing a token from an input and is the one keystroke way to say "this one belongs to the
 * whole canvas".
 */
function CaptureLine({ playback }: { playback: FlowPlaybackController }) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Resolved once, on open: the selection can change underneath a line that is still being typed
  // into (a click on the canvas), and an action that silently re-aimed itself while you were
  // writing it would be worse than one that kept nothing at all.
  const [anchor, setAnchor] = useState<DraftAction['anchor'] | undefined>(() => {
    const editor = useEditorStore.getState();
    const current = playback.active ? playback.current : null;
    return captureAnchorFor({
      presenting: editor.mode === 'present',
      selection: editor.selection,
      stepEdgeId: current?.edge?.id,
      stepNodeId: current?.extraNodes[0]?.id,
    });
  });

  const context = useMemo(() => {
    if (!anchor) return undefined;
    const file = fileOf(useEditorStore.getState());
    return resolveTarget(indexFile(file), anchor.kind, anchor.id);
  }, [anchor]);

  const close = useCallback(() => useUiStore.getState().setActionCaptureOpen(false), []);

  const commit = useCallback(
    (keepOpen: boolean) => {
      const captured = useEditorStore.getState().captureAction(text, anchor);
      if (!captured && text.trim()) {
        // The only way this fails with real text in it is the cap, and silently dropping what
        // somebody just said out loud is the one thing this list must never do.
        useUiStore.getState().notify('This canvas is holding as many actions as it can.', 'error');
        return;
      }
      if (keepOpen) {
        setText('');
        inputRef.current?.focus();
        return;
      }
      close();
    },
    [text, anchor, close],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyEvent(event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      // Shift+Enter keeps the line up for the next one: people rarely say only one thing, and
      // reopening between them is the difference between keeping up and falling behind.
      commit(event.shiftKey);
      return;
    }
    if (event.key === 'Escape') {
      // Stopped here so the editor's own Escape cascade doesn't also exit presenting or drop the
      // selection behind this — closing the line is the whole of what this Escape means.
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Backspace' && text === '' && anchor) {
      event.preventDefault();
      setAnchor(undefined);
    }
  };

  return (
    <div className="dc-takeaways-capture">
      <span className="dc-takeaways-box" aria-hidden="true" />
      <input
        ref={inputRef}
        className="dc-takeaways-input"
        autoFocus
        value={text}
        placeholder="What needs to happen?"
        aria-label="Capture an action"
        aria-describedby={context ? 'dc-capture-context' : undefined}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        // An empty line that lost focus has nothing to lose, so it gets out of the way. One with
        // text in it stays: dropping what somebody typed because they clicked the canvas would
        // be the same failure as the cap above, arrived at differently.
        onBlur={() => {
          if (text.trim() === '') close();
        }}
      />
      {context && (
        <span className="dc-takeaways-chip" id="dc-capture-context" title={`Remembered with this action — Backspace on an empty line drops it`}>
          <span className="dc-takeaways-chip-arrow" aria-hidden="true">
            ↳
          </span>
          {context.label}
        </span>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- body -- */

function TakeawaysBody({ buildCommandContext }: { buildCommandContext: () => CommandContext }) {
  const view = useUiStore((state) => state.takeawaysView);
  // Re-derived whenever the document changes, which is what makes the decisions half of this
  // true of a canvas drawn long before any of it existed.
  const revision = useEditorStore((state) => state.revision);
  const takeaways = useMemo(() => {
    void revision;
    return takeawaysFor(fileOf(useEditorStore.getState()));
  }, [revision]);

  const goTo = useCallback(
    (target: TakeawayTarget) => {
      void navigateToElement(target, buildCommandContext);
    },
    [buildCommandContext],
  );

  return view === 'readout' ? (
    <Readout takeaways={takeaways} goTo={goTo} />
  ) : (
    <ActionList takeaways={takeaways} goTo={goTo} />
  );
}

/** `@Kevin` lifted out of the sentence it sits in, wherever that is. */
function MentionText({ text }: { text: string }) {
  // Display-time only — the document keeps the sentence exactly as it was typed, which is what
  // makes the text that gets copied, exported and saved the text somebody actually wrote.
  const parts = text.split(/(@[\p{L}\p{N}][\p{L}\p{N}._-]*)/gu);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('@') && part.length > 1 ? (
          <span key={index} className="dc-mention">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function ContextLine({ target, onGo }: { target: TakeawayTarget; onGo: () => void }) {
  return (
    // Named for what it does, not just for what it shows: the visible text is "↳ Payment Service",
    // which on its own reads as a label rather than as somewhere you can go.
    <button
      type="button"
      className="dc-takeaways-context"
      onClick={onGo}
      aria-label={`Go to ${target.label}`}
      title={`Go to ${target.label}`}
    >
      <span className="dc-takeaways-chip-arrow" aria-hidden="true">
        ↳
      </span>
      <span className="dc-takeaways-context-label">{target.label}</span>
      {target.room && <span className="dc-takeaways-room">{target.room}</span>}
    </button>
  );
}

function ActionRow({ entry, goTo }: { entry: Takeaways['actions'][number]; goTo: (target: TakeawayTarget) => void }) {
  const { action, context } = entry;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(action.text);

  const commit = (value: string) => {
    setEditing(false);
    useEditorStore.getState().updateActionText(action.id, value);
  };

  return (
    <li className="dc-takeaways-row" data-done={action.done || undefined}>
      <div className="dc-takeaways-line">
        {/* The box carries the action as its accessible name — "Confirm timeout, checkbox, not
            checked" — so the row's one meaningful control says the whole thing. The text beside it
            is an edit affordance, named for what it does *and* for what it shows (WCAG's
            label-in-name), rather than repeating the sentence as a second bare label. */}
        <button
          type="button"
          role="checkbox"
          aria-checked={Boolean(action.done)}
          aria-label={action.text}
          className="dc-takeaways-box"
          onClick={() => useEditorStore.getState().setActionDone(action.id, !action.done)}
        >
          {action.done && <Icon name="check" />}
        </button>
        {editing ? (
          <input
            className="dc-takeaways-input"
            autoFocus
            value={draft}
            aria-label="Edit action"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (isImeKeyEvent(event)) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                commit(draft);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setDraft(action.text);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="dc-takeaways-text"
            aria-label={`Edit “${action.text}”`}
            onClick={() => {
              setDraft(action.text);
              setEditing(true);
            }}
            title="Edit"
          >
            <MentionText text={action.text} />
          </button>
        )}
        <Button
          variant="quiet"
          icon="trash"
          className="dc-takeaways-remove"
          aria-label={`Remove “${action.text}”`}
          onClick={() => useEditorStore.getState().removeAction(action.id)}
        />
      </div>
      {context && <ContextLine target={context} onGo={() => goTo(context)} />}
    </li>
  );
}

function ActionList({ takeaways, goTo }: { takeaways: Takeaways; goTo: (target: TakeawayTarget) => void }) {
  const [showDone, setShowDone] = useState(false);
  const open = takeaways.actions.filter((entry) => !entry.action.done);
  const done = takeaways.actions.filter((entry) => entry.action.done);
  const outcomes = takeaways.decisions.length + takeaways.questions.length;

  return (
    <>
      <div className="dc-takeaways-scroll">
        {open.length === 0 && done.length === 0 ? (
          <p className="dc-takeaways-empty">
            Nothing captured yet. Press <kbd>{CAPTURE_ACTION_KEY}</kbd> to note what needs to happen.
          </p>
        ) : (
          <ul className="dc-takeaways-list">
            {open.map((entry) => (
              <ActionRow key={entry.action.id} entry={entry} goTo={goTo} />
            ))}
          </ul>
        )}

        {done.length > 0 && (
          <div className="dc-takeaways-done">
            <button
              type="button"
              className="dc-takeaways-done-toggle"
              aria-expanded={showDone}
              onClick={() => setShowDone((was) => !was)}
            >
              <Icon name="check" />
              {count(done.length, 'done')}
            </button>
            {showDone && (
              <ul className="dc-takeaways-list">
                {done.map((entry) => (
                  <ActionRow key={entry.action.id} entry={entry} goTo={goTo} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="dc-takeaways-foot">
        {outcomes > 0 ? (
          <button
            type="button"
            className="dc-takeaways-more"
            onClick={() => useUiStore.getState().setTakeawaysView('readout')}
          >
            {[
              takeaways.decisions.length > 0 ? count(takeaways.decisions.length, 'decision') : null,
              takeaways.questions.length > 0 ? count(takeaways.questions.length, 'question') : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            <Icon name="forward" />
          </button>
        ) : (
          <span className="dc-muted dc-takeaways-hint">
            <kbd>{CAPTURE_ACTION_KEY}</kbd> captures another
          </span>
        )}
        {done.length > 0 && (
          <Button variant="quiet" onClick={() => useEditorStore.getState().clearDoneActions()}>
            Clear {done.length}
          </Button>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ readout -- */

function NoteRow({ note, goTo }: { note: TakeawayNote; goTo: (target: TakeawayTarget) => void }) {
  return (
    <li className="dc-takeaways-row" data-kind={note.kind}>
      <button
        type="button"
        className="dc-takeaways-note"
        onClick={() => goTo(note.target)}
        aria-label={`${note.text} — go to ${note.target.label}`}
        title={`Go to ${note.target.label}`}
      >
        <span className="dc-takeaways-glyph" aria-hidden="true">
          {note.kind === 'decision' ? '✓' : '?'}
        </span>
        <span className="dc-takeaways-note-text">
          {note.text}
          {note.target.room && <span className="dc-takeaways-room">{note.target.room}</span>}
        </span>
      </button>
    </li>
  );
}

function Readout({ takeaways, goTo }: { takeaways: Takeaways; goTo: (target: TakeawayTarget) => void }) {
  const title = useEditorStore((state) => state.document.metadata.title);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), motionMs(1400) || 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    const text = takeawaysMarkdown(takeaways, title);
    if (!text) return;
    useEditorStore.getState().copyText(text);
    setCopied(true);
  };

  return (
    <>
      <div className="dc-takeaways-scroll">
        {isEmpty(takeaways) ? (
          <p className="dc-takeaways-empty">Nothing decided, asked or assigned on this canvas yet.</p>
        ) : (
          <>
            <Section title="Decisions" rows={takeaways.decisions} goTo={goTo} />
            <Section title="Open questions" rows={takeaways.questions} goTo={goTo} />
            {takeaways.actions.length > 0 && (
              <section className="dc-takeaways-section">
                <h3 className="dc-takeaways-section-title">Actions</h3>
                <ul className="dc-takeaways-list">
                  {takeaways.actions.map((entry) => (
                    <li key={entry.action.id} className="dc-takeaways-row" data-done={entry.action.done || undefined}>
                      <span className="dc-takeaways-note">
                        <span className="dc-takeaways-glyph" aria-hidden="true">
                          {entry.action.done ? '✓' : '□'}
                        </span>
                        <span className="dc-takeaways-note-text">
                          <MentionText text={entry.action.text} />
                          {entry.context && <span className="dc-takeaways-room">{entry.context.label}</span>}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
      <div className="dc-takeaways-foot">
        <span className="dc-muted dc-takeaways-hint">{copied ? 'Copied as Markdown.' : ''}</span>
        <Button variant="quiet" icon="copy" onClick={copy} disabled={isEmpty(takeaways)}>
          Copy takeaways
        </Button>
      </div>
    </>
  );
}

function Section({ title, rows, goTo }: { title: string; rows: TakeawayNote[]; goTo: (target: TakeawayTarget) => void }) {
  if (rows.length === 0) return null;
  return (
    <section className="dc-takeaways-section">
      <h3 className="dc-takeaways-section-title">{title}</h3>
      <ul className="dc-takeaways-list">
        {rows.map((note) => (
          <NoteRow key={note.id} note={note} goTo={goTo} />
        ))}
      </ul>
    </section>
  );
}
