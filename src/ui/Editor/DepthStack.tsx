import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { Accent, DraftEdge, DraftNode } from '../../document/types';
import { depthMarkAccent } from '../../canvas/insideMark';
import { effectiveLevel, LEVEL_LABELS } from '../../depth/level';
import { hasInside, ownerAt, pathKey } from '../../depth/tree';
import { displayNameFor } from '../../document/factory';
import { libraryShapeOf } from '../../document/shape';
import { accentOf } from '../../render/theme/tokens';
import { fileOf, useEditorStore } from '../../store/editorStore';
import { useThemeValue } from '../theme/useTheme';
import { Fingerprint } from '../Library/Fingerprint';
import { useUiStore } from '../../store/uiStore';
import { backOut, lookInside } from './depthNavigation';

/**
 * Where you are in the architecture — as planes.
 *
 * A shape with an inside stands in front of a faint plane on the canvas. Once you look inside, this
 * corner shows that plane and the ones around it. At rest it is a small stack and the name of where
 * you are. Reached for (hovered, tabbed to, clicked), it opens into a small depth map:
 *
 * - the path you came down, as a column of planes above you, further away the further up — smaller,
 *   fainter, and past the plane directly above, blank;
 * - where you are, the one crisp, raised plane, on a row with the rooms beside you (the other shapes
 *   in the room above that have an inside);
 * - the rooms below you, on the next row down.
 *
 * Pick a plane to go there: up the column, across the row, or down into the row below. The rooms
 * below are also shapes on this canvas, and the two point at each other.
 *
 * At the top level it appears only once something on the canvas has an inside, so a canvas that has
 * never been looked inside carries no chrome for a feature it is not using.
 */
export function DepthStack() {
  // A string rather than the file, so drawing inside a room does not re-render this corner: what
  // is above you changes when you move rooms or rename a shape, and at no other time.
  const trail = useEditorStore(trailOf);
  // Gone while presenting — a plane picked mid-walkthrough would end the walkthrough — and gone
  // wherever there is nothing to show. Unmounting (rather than hiding) is what puts away hover and
  // focus that the pointer or the keyboard can no longer take back.
  const presenting = useEditorStore((state) => state.mode === 'present');
  if (!trail || presenting) return null;
  return <DepthMap trail={trail} />;
}

