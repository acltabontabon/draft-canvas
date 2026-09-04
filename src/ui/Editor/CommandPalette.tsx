import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Preset } from '../../canvas/presets';
import { rank, type RankedEntry } from '../../commands/fuzzy';
import { commandsFor } from '../../commands/registry';
import { frequencyBonus, recentIds, recordUse } from '../../commands/history';
import { JUMP_LIMIT, JUMP_RANK_PENALTY, jumpCommands } from '../../commands/search';
import {
  GROUP_LABELS,
  isStage,
  type Command,
  type CommandOption,
  type CommandStage,
} from '../../commands/types';
import { useCommandContext } from '../../commands/useCommandContext';
import type { DraftNode } from '../../document/types';
import { useHints } from '../../learning/useHints';
import { MOD_SYMBOL } from '../../lib/platform';
import type { FlowPlaybackController } from '../../presentation/useFlowPlayback';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Icon } from '../common/Icon';

interface CommandPaletteProps {
  createAt: (preset: Preset, position: { x: number; y: number }) => DraftNode;
  createAtPointer: (preset: Preset) => DraftNode;
  playback: FlowPlaybackController;
}

/** How many recently used commands lead an empty palette. */
const RECENT_SHOWN = 5;

/** A row in the list: a top-level command, or one option of a two-step command's stage. */
type Entry = Command | (CommandOption & { group?: undefined });

/**
 * Phase 8 — the ⌘K command surface. One searchable list that adapts to what's selected, so a
 * developer narrating a system can keep talking and keep typing: `serv` adds a service, `conn`
 * connects it, `spot` spotlights it. Deterministic and offline — every row is a thin call onto a
 * store action that already exists (see `commands/registry.ts`); the palette owns nothing but
 * the list, the query, and the highlight.
 *
 * Deliberately not built on `Modal`: a title bar and close button are exactly the chrome a
 * palette shouldn't have. It borrows `Modal`'s conventions instead — a capture-phase Escape
 * that stops before `EditorScreen`'s own Escape cascade, a backdrop that closes on pointer-down,
 * `role="dialog"` — and `FlowSwitcher`'s keyboard mechanics (a ref for the highlight so the
 * listener is registered once per open, not once per keystroke).
 */
