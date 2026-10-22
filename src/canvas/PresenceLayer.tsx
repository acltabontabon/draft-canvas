import { memo, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { DraftEdge, DraftNode } from '../document/types';
import { describeContext, describeNode } from '../nodes/describe';
import type { Shape } from '../render/displayList';
import { beginClipScope, emitDisplayList } from '../render/svg/emit';
import { serialize } from '../render/svg/element';
import { edgeIndex, nodeIndex } from '../store/selectors';
import { useCollabStore } from '../store/collabStore';
import { useEditorStore } from '../store/editorStore';
import { holdingsOf, peersInRoom, roomOf, type PeerPresence } from '../ui/collab/presence/model';
import { usePersonality } from '../ui/personality/usePersonality';
import { useThemeValue } from '../ui/theme/useTheme';
import { emphasisOf } from './emphasis';
import '../styles/presence.css';

/**
 * The other people in a live session, drawn where they are working: each one's pointer with their
 * name, a ring in their colour around every shape and connector they hold, and a quiet "typing" tag
 * on the shape they are writing in. Only for people in the room on screen — someone inside another
 * shape is somewhere else.
 *
 * Canvas chrome in flow space (inside `Canvas`'s `<ViewportLayer>`, so it pans and zooms with the
 * diagram) and nothing more: pointer-transparent, never part of the document, its history or an
 * export (`describe` has no counterpart, deliberately), gone when the session is.
 *
 * Built for a big diagram with busy collaborators: one subscription to the session, so no shape or
 * connector reads presence itself; the document is read only while someone holds a shape; a ring
 * redraws only when its own shape changes; and connector rings are a few CSS rules on the
 * connector's own click band rather than a second routing of it.
 */
/** One empty list, so a room nobody holds a connector in reads no edges and re-renders for none. */
const NO_EDGES: readonly DraftEdge[] = [];

export const PresenceLayer = memo(function PresenceLayer() {
  const { active, peers, presence } = useCollabStore(
    useShallow((state) => ({ active: state.role !== 'off', peers: state.peers, presence: state.presence })),
  );
  const path = useEditorStore((state) => state.path);
  const room = roomOf(path);
  const shown = useMemo(() => (active ? peersInRoom(peers, presence, room) : NO_PEERS), [active, peers, presence, room]);
  const holdings = useMemo(() => holdingsOf(shown), [shown]);
  const holdsShapes = holdings.nodes.size > 0;
  // Nobody holding a shape: no reason to hear about every edit to the document.
  const nodes = useEditorStore((state) => (holdsShapes ? state.document.nodes : NO_NODES));
  const byId = holdsShapes ? nodeIndex(nodes) : null;
  const theme = useThemeValue();
  const { preset } = usePersonality();
  // Only connectors that exist in this room get a rule — a peer can name any ids it likes.
  const holdsEdges = holdings.edges.size > 0;
  const edges = useEditorStore((state) => (holdsEdges ? state.document.edges : NO_EDGES));
  const edgeRules = useMemo(() => {
    if (!holdsEdges) return '';
    const here = edgeIndex(edges);
    return edgeRingRules(new Map([...holdings.edges].filter(([id]) => here.has(id))));
  }, [holdsEdges, edges, holdings.edges]);

  if (shown.length === 0) return null;

  const rings: ReactNode[] = [];
  const tags: ReactNode[] = [];
  const tagged = new Set<string>();
  if (byId) {
    for (const [id, holders] of holdings.nodes) {
      const node = byId.get(id);
      if (!node) continue;
      rings.push(
        <PresenceRing
          key={id}
          node={node}
          colors={holders.slice(0, MAX_RINGS).map((peer) => peer.color).join(',')}
          faint={holders.every((peer) => peer.faint)}
          theme={theme}
          preset={preset}
        />,
      );
    }
    for (const [id, peer] of holdings.editing) {
      const node = byId.get(id);
      if (!node) continue;
      tagged.add(peer.id);
      tags.push(<TypingTag key={id} x={node.x} y={node.y} name={peer.name} color={peer.color} />);
    }
  }

  return (
    <div className="dc-presence" aria-hidden="true">
      {edgeRules && <style>{edgeRules}</style>}
      {rings}
      {tags}
      {shown.map((peer) =>
        peer.presence.pointer ? (
          <PresenceCursor
            key={peer.id}
            x={peer.presence.pointer.x}
            y={peer.presence.pointer.y}
            name={peer.name}
            color={peer.color}
            faint={peer.faint}
            // Typing, their name is already on the shape's tag; the pointer beside it says it once.
            named={!tagged.has(peer.id)}
          />
        ) : null,
      )}
    </div>
  );
});

const NO_PEERS: PeerPresence[] = [];
const NO_NODES: DraftNode[] = [];

/** Rings nest outward, one per person holding the shape; past three it is a crowd, not a cue. */
const MAX_RINGS = 3;
/** The clear space between a shape's outline and its first ring, and each ring's own width. */
const RING_GAP = 2.5;
const RING_WIDTH = 2.2;
const RING_STEP = RING_WIDTH + 1.3;
/** Room past the shape's box for the outermost ring and its halo. */
const RING_BLEED = 24;

/**
 * A connector held by someone: its own click band (`.dc-edge-hit`, the canonical route, 12px on
 * screen and otherwise invisible) washed in their colour. It follows the route exactly as drawn —
 * bends, lanes, the reply line — without routing it a second time, and costs no per-connector work.
 * Ids are written inside a quoted attribute selector, with the only characters that could end it
 * escaped.
 */
function edgeRingRules(edges: ReadonlyMap<string, PeerPresence[]>): string {
  let css = '';
  for (const [id, holders] of edges) {
    const peer = holders[0]!;
    css +=
      `.react-flow__edge[data-id="${cssString(id)}"] .dc-edge-hit{` +
      `stroke:var(--dc-peer-${peer.color},#8b93a1);stroke-opacity:${holders.every((h) => h.faint) ? 0.14 : 0.3};` +
      `stroke-width:calc(10px / var(--dc-zoom,1));stroke-linecap:round;stroke-linejoin:round}`;
  }
  return css;
}

function cssString(value: string): string {
  return value.replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `);
}

/**
 * The silhouette of a shape (`emphasisOf`, the same contour presentation lights) restroked: `width`
 * gives each outline's new width from its own and the scale its groups apply, so a ring is as wide
 * around a scaled-up glyph as around a card. Dashes go: a ring is a ring, whatever the outline is.
 */
function restroke(shapes: readonly Shape[], color: string, fill: string, width: (own: number, scale: number) => number, scale = 1): Shape[] {
  const out: Shape[] = [];
  for (const shape of shapes) {
    if (shape.t === 'group') {
      // No clip: it bounds a glyph's own drawing, and a ring lies outside it by definition.
      out.push({ ...shape, clip: undefined, opacity: undefined, children: restroke(shape.children, color, fill, width, scale * (shape.scale ?? 1)) });
      continue;
    }
    if (shape.t === 'text' || shape.t === 'rich' || shape.t === 'code' || !shape.stroke) continue;
    out.push({
      ...shape,
      fill,
      opacity: undefined,
      shadow: false,
      stroke: { color, width: width(shape.stroke.width, scale), linecap: 'round' },
    });
  }
  return out;
}

interface RingMarkup {
  mask: string;
  band: string;
}

/**
 * Rings around one shape, following its own contour: the silhouette stroked wide in the person's
 * colour, then masked by the same silhouette filled and stroked a little wider — so only the part
 * past the outline shows, a clear hairline away from it. Nothing is ever painted over the shape,
 * so its label and glyph stay exactly as they were.
 */
const PresenceRing = memo(function PresenceRing({
  node,
  colors,
  faint,
  theme,
  preset,
}: {
  node: DraftNode;
  /** The holders' palette indexes, nearest ring first. A string, so the memo compares it by value. */
  colors: string;
  faint: boolean;
  theme: ReturnType<typeof useThemeValue>;
  preset: ReturnType<typeof usePersonality>['preset'];
}) {
  const silhouette = useMemo(() => {
    return emphasisOf(describeNode(node, describeContext(theme, preset)).shapes);
  }, [node, theme, preset]);

  const rings = useMemo<RingMarkup[]>(() => {
    if (silhouette.length === 0) return [];
    return colors.split(',').map((_, index) => {
      const gap = RING_GAP + index * RING_STEP;
      const emit = (scope: string, shapes: Shape[]) => {
        // Each copy its own clip scope: a group's clip ids must stay unique within the page.
        beginClipScope(`presence-${index}-${scope}-${node.id}`);
        return emitDisplayList({ width: node.width, height: node.height, shapes }).map(serialize).join('');
      };
      return {
        mask: emit('mask', restroke(silhouette, '#000', '#000', (own, scale) => own + (2 * gap) / scale)),
        band: emit('band', restroke(silhouette, 'currentColor', 'none', (own, scale) => own + (2 * (gap + RING_WIDTH)) / scale)),
      };
    });
  }, [silhouette, colors, node.id, node.width, node.height]);

  if (rings.length === 0) return null;
  const width = node.width + RING_BLEED * 2;
  const height = node.height + RING_BLEED * 2;
  const palette = colors.split(',');
  return (
    <svg
      className="dc-presence-ring"
      data-faint={faint ? 'true' : undefined}
      width={width}
      height={height}
      viewBox={`${-RING_BLEED} ${-RING_BLEED} ${width} ${height}`}
      style={{ transform: `translate(${node.x - RING_BLEED}px, ${node.y - RING_BLEED}px)` }}
      focusable="false"
    >
      {rings.map((ring, index) => {
        const maskId = `dc-presence-mask-${index}-${maskSafe(node.id)}`;
        return (
          <g key={index} data-peer-color={palette[index]} className="dc-presence-ring-band">
            <mask id={maskId} maskUnits="userSpaceOnUse" x={-RING_BLEED} y={-RING_BLEED} width={width} height={height}>
              <rect x={-RING_BLEED} y={-RING_BLEED} width={width} height={height} fill="#fff" />
              <g dangerouslySetInnerHTML={{ __html: ring.mask }} />
            </mask>
            <g mask={`url(#${maskId})`} dangerouslySetInnerHTML={{ __html: ring.band }} />
          </g>
        );
      })}
    </svg>
  );
});

