import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Attachment } from '../document/types';
import { NOTE_ACCENTS, NOTE_LABELS } from '../nodes/describe';
import { LANGUAGE_LABELS, tokenizeCode } from '../render/code/highlight';
import { CODE_THEMES, colorForScope } from '../render/code/theme';
import { accentOf, type Theme } from '../render/theme/tokens';
import { useUiStore } from '../store/uiStore';
import { useTheme, useThemeValue } from '../ui/theme/useTheme';
import { Icon } from '../ui/common/Icon';

/** Must match the `dc-attachment-card-in`/`-out` keyframe duration in `canvas.css` — the card
 *  stays mounted this long after `visible` goes false so the CSS fade-out has time to play
 *  instead of the DOM node just vanishing mid-animation. */
export const ATTACHMENT_CARD_EXIT_MS = 120;

/**
 * Read-only, syntax-highlighted code — the same `tokenizeCode`/`colorForScope` primitives
 * `FlowBar.tsx`'s `DetailPanel` uses for a connection's legacy `details` field during playback,
 * reused here rather than duplicated. Not imported from there directly: `ui/Editor/FlowBar.tsx`
 * sits above `canvas/` in this app's one-way dependency order, so this is its own small instance
 * of the same pattern, not a shared component.
 */
function ReadOnlyCode({ language, code }: { language: Parameters<typeof tokenizeCode>[1]; code: string }) {
  const { name } = useTheme();
  const codeTheme = CODE_THEMES[name];
  const lines = tokenizeCode(code, language);
  return (
    <pre className="dc-attachment-code">
      <code>
        {lines.map((line, index) => (
          <span className="dc-code-line" key={index}>
            {line.length === 0
              ? '\n'
              : line.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={{ color: colorForScope(codeTheme, token.scope) }}>
                    {token.text}
                  </span>
                ))}
            {line.length > 0 && '\n'}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** What a chip/card looks like for one attachment — matches the corresponding card type's own
 *  real styling exactly (`nodes/describe.ts`'s `note`/`codeCard`), rather than a generic box, so
 *  a Note attachment reads as a note and a Code one reads as code. */
interface AttachmentLook {
  fill: string;
  border: string;
  accent: string;
  headerBg?: string;
  label: string;
}

function attachmentLookFor(theme: Theme, attachment: Attachment): AttachmentLook {
  if (attachment.type === 'code') {
    const language = attachment.language ?? 'plaintext';
    return {
      fill: theme.codeBg,
      border: theme.codeBorder,
      accent: theme.textFaint,
      headerBg: theme.surfaceRaised,
      label: LANGUAGE_LABELS[language],
    };
  }
  const kind = attachment.noteKind ?? 'note';
  const palette = accentOf(theme, attachment.accent ?? NOTE_ACCENTS[kind]);
  return { fill: palette.fill, border: palette.line, accent: palette.chip, label: NOTE_LABELS[kind] };
}

/** The mutations a chip/card can perform on its own attachment, injected by the caller so this
 *  module stays host-agnostic — `DraftEdgeView.tsx` binds these to `updateEdgeAttachment`/
 *  `removeEdgeAttachment`/etc., the node attachment popover binds them to the node-hosted
 *  equivalents. `detach`/`reorder` stay optional even though both hosts provide them today: a
 *  caller that omits either simply doesn't get that action rendered, which keeps this module
 *  usable for a future host that might not have a sensible "detach"/"reorder" concept. */
export interface AttachmentActions {
  update: (attachmentId: string, patch: Partial<Omit<Attachment, 'id'>>) => void;
  remove: (attachmentId: string) => void;
  detach?: (attachmentId: string) => void;
  reorder?: (attachmentId: string, direction: -1 | 1) => void;
}

/**
 * The row of small chips floating beside its host — one chip per attachment, each independently
 * clickable, so several attachments sit side by side rather than competing for one card. Host-
 * agnostic: an edge positions this row itself (via `style`, anchored to its label point) and picks
 * `cardSide` from `attachmentRowBelowsSourceOrTarget`; a node's attachment popover instead lets the
 * row flow inside its own already-positioned panel (no `style` needed) and picks `cardSide` from
 * whichever side the panel itself resolved to.
 */
export function AttachmentChipRow({
  hostKind,
  hostId,
  attachments,
  cardSide,
  editable,
  actions,
  style,
}: {
  hostKind: 'node' | 'edge';
  hostId: string;
  attachments: Attachment[];
  cardSide: 'above' | 'below';
  editable: boolean;
  actions: AttachmentActions;
  style?: CSSProperties;
}) {
  if (!attachments.length) return null;
  return (
    <div
      className="dc-attachment-chip-row"
      data-flip={cardSide === 'below' ? 'below' : undefined}
      style={style}
    >
      {attachments.map((attachment, index) => (
        <AttachmentChip
          key={attachment.id}
          hostKind={hostKind}
          hostId={hostId}
          attachment={attachment}
          editable={editable}
          actions={actions}
          canMoveUp={index > 0}
          canMoveDown={index < attachments.length - 1}
        />
      ))}
    </div>
  );
}

/**
 * One attachment's chip and its own floating card. The card is a plain CSS-positioned child of
 * the chip (not placed via flow coordinates like the row itself) — `top`/`bottom` off the chip's
 * own box, flipped by `.dc-attachment-chip-row[data-flip]` in `canvas.css` — which is what keeps
 * every card opening away from the row's own anchor regardless of how many chips sit beside it.
 *
 * Visible when `pinned || revealed` — a deliberate, purely per-attachment click reveal, not hover
 * and not selection: a card popping open just from resting the pointer nearby (or from every
 * attachment on the host showing at once just because the host itself got selected) read as noisy
 * on a diagram with several attachments. Each chip is independently keyboard-reachable
 * (`role="button" tabIndex={0}`, Enter/Space activates it) so dropping the old selection-reveals-
 * everything shortcut doesn't cost keyboard access. Pinning (`uiStore`'s `openAttachmentDetail`,
 * naming the host, its kind, and this specific attachment) is the only state that enables editing
 * — and even then, only once the pencil glyph is clicked (see `editing`, below); opening a card
 * first always shows it read-only, only when `editable` (i.e. not presenting) does the pencil
 * glyph appear at all. Presenting an edge attachment instead sets `presentationReveal`, always
 * read-only, cleared automatically on the next step — node attachments don't participate in
 * presentation reveal at all (there is no analogous "current step" for a node), so `revealed` is
 * always false for `hostKind === 'node'`.
 */
export function AttachmentChip({
  hostKind,
  hostId,
  attachment,
  editable,
  actions,
  canMoveUp,
  canMoveDown,
}: {
  hostKind: 'node' | 'edge';
  hostId: string;
  attachment: Attachment;
  editable: boolean;
  actions: AttachmentActions;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  const theme = useThemeValue();
  const look = attachmentLookFor(theme, attachment);
  const pinned = useUiStore(
    (state) =>
      state.openAttachmentDetail?.hostKind === hostKind &&
      state.openAttachmentDetail?.hostId === hostId &&
      state.openAttachmentDetail?.attachmentId === attachment.id,
  );
  const revealed = useUiStore(
    (state) =>
      hostKind === 'edge' &&
      state.presentationReveal?.edgeId === hostId &&
      state.presentationReveal?.attachmentId === attachment.id,
  );
  const setOpenAttachmentDetail = useUiStore((state) => state.setOpenAttachmentDetail);
  const setPresentationReveal = useUiStore((state) => state.setPresentationReveal);

  // Spans the whole chip (icon, label, and — once open — the card itself),
  // not just the card: see the outside-pointerdown effect below for why.
  const chipRef = useRef<HTMLDivElement>(null);

  // The textarea is uncontrolled (`defaultValue`) for smooth typing, but its live value must
  // survive whatever closes the card — Escape, a click anywhere outside, or the chip itself.
  // None of those reliably fire the textarea's own `blur` before React unmounts it: verified in
  // the browser that both Escape and an outside click discarded an in-progress edit, because the
  // state update that closes the card and the DOM removal happen before any native blur/focusout
  // has a chance to reach a still-live listener. So the live value is tracked here in a ref via
  // `onChange` (cheap — updates a ref, not state, no re-render) and committed by this effect on
  // the transition from pinned to not-pinned, regardless of *what* caused it — decoupled entirely
  // from focus/blur timing.
  const pendingValueRef = useRef<string | null>(null);
  const wasPinned = useRef(pinned);
  useEffect(() => {
    if (wasPinned.current && !pinned) {
      const pending = pendingValueRef.current;
      if (pending !== null) {
        const field = attachment.type === 'code' ? 'code' : 'text';
        const current = attachment.type === 'code' ? attachment.code ?? '' : attachment.text ?? '';
        if (pending !== current) actions.update(attachment.id, { [field]: pending });
      }
      pendingValueRef.current = null;
    }
    wasPinned.current = pinned;
  }, [pinned, attachment, actions]);

  // A click on the chip reveals the card read-only first — the earlier "click opens straight into
  // an editable textarea, cursor already blinking" behavior read as the card silently rewriting
  // itself out from under a click that was only meant to view it. Editing is now a deliberate
  // second step (the pencil glyph in the header), and always resets shut the moment the card
  // itself closes, so re-opening a pinned attachment never resumes mid-edit by surprise.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!pinned) setEditing(false);
  }, [pinned]);

  // Same precedent as the node attachment popover: a capture-phase Escape (so it preempts
  // `EditorScreen`'s own bubble-phase chain), plus a click anywhere outside the chip closes it —
  // registered a tick late so the very click that opened the card doesn't immediately close it.
  // Covers both edit-mode pinning and a presenter's own reveal — whichever is active.
  //
  // Checked against the *whole chip* (`chipRef`), not just the card: a pointerdown on the chip's
  // own icon/label is "outside the card" too, so checking only the card used to close it here on
  // `pointerdown` — then the chip's own `onClick` (which fires after, on `pointerup`) reopened it
  // a moment later using its `pinned` closure from *before* this handler's update landed, netting
  // a no-op. Re-clicking the chip to close it is `onClick`'s job alone; this handler only needs to
  // catch a click genuinely outside the chip altogether (the pane, another chip, and so on).
  useEffect(() => {
    if (!pinned && !revealed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (pinned) setOpenAttachmentDetail(null);
      if (revealed) setPresentationReveal(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (chipRef.current && !chipRef.current.contains(event.target as Node)) {
        if (pinned) setOpenAttachmentDetail(null);
        if (revealed) setPresentationReveal(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [pinned, revealed, setOpenAttachmentDetail, setPresentationReveal]);

  const visible = pinned || revealed;
  const kind = attachment.type === 'code' ? 'code' : 'note';

  // The card's own reveal animation is a CSS `animation` on mount, but hiding it is not the
  // mirror image of that: React would otherwise remove the DOM node the instant `visible` goes
  // false, cutting off any fade-out mid-frame. So the node stays mounted for one more tick,
  // marked `data-closing`, so `canvas.css` can play the reverse animation before it's gone.
  const [cardMounted, setCardMounted] = useState(visible);
  const [cardClosing, setCardClosing] = useState(false);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    if (visible) {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setCardClosing(false);
      setCardMounted(true);
      return;
    }
    if (!cardMounted) return;
    setCardClosing(true);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    hideTimer.current = window.setTimeout(
      () => {
        setCardMounted(false);
        setCardClosing(false);
        hideTimer.current = null;
      },
      reduceMotion ? 0 : ATTACHMENT_CARD_EXIT_MS,
    );
    return () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
    // cardMounted intentionally excluded: it's only ever flipped by this effect's own timeout, so
    // reacting to it here would just re-run the same branch redundantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const togglePin = () => {
    // Not presenting: a click pins the card open for editing — the existing
    // edit-mode behavior, unchanged.
    if (editable) {
      setOpenAttachmentDetail(pinned ? null : { hostKind, hostId, attachmentId: attachment.id });
      return;
    }
    // Presenting: only an edge attachment participates in presentation reveal (see the
    // component doc comment) — a click intentionally reveals the card read-only instead, the
    // presenter's own call on when extra context is useful, not an automatic reveal.
    // Auto-collapses on the next step change (`FlowBar.tsx`), never unlocks the textarea below
    // (that stays gated on `pinned`, which presentation never sets).
    if (hostKind === 'edge') setPresentationReveal(revealed ? null : { edgeId: hostId, attachmentId: attachment.id });
  };

  const chipVars = {
    ['--dc-chip-fill']: look.fill,
    ['--dc-chip-border']: look.border,
    ['--dc-chip-accent']: look.accent,
  } as CSSProperties;

  return (
    <div
      ref={chipRef}
      className="dc-attachment-chip"
      data-kind={kind}
      // Suppresses the chip's own hover-pop while its card is showing — the card is a DOM child of
      // this chip, so without this, the chip's `:hover` scale (which reverts the instant the
      // pointer leaves, ~90ms) and the card's own open/close fade (a separate 120ms animation) run
      // as two independent, unsynchronized transforms on nested elements — the chip visibly
      // "un-pops" while the card is still lingering open, then the card fades out separately on its
      // own schedule. Reads as one unexplained extra zoom. See
      // `.dc-attachment-chip:hover:not([data-open])` in `canvas.css`.
      data-open={cardMounted ? 'true' : undefined}
      role="button"
      tabIndex={0}
      title={
        pinned || revealed
          ? 'Close attached detail'
          : kind === 'code'
            ? 'View attached code'
            : 'View attached note'
      }
      // Set explicitly rather than left to default content-based computation: the card (with its
      // own, possibly lengthy, note/code content) is a DOM child of this chip for simple
      // CSS-relative positioning, and without this, that content would bleed into the chip's own
      // accessible name whenever it's open.
      aria-label={
        pinned || revealed
          ? 'Close attached detail'
          : kind === 'code'
            ? 'View attached code'
            : 'View attached note'
      }
      style={chipVars}
      onClick={(event) => {
        // The card (edit/delete glyphs, textarea) is a DOM child of this chip, so a click anywhere
        // inside it bubbles up here too — only clicks that did *not* originate inside the card
        // should toggle pin. Checking the card specifically (not `target === currentTarget`)
        // matters: a real click on the chip's own icon/label spans also has to work, and those
        // are non-card descendants of this same div. Still stopping propagation either way: without
        // it, a click on the edit/delete glyph kept bubbling past this handler's early return and
        // selected the underlying host, popping its own selection popover open behind the card
        // that was just opened to look at (or edit) one attachment.
        if ((event.target as HTMLElement).closest('.dc-attachment-card')) {
          event.stopPropagation();
          return;
        }
        event.stopPropagation();
        togglePin();
      }}
      onKeyDown={(event) => {
        // Same reasoning as onClick above: without this guard, typing a space inside the card's
        // own textarea bubbles up and re-triggers this handler, closing the card mid-edit and
        // swallowing the keystroke — caught by an e2e test typing through a real space character.
        if ((event.target as HTMLElement).closest('.dc-attachment-card')) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        togglePin();
      }}
    >
      <span className="dc-attachment-chip-icon" aria-hidden="true">
        {kind === 'code' ? '{ }' : ''}
      </span>
      <span className="dc-attachment-chip-label">{look.label}</span>

      {cardMounted && (
        <div
          className="dc-attachment-card"
          data-pinned={pinned ? 'true' : undefined}
          data-closing={cardClosing ? 'true' : undefined}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {/* The reveal animation lives on this inner wrapper, not the positioned outer div —
              a CSS animation replaces the whole `transform` property for its duration, so
              animating scale here would otherwise clobber the outer div's own translate. */}
          <div className="dc-attachment-card-inner" data-kind={kind} style={chipVars}>
            <header
              className="dc-attachment-card-header"
              style={look.headerBg ? { background: look.headerBg } : undefined}
            >
              <span>{look.label}</span>
              {pinned && (
                <span className="dc-attachment-card-actions">
                  {!editing && editable && (
                    <button
                      type="button"
                      className="dc-attachment-card-action"
                      aria-label="Edit attached detail"
                      title="Edit"
                      onClick={() => setEditing(true)}
                    >
                      <Icon name="pencil" size={13} />
                    </button>
                  )}
                  {actions.reorder && (
                    <>
                      <button
                        type="button"
                        className="dc-attachment-card-action"
                        aria-label="Move attachment up"
                        title="Move up"
                        disabled={!canMoveUp}
                        onClick={() => actions.reorder?.(attachment.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="dc-attachment-card-action"
                        aria-label="Move attachment down"
                        title="Move down"
                        disabled={!canMoveDown}
                        onClick={() => actions.reorder?.(attachment.id, 1)}
                      >
                        ↓
                      </button>
                    </>
                  )}
                  {actions.detach && (
                    <button
                      type="button"
                      className="dc-attachment-card-action"
                      aria-label="Detach onto the canvas"
                      title="Detach onto the canvas"
                      onClick={() => {
                        actions.detach?.(attachment.id);
                        setOpenAttachmentDetail(null);
                      }}
                    >
                      Detach
                    </button>
                  )}
                  <button
                    type="button"
                    className="dc-attachment-card-action"
                    aria-label="Delete attached detail"
                    title="Delete"
                    onClick={() => {
                      actions.remove(attachment.id);
                      setOpenAttachmentDetail(null);
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              )}
            </header>
            {pinned && editing ? (
              attachment.type === 'code' ? (
                <textarea
                  autoFocus
                  className="dc-attachment-editor dc-attachment-editor-code"
                  spellCheck={false}
                  defaultValue={attachment.code ?? ''}
                  onChange={(event) => {
                    pendingValueRef.current = event.currentTarget.value;
                  }}
                  // Without this, a keystroke here bubbles all the way up to React Flow's own
                  // per-edge/per-node keydown handling — Enter/Space there can mean "select this
                  // host", popping the host's own selection popover open behind the card the user
                  // is mid-edit on.
                  onKeyDown={(event) => event.stopPropagation()}
                />
              ) : (
                <textarea
                  autoFocus
                  className="dc-attachment-editor"
                  defaultValue={attachment.text ?? ''}
                  onChange={(event) => {
                    pendingValueRef.current = event.currentTarget.value;
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                />
              )
            ) : attachment.type === 'code' ? (
              <ReadOnlyCode language={attachment.language ?? 'plaintext'} code={attachment.code ?? ''} />
            ) : (
              <div className="dc-attachment-note">{attachment.text || 'Empty note'}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