export function CommandPalette({ createAt, createAtPointer, playback }: CommandPaletteProps) {
  const open = useUiStore((state) => state.commandPaletteOpen);
  const setOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const setFlowSwitcherOpen = useUiStore((state) => state.setFlowSwitcherOpen);
  const setQuickConnect = useUiStore((state) => state.setQuickConnect);
  const learnModeActive = useUiStore((state) => state.learnModeActive);
  // Reactive slices only so an open palette re-lists as the world changes underneath it — the
  // rest of the store is read live at call time via `getState()` inside `buildContext`.
  const mode = useEditorStore((state) => state.mode);
  const selection = useEditorStore((state) => state.selection);
  const document = useEditorStore((state) => state.document);
  const focus = useEditorStore((state) => state.focus);
  const flowPlayback = useEditorStore((state) => state.flowPlayback);
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  const { retire: retireHint } = useHints();
  const buildContext = useCommandContext({ createAt, createAtPointer, playback });

  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<CommandStage | null>(null);
  // The top-level command that opened the current stage — what history records once one of its
  // options actually runs, so "Connect to… → Ledger" counts as one use of "Connect to…".
  const [stageRoot, setStageRoot] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const highlightRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The list, re-derived whenever the query, the stage, or any reactive slice above changes.
  // `commandsFor` is pure and a few dozen entries long — cheaper to rebuild than to cache.
  const rows = useMemo<RankedEntry<Entry>[]>(() => {
    if (!open) return [];
    if (stage) return rank(query, stage.options);
    const commands = commandsFor(buildContext());
    if (!query.trim()) {
      // Browsing: the last few commands that still apply lead, then everything in its group.
      // The same command listed twice is deliberate — "Recent" is a shortcut, not a move.
      const byId = new Map(commands.map((command) => [command.id, command]));
      const recent: Entry[] = recentIds()
        .map((id) => byId.get(id))
        .filter((command): command is Command => command !== undefined)
        .slice(0, RECENT_SHOWN)
        .map((command) => ({ ...command, group: 'recent' as const }));
      return rank('', [...recent, ...commands]);
    }
    // Searching: named elements answer a typed query too, ranked alongside commands (slightly
    // handicapped, see `JUMP_RANK_PENALTY`) and capped so a big canvas never floods the list.
    // Frequently used commands get a small nudge — never enough to beat a better text match.
    const isJump = (entry: Entry) => 'group' in entry && entry.group === 'jump';
    const ranked = rank(query, [...commands, ...(jumpCommands(document) as Entry[])], (entry) =>
      isJump(entry) ? -JUMP_RANK_PENALTY : frequencyBonus(entry.id),
    );
    let jumps = 0;
    return ranked.filter((row) => !isJump(row.entry) || jumps++ < JUMP_LIMIT);
    // The reactive slices are what make this recompute; they aren't read here directly.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stage, query, buildContext, mode, selection, document, focus, flowPlayback, selectedFlowId, learnModeActive]);

  // Fresh start every time it opens; and nothing else may keep competing for the keyboard.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setStage(null);
    setStageRoot(null);
    setHighlight(0);
    setFlowSwitcherOpen(false);
    setQuickConnect(null);
    // Synchronous, not deferred to a frame: a backgrounded tab may not paint a frame for a
    // while, and the first keystroke must land in this input, not on the canvas behind it.
    inputRef.current?.focus();
    // Opening it once is the whole lesson (Phase 7.2) — the "press ⌘K" hint has nothing left to say.
    retireHint('command-palette');
  }, [open, retireHint, setFlowSwitcherOpen, setQuickConnect]);

  useEffect(() => {
    highlightRef.current = highlight;
  }, [highlight]);

  // Keep the highlight on a real row when the list shrinks underneath it.
  useEffect(() => {
    setHighlight((index) => Math.min(index, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    // Optional call: jsdom has no scrollIntoView.
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight, rows]);

  const run = useCallback(
    (entry: Entry) => {
      const ctx = buildContext();
      const root = stageRootRef.current ?? entry.id;
      // Close first: a command that opens another dialog must not end up underneath this one,
      // and a command that throws must never leave the overlay stuck open.
      setOpen(false);
      let result: void | CommandStage;
      try {
        result = entry.run(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : 'That command failed.', 'error');
        return;
      }
      if (isStage(result)) {
        // Same event, so React batches this with the close above: the palette never blinks —
        // it just swaps its list for the stage's options and shows the breadcrumb.
        setStage(result);
        setStageRoot(root);
        setQuery('');
        setHighlight(0);
        setOpen(true);
        return;
      }
      // Only a real command earns a place in history — a jump target is a place, not an action.
      if (!root.startsWith('jump-')) recordUse(root);
    },
    [buildContext, setOpen],
  );

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const stageRootRef = useRef(stageRoot);
  stageRootRef.current = stageRoot;
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          if (stageRef.current) {
            setStage(null);
            setStageRoot(null);
            setQuery('');
            setHighlight(0);
          } else {
            setOpen(false);
          }
          return;
        case 'ArrowDown':
          event.preventDefault();
          event.stopPropagation();
          setHighlight((index) => Math.min(rowsRef.current.length - 1, index + 1));
          return;
        case 'ArrowUp':
          event.preventDefault();
          event.stopPropagation();
          setHighlight((index) => Math.max(0, index - 1));
          return;
        case 'Home':
        case 'End':
          if (queryRef.current) return; // let the input move its caret
          event.preventDefault();
          setHighlight(event.key === 'Home' ? 0 : Math.max(0, rowsRef.current.length - 1));
          return;
        case 'Enter': {
          event.preventDefault();
          event.stopPropagation();
          const row = rowsRef.current[highlightRef.current];
          if (row) run(row.entry);
          return;
        }
        case 'Backspace':
          // An empty query inside a stage: step back out of it, like a breadcrumb.
          if (stageRef.current && !queryRef.current) {
            event.preventDefault();
            event.stopPropagation();
            setStage(null);
            setStageRoot(null);
            setHighlight(0);
          }
          return;
        case 'Tab':
          event.preventDefault();
          event.stopPropagation();
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, run, setOpen]);

  if (!open) return null;

  const searching = query.trim().length > 0;
  const placeholder = stage
    ? 'Filter…'
    : mode === 'present'
      ? 'Next step, previous step, exit…'
      : 'Type a command, or a name to jump to…';

  return (
    <div className="dc-palette-backdrop" onPointerDown={() => setOpen(false)}>
      <div
        className="dc-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="dc-palette-input">
          <Icon name="search" size={16} className="dc-palette-input-icon" />
          {stage && <span className="dc-palette-stage">{stage.prompt}</span>}
          <input
            ref={inputRef}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- a palette exists to be typed into
            autoFocus
            type="text"
            value={query}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            aria-label={stage ? stage.prompt : 'Search commands'}
            aria-controls="dc-palette-list"
            aria-activedescendant={rows[highlight] ? `dc-palette-row-${highlight}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
          />
        </div>

        <div id="dc-palette-list" ref={listRef} className="dc-palette-list" role="listbox">
          {rows.length === 0 && (
            <div className="dc-palette-empty">
              {stage ? 'Nothing matches.' : 'No matching commands.'}
            </div>
          )}
          {rows.map(({ entry, indices }, index) => {
            const group = 'group' in entry ? entry.group : undefined;
            const previous = rows[index - 1]?.entry;
            const previousGroup = previous && 'group' in previous ? previous.group : undefined;
            const showHeader = !searching && group !== undefined && group !== previousGroup;
            return (
              <div key={`${group ?? 'stage'}:${entry.id}`} className="dc-palette-section">
                {showHeader && (
                  <div className="dc-palette-group" aria-hidden="true">
                    {GROUP_LABELS[group]}
                  </div>
                )}
                <div
                  id={`dc-palette-row-${index}`}
                  role="option"
                  aria-selected={index === highlight}
                  className="dc-palette-row"
                  onPointerMove={() => {
                    if (highlightRef.current !== index) setHighlight(index);
                  }}
                  onClick={() => run(entry)}
                >
                  <span className="dc-palette-title">{highlightTitle(entry.title, indices)}</span>
                  {entry.hint && <span className="dc-palette-hint">{entry.hint}</span>}
                  {searching && group && (
                    <span className="dc-palette-tag">{GROUP_LABELS[group]}</span>
                  )}
                  {entry.shortcut && (
                    <span className="dc-palette-kbd">
                      {entry.shortcut.split(' ').map((key, i) => (
                        <kbd key={`${key}-${i}`}>{key}</kbd>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="dc-palette-footer" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>esc</kbd> {stage ? 'back' : 'close'}
          </span>
          <span className="dc-palette-footer-spacer" />
          <span>
            <kbd>{MOD_SYMBOL}</kbd>
            <kbd>K</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Wraps each fuzzy-matched character in `<mark>`, merging neighbours into one run. */
function highlightTitle(title: string, indices: number[]) {
  if (indices.length === 0) return title;
  const marked = new Set(indices);
  const parts: ReactNode[] = [];
  let run = '';
  let runMarked = false;
  const flush = () => {
    if (!run) return;
    parts.push(runMarked ? <mark key={parts.length}>{run}</mark> : run);
    run = '';
  };
  for (let i = 0; i < title.length; i += 1) {
    const isMarked = marked.has(i);
    if (isMarked !== runMarked) {
      flush();
      runMarked = isMarked;
    }
    run += title[i];
  }
  flush();
  return parts;
}