/** An id usable inside `url(#…)`, kept unique per shape the way `beginClipScope` spells scopes. */
function maskSafe(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/gu, (char) => `.${char.codePointAt(0)!.toString(36)}.`);
}

/** Someone writing in a shape: their name over its corner, with three patient dots. */
const TypingTag = memo(function TypingTag({ x, y, name, color }: { x: number; y: number; name: string; color: number }) {
  return (
    <div className="dc-presence-typing" data-peer-color={color} style={{ transform: `translate(${x}px, ${y}px)` }}>
      <div className="dc-presence-typing-body dc-presence-name">
        <span className="dc-presence-typing-who">{name}</span>
        <span className="dc-presence-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
});

/** A pointer at rest this long has been left there; it fades until it moves again. */
const IDLE_MS = 8000;

/**
 * Someone's pointer: an arrow in their colour and their name beside it, at a constant size on screen
 * whatever the zoom (`--dc-zoom`). It glides between updates (a `transform` transition a little
 * longer than the 50 ms they arrive at) and fades once it has been still for a while — set on the
 * element directly, so resting costs no render.
 */
const PresenceCursor = memo(function PresenceCursor({
  x,
  y,
  name,
  color,
  faint,
  named,
}: {
  x: number;
  y: number;
  name: string;
  color: number;
  faint: boolean;
  /** Whether the name rides along — not while the same name is on a typing tag. */
  named: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    delete element.dataset.idle;
    const timer = window.setTimeout(() => {
      element.dataset.idle = 'true';
    }, IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [x, y]);
  const style: CSSProperties = { transform: `translate(${x}px, ${y}px)` };
  return (
    <div ref={ref} className="dc-presence-cursor" data-peer-color={color} data-faint={faint ? 'true' : undefined} style={style}>
      <div className="dc-presence-cursor-body">
        <svg className="dc-presence-arrow" width="18" height="18" viewBox="0 0 18 18" focusable="false">
          <path d="M3 2.2 16.4 8.5 10.3 10.4 7.5 16.4Z" />
        </svg>
        {named && <span className="dc-presence-name">{name}</span>}
      </div>
    </div>
  );
});