function DepthMap({ trail }: { trail: string }) {
  const theme = useThemeValue();
  // Pinned open for one room only: moving to another closes the view, since its layers are no
  // longer the ones you were looking at. Remembered by the room's key rather than reset in an effect.
  const [pinnedFor, setPinnedFor] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Closed on purpose — by the head, by Escape, or by picking a plane — which outranks the pointer
  // still resting on it and the focus still inside it, until either is reached for again.
  const [dismissed, setDismissed] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLButtonElement>(null);
  const platesId = useId();
  const roomKey = useEditorStore((state) => pathKey(state.path));
  const pinned = pinnedFor === roomKey;
  const setPinned = (value: boolean) => setPinnedFor(value ? roomKey : null);

  const layers = useMemo(() => (trail ? parseTrail(trail) : []), [trail]);
  const open = !dismissed && (pinned || hovered || focused);
  const close = () => {
    setPinnedFor(null);
    setDismissed(true);
  };

  // A press anywhere else puts the view away — pinned or not — so reaching for the canvas is never
  // blocked by a panel left open over it.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (navRef.current?.contains(event.target as Node)) return;
      setPinnedFor(null);
      setHovered(false);
      setFocused(false);
    };
    // Opened by the pointer alone, the keyboard is still on the canvas — and there Escape with
    // nothing selected steps out of the room. The view that is open is the nearer thing to close.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || navRef.current?.contains(document.activeElement)) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.isContentEditable || active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPinnedFor(null);
      setDismissed(true);
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  const here = layers[layers.length - 1]!;
  const tint = (accent: Accent | null) => (accent ? accentOf(theme, accent) : null);

  // Picking a plane moves you and puts the view away. The plate that was picked is about to
  // disappear, so the keyboard is handed to the head rather than dropped on the page.
  const go = (move: () => Promise<unknown> | unknown) => {
    const fromKeyboard = navRef.current?.contains(document.activeElement) ?? false;
    close();
    if (fromKeyboard) headRef.current?.focus();
    void move();
  };

  const plateButtons = () => [...(navRef.current?.querySelectorAll<HTMLButtonElement>('button.dc-depth-plate-step') ?? [])];
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && open) {
      // Close the view, and only the view — Escape here must not also step out of the room.
      event.preventDefault();
      event.stopPropagation();
      close();
      headRef.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [headRef.current!, ...plateButtons()];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    event.stopPropagation();
    setDismissed(false);
    setPinned(true);
    const next = event.key === 'ArrowDown' ? Math.min(buttons.length - 1, at + 1) : Math.max(0, at - 1);
    // The plates only exist once open; a frame later they are there to receive focus.
    requestAnimationFrame(() => [headRef.current!, ...plateButtons()][next]?.focus());
  };

  return (
    <nav
      ref={navRef}
      className="dc-depth"
      data-open={open ? 'true' : undefined}
      aria-label="Depth"
      onMouseEnter={() => {
        setHovered(true);
        setDismissed(false);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) => {
        setFocused(true);
        // Arriving from outside is reaching for it again; moving within it is not.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDismissed(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={onKeyDown}
    >
      <button
        ref={headRef}
        type="button"
        className="dc-depth-head"
        aria-expanded={open}
        aria-controls={platesId}
        aria-label={layers.length > 1 ? `Inside ${here.name} — depth` : 'Depth'}
        onClick={() => {
          // Hovering opens it for a look; a press keeps it open, and a press on a kept view closes it.
          if (pinned) close();
          else {
            setDismissed(false);
            setPinned(true);
          }
        }}
      >
        <LayerGlyph layers={layers} tint={tint} />
        {/* At the top level the title bar already names the diagram; saying it again here would
            only repeat it. Inside a shape, the shape's name is the answer to "where am I". */}
        {/* Opened, the lit plate names the room, so the head stops repeating it. */}
        <span className="dc-depth-here" data-quiet={open ? 'true' : undefined}>
          {layers.length > 1 && !open ? here.name : 'Depth'}
        </span>
        {here.level && !open && <span className="dc-depth-level">{here.level}</span>}
      </button>

      <ol id={platesId} className="dc-depth-plates" hidden={!open}>
        {layers.slice(0, -1).map((layer, index) => {
          // How far above you this plane is. Further away is smaller, fainter and less detailed; past
          // three planes up, the ones in the middle fold down to their edges, so a deep path never
          // becomes a long list.
          const distance = layers.length - 1 - index;
          const folded = layers.length > 4 && index > 0 && distance > 2;
          return (
            <li
              key={index}
              className="dc-depth-layer"
              data-folded={folded ? 'true' : undefined}
              style={plateStyle(tint(layer.accent), { '--i': index, '--dist': Math.min(distance, 3) })}
            >
              <button
                type="button"
                className="dc-depth-plate-step"
                aria-label={index === 0 ? 'Back to the whole canvas' : `Back up to ${layer.name}`}
                onClick={() => go(() => backOut(index))}
              >
                <span className="dc-depth-plate" aria-hidden="true">
                  {/* Only the plane directly above keeps its sketch; further away, a plane is just a plane. */}
                  {open && !folded && (distance === 1 ? <LayerSketch depth={index} /> : <BlankPlane />)}
                </span>
                <span className="dc-depth-plate-text">
                  <span className="dc-depth-plate-name">{layer.name}</span>
                </span>
              </button>
            </li>
          );
        })}

        {/* Where you are, on the row it shares with the rooms beside it — the other shapes in the room
            above that have an inside. They are not below you; they are next to you. */}
        <li className="dc-depth-tier" data-here="true">
          <ul className="dc-depth-row">
            <li className="dc-depth-room" data-current="true" style={plateStyle(tint(here.accent), { '--i': layers.length - 1 })}>
              <span className="dc-depth-plate-step" aria-current="location">
                <span className="dc-depth-plate" aria-hidden="true">
                  {open && <LayerSketch depth={layers.length - 1} />}
                </span>
                <span className="dc-depth-room-name" title={here.name}>
                  {here.name}
                </span>
                <span className="dc-depth-room-caption">You are here</span>
              </span>
            </li>
            {open && layers.length > 1 && <BesideRooms tint={tint} go={go} />}
          </ul>
        </li>

        {open && <BelowRooms tint={tint} go={go} />}
      </ol>
    </nav>
  );
}

/** How many rooms a row deals out before the rest fold into one edge. */
const ROW_SHOWN = 3;

type Tint = (accent: Accent | null) => ReturnType<typeof accentOf> | null;

function plateStyle(palette: ReturnType<typeof accentOf> | null, extra: Record<string, number>): CSSProperties {
  return {
    ...extra,
    '--dc-plate-line': palette?.line ?? 'var(--dc-border-strong)',
    '--dc-plate-ink': palette?.chip ?? 'var(--dc-text-muted)',
    '--dc-plate-fill': palette?.fill ?? 'var(--dc-surface)',
  } as CSSProperties;
}

/**
 * The rooms beside you: the other shapes in the room above that have an inside. Going to one is
 * the move it looks like — back out to the room above, then down into it — so it plays as exactly
 * that. Mounted only while the view is open.
 */
type Go = (move: () => Promise<unknown> | unknown) => void;

function BesideRooms({ tint, go }: { tint: Tint; go: Go }) {
  const here = useEditorStore((state) => state.path[state.path.length - 1]);
  const above = useEditorStore((state) => roomAt(state, state.path.length - 1)?.nodes ?? NO_NODES);
  const beside = useMemo(() => above.filter((node) => node.id !== here && hasInside(node)), [above, here]);
  const depth = useEditorStore((state) => state.path.length);
  if (beside.length === 0) return null;
  return (
    <Row items={beside} limit={ROW_SHOWN - 1}>
      {(node) => (
        <RoomPlate
          key={node.id}
          node={node}
          kind="beside"
          tint={tint}
          onGo={() =>
            go(async () => {
              await backOut(depth - 1);
              // The room above has to be drawn before the shape can be looked into from it.
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              await lookInside(node.id);
            })
          }
        />
      )}
    </Row>
  );
}

/**
 * The rooms below you: the shapes in this room that have an inside, on one row under the plane you
 * are on — the planes you can go down into. Mounted only while the view is open, so drawing in the
 * room does not redraw a closed corner.
 */
function BelowRooms({ tint, go }: { tint: Tint; go: Go }) {
  const nodes = useEditorStore((state) => state.document.nodes);
  const below = useMemo(() => nodes.filter(hasInside), [nodes]);
  // Whatever this view lit on the canvas goes out with it.
  useEffect(() => () => useUiStore.getState().setDepthPlateFocusId(null), []);
  if (below.length === 0) return null;
  return (
    <li className="dc-depth-tier" data-below="true">
      <ul className="dc-depth-row" aria-label="Look inside">
        <Row items={below} limit={ROW_SHOWN}>
          {(node) => <RoomPlate key={node.id} node={node} kind="below" tint={tint} onGo={() => go(() => lookInside(node.id))} />}
        </Row>
      </ul>
    </li>
  );
}

/** A row of rooms: the first few, then the rest folded into one edge that deals them all out. */
function Row({ items, limit, children }: { items: DraftNode[]; limit: number; children: (node: DraftNode) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, limit);
  return (
    <>
      {shown.map(children)}
      <RestOf count={items.length - shown.length} onExpand={() => setExpanded(true)} />
    </>
  );
}

function RoomPlate({
  node,
  kind,
  tint,
  onGo,
}: {
  node: DraftNode;
  kind: 'below' | 'beside';
  tint: Tint;
  onGo: () => void;
}) {
  const name = displayNameFor(node);
  const below = kind === 'below';
  // A room below is also a shape on this canvas: the two point at each other.
  const linked = useUiStore((state) => below && state.depthShapeHoverId === node.id);
  return (
    <li
      className="dc-depth-room"
      data-kind={kind}
      data-linked={linked ? 'true' : undefined}
      style={plateStyle(tint(depthMarkAccent(node)), { '--i': 1 })}
    >
      <button
        type="button"
        className="dc-depth-plate-step"
        aria-label={below ? `Look inside ${name}` : `Go to ${name}`}
        onClick={onGo}
        onMouseEnter={below ? () => showOnCanvas(node.id) : undefined}
        onMouseLeave={below ? () => showOnCanvas(null) : undefined}
        onFocus={below ? () => showOnCanvas(node.id) : undefined}
        onBlur={below ? () => showOnCanvas(null) : undefined}
      >
        <span className="dc-depth-plate" aria-hidden="true">
          <InsideSketch node={node} />
        </span>
        <span className="dc-depth-room-name" title={name}>
          {name}
        </span>
      </button>
    </li>
  );
}

/** The rest of a row, folded to the edges of their planes. */
function RestOf({ count, onExpand }: { count: number; onExpand: () => void }) {
  if (count <= 0) return null;
  return (
    <li className="dc-depth-room" data-rest="true">
      <button type="button" className="dc-depth-plate-step dc-depth-rest" aria-label={`Show ${count} more`} onClick={onExpand}>
        <span className="dc-depth-rest-edges" aria-hidden="true" />
        <span className="dc-depth-room-name">+{count}</span>
      </button>
    </li>
  );
}

/** Lights a shape's plane on the canvas while its plate is reached for here — or puts it out. */
function showOnCanvas(id: string | null) {
  useUiStore.getState().setDepthPlateFocusId(id);
}

/** A plane far enough away that what is drawn on it is no longer worth making out. */
function BlankPlane() {
  return <svg className="dc-fingerprint" viewBox="0 0 56 32" width="56" height="32" aria-hidden="true" />;
}

function InsideSketch({ node }: { node: DraftNode }) {
  const shape = useMemo(() => libraryShapeOf(node.inside?.nodes ?? NO_NODES, node.inside?.edges ?? NO_EDGES), [node.inside]);
  return <Fingerprint shape={shape} />;
}

interface Layer {
  name: string;
  accent: Accent | null;
  level: string | null;
}

/**
 * The compact stack: one flat layer per depth, the whole canvas on top and the room you are in at
 * the bottom, lit — the same layer the shape's own glyph is drawn from, so the two read as one mark.
 * Past five it keeps the top and the bottom and lets the middle stand for the rest.
 */
function LayerGlyph({ layers, tint }: { layers: Layer[]; tint: (accent: Accent | null) => { chip: string } | null }) {
  const shown = layers.length > 5 ? [...layers.slice(0, 2), ...layers.slice(-3)] : layers;
  const step = 3.2;
  const height = 8 + step * (shown.length - 1);
  return (
    <svg className="dc-depth-glyph-stack" width="18" height={height + 2} viewBox={`0 -1 18 ${height + 2}`} aria-hidden="true">
      {shown.map((layer, index) => {
        const current = index === shown.length - 1;
        const y = index * step;
        return (
          <path
            key={index}
            data-current={current ? 'true' : undefined}
            d={`M9 ${y} L16.5 ${y + 3.5} L9 ${y + 7} L1.5 ${y + 3.5} Z`}
            style={{ color: current ? (tint(layer.accent)?.chip ?? 'var(--dc-text)') : undefined } as CSSProperties}
          />
        );
      })}
    </svg>
  );
}

/** What is drawn on one layer, at the size the Library draws a whole canvas. */
function LayerSketch({ depth }: { depth: number }) {
  // The arrays themselves, which keep their identity until that room changes, so the sketch is only
  // redrawn when what it shows does.
  const nodes = useEditorStore((state) => roomAt(state, depth)?.nodes ?? NO_NODES);
  const edges = useEditorStore((state) => roomAt(state, depth)?.edges ?? NO_EDGES);
  const shape = useMemo(() => libraryShapeOf(nodes, edges), [nodes, edges]);
  return <Fingerprint shape={shape} />;
}

const NO_NODES: DraftNode[] = [];
const NO_EDGES: DraftEdge[] = [];

function roomAt(state: ReturnType<typeof useEditorStore.getState>, depth: number): { nodes: DraftNode[]; edges: DraftEdge[] } | undefined {
  if (depth === state.path.length) return state.document;
  const file = fileOf(state);
  if (depth === 0) return file;
  return ownerAt(file, state.path.slice(0, depth))?.inside;
}

const FIELD = '';
const RECORD = '';

/** The whole canvas, then each shape stepped through, down to the one you are in. Empty at the top
 *  level while nothing on it has an inside. */
function trailOf(state: ReturnType<typeof useEditorStore.getState>): string {
  // At the top level, only once there is somewhere to go: a canvas that has never been looked
  // inside carries nothing for a feature it is not using.
  if (state.path.length === 0 && !state.document.nodes.some(hasInside)) return '';
  const file = fileOf(state);
  const records: string[] = [];
  for (let depth = 0; depth <= state.path.length; depth += 1) {
    const path = state.path.slice(0, depth);
    const owner = depth === 0 ? undefined : ownerAt(file, path);
    const name = depth === 0 ? file.metadata.title : owner ? displayNameFor(owner) : 'Inside';
    const accent: string = owner ? depthMarkAccent(owner) : '';
    const level = effectiveLevel(file, path);
    records.push([name, accent, level && level !== 'none' ? LEVEL_LABELS[level] : ''].join(FIELD));
  }
  return records.join(RECORD);
}

function parseTrail(trail: string): Layer[] {
  return trail.split(RECORD).map((record) => {
    const [name = '', accent = '', level = ''] = record.split(FIELD);
    return { name, accent: (accent || null) as Accent | null, level: level || null };
  });
}

/**
 * What a screen reader is told when the canvas becomes a different one.
 *
 * Mounted at every depth rather than alongside the map, because arriving back at the top level
 * is a move like any other and was the one that announced nothing at all. It speaks only when the
 * room changes: the shape count used to be in here, which meant it spoke again on every single
 * thing drawn.
 */
export function DepthAnnouncer() {
  const path = useEditorStore((state) => state.path);
  const here = useEditorStore((state) => {
    if (state.path.length === 0) return null;
    const owner = ownerAt(fileOf(state), state.path);
    return owner ? displayNameFor(owner) : 'a shape';
  });
  const [message, setMessage] = useState('');
  const spokenFor = useRef<string | null>(null);

  useEffect(() => {
    // Compared by value rather than by a "first run" flag: React runs effects twice in
    // development, and a flag spends itself before the render anyone actually sees.
    const key = pathKey(path);
    if (spokenFor.current === key) return;
    const first = spokenFor.current === null;
    spokenFor.current = key;
    if (first) return;
    setMessage(here ? `Inside ${here}.` : 'Back on the whole canvas.');
  }, [path, here]);

  return (
    <p className="dc-sr-only" role="status">
      {message}
    </p>
  );
}
