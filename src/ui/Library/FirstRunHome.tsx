import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { PRODUCT } from '../../product';
import { ARCHITECTURE_STARTERS, type StarterId } from '../../starters';
import type { DocumentSession } from '../../store/useDocumentSession';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { LibraryBrand } from './LibraryBrand';
import { LocalNote } from './LocalNote';
import { SelectionChrome } from './SelectionChrome';
import { StarterShelf } from './StarterShelf';

/** Where the wire's arrowheads stop short of a category label, and how far out the spine sits. */
const TICK = 22;

interface WireGeometry {
  width: number;
  height: number;
  trunkY: number;
  labelYs: number[];
}

/**
 * The home screen for a library with nothing in it — the first thing anyone sees, so it does one
 * job: get them drawing. It is laid out as the smallest diagram that explains itself: a blank
 * canvas, a connector captioned "or cheat a little", fanning out to every starter Draft Canvas
 * already knows. Primary → head start → import, in that order and at those weights, and nothing
 * that describes the product instead of being it.
 *
 * Enter on an otherwise unfocused page starts a blank canvas — the ↵ on the sheet says so, and
 * disappears the moment anything else on the page holds focus (where Enter means that thing).
 */
export function FirstRunHome({ session, onImport }: { session: DocumentSession; onImport: () => void }) {
  const sheetRef = useRef<HTMLButtonElement>(null);
  const shelfRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wireRef = useRef<HTMLDivElement>(null);
  const importHintId = useId();
  const wire = useWireGeometry(stageRef, wireRef, sheetRef);
  const spotlight = useSpotlight(sheetRef);

  const startBlank = () => void session.newDocument();
  const startFrom = (id: StarterId) => void session.newDocument(undefined, id);
  const newDocument = useRef(session.newDocument);
  useEffect(() => {
    newDocument.current = session.newDocument;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.repeat || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void newDocument.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const note = <LocalNote durable={session.durable} repository={session.repository} />;

  return (
    <div className="dc-home">
      <div className="dc-home-inner">
        <header className="dc-home-head">
          <LibraryBrand />
          <Motto text={PRODUCT.motto} />
          <p className="dc-home-tagline">{PRODUCT.tagline}</p>
        </header>

        <div className="dc-home-stage" ref={stageRef}>
          <div className="dc-home-start">
            <button
              ref={sheetRef}
              type="button"
              className="dc-sheet"
              aria-label="New canvas"
              onClick={startBlank}
              onPointerMove={spotlight.move}
              onPointerLeave={spotlight.leave}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return;
                const first = shelfRef.current?.querySelector<HTMLButtonElement>('.dc-starter');
                if (!first) return;
                event.preventDefault();
                first.focus();
              }}
            >
              <span className="dc-sheet-crops" aria-hidden="true">
                <span data-at="nw" />
                <span data-at="ne" />
                <span data-at="se" />
                <span data-at="sw" />
              </span>
              <SelectionChrome />
              <span className="dc-sheet-pill">
                <Icon name="plus" size={15} />
                New canvas
                <kbd aria-hidden="true">↵</kbd>
              </span>
            </button>
            <Button variant="quiet" icon="upload" className="dc-home-import" onClick={onImport} aria-describedby={importHintId}>
              Import <span className="dc-home-import-ext">.draftcanvas</span>
            </Button>
            <span id={importHintId} className="dc-sr-only">
              Opens a .draftcanvas or .json file exported from Draft Canvas, or a secure .dcenc export.
            </span>
          </div>

          <div className="dc-home-wire" ref={wireRef} aria-hidden="true">
            {wire && <Wire geometry={wire} />}
          </div>

          <div className="dc-home-starters">
            <p className="dc-home-cheat" aria-hidden="true">
              Or cheat a little.
            </p>
            <StarterShelf
              starters={ARCHITECTURE_STARTERS}
              onStart={startFrom}
              onExitStart={() => sheetRef.current?.focus()}
              shelfRef={shelfRef}
            />
          </div>
        </div>

        {!session.durable && <div className="dc-home-warn">{note}</div>}
      </div>

      {session.durable && (
        <footer className="dc-home-status">
          <div className="dc-home-status-inner">{note}</div>
        </footer>
      )}
    </div>
  );
}

/**
 * The big line, set as setup and punchline: every sentence but the last quieter, the last one on
 * its own line at full strength — so the eye lands on the instruction.
 */
function Motto({ text }: { text: string }) {
  const sentences = text.match(/[^.!?]+[.!?]+/g)?.map((sentence) => sentence.trim()) ?? [text];
  const punchline = sentences.pop() ?? text;
  return (
    <p className="dc-home-motto">
      {sentences.length > 0 && <span className="dc-home-motto-setup">{sentences.join(' ')} </span>}
      <span className="dc-home-motto-punch">{punchline}</span>
    </p>
  );
}

/**
 * The connector from the blank canvas to the starters: a trunk out of the sheet's middle, a
 * spine down the shelf's left edge, one arrowed branch into each category label — the same
 * fan-out shape Smart Routing draws on the canvas. The only thing it needs from layout is where
 * those labels and the sheet's middle actually landed, so it measures them (one ResizeObserver,
 * nothing on scroll or pointer) rather than guessing: any category split, any catalog size.
 */
function Wire({ geometry }: { geometry: WireGeometry }) {
  const { width, height, trunkY, labelYs } = geometry;
  const spineX = width - TICK;
  const top = Math.min(trunkY, ...labelYs);
  const bottom = Math.max(trunkY, ...labelYs);
  const tipX = width - 5;
  return (
    <>
      <svg className="dc-wire" width={width} height={height} viewBox={`0 0 ${width} ${height}`} focusable="false">
        <path className="dc-wire-trunk" d={`M0 ${trunkY}H${spineX}`} pathLength={1} />
        {bottom - top > 1 && <path className="dc-wire-spine" d={`M${spineX} ${top}V${bottom}`} pathLength={1} />}
        {labelYs.map((y, i) => (
          <g key={i} className="dc-wire-branch">
            <path d={`M${spineX} ${y}H${tipX}`} pathLength={1} />
            <path className="dc-wire-arrow" d={`M${tipX - 4} ${y - 3}L${tipX} ${y}L${tipX - 4} ${y + 3}`} />
          </g>
        ))}
        <circle className="dc-wire-source" cx={3.5} cy={trunkY} r={3} />
        <circle className="dc-wire-junction" cx={spineX} cy={trunkY} r={2.5} />
      </svg>
      <span className="dc-wire-caption" style={{ left: spineX / 2, top: trunkY }}>
        or cheat a little
      </span>
    </>
  );
}

function useWireGeometry(
  stageRef: RefObject<HTMLDivElement | null>,
  wireRef: RefObject<HTMLDivElement | null>,
  sheetRef: RefObject<HTMLButtonElement | null>,
): WireGeometry | null {
  const [geometry, setGeometry] = useState<WireGeometry | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const wire = wireRef.current;
    const sheet = sheetRef.current;
    if (!stage || !wire || !sheet || typeof ResizeObserver === 'undefined') return;
    // Layout offsets, not client rects: the arrival animation slides everything up a few pixels,
    // and a wire measured mid-slide would point just below where each label comes to rest.
    const middleOf = (element: HTMLElement) => topWithin(element, stage) + element.offsetHeight / 2;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = wire;
      // Hidden below the wide breakpoint: nothing to draw, nothing to keep.
      if (width === 0 || height === 0) {
        setGeometry((current) => (current === null ? current : null));
        return;
      }
      const top = topWithin(wire, stage);
      const labels = [...stage.querySelectorAll<HTMLElement>('.dc-shelf-label')].map((label) =>
        Math.round(middleOf(label) - top),
      );
      const next: WireGeometry = { width, height, trunkY: Math.round(middleOf(sheet) - top), labelYs: labels };
      setGeometry((current) => (current && sameGeometry(current, next) ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [sheetRef, stageRef, wireRef]);

  return geometry;
}

/** `element`'s top edge within `ancestor`, by layout alone — transforms don't move it. */
function topWithin(element: HTMLElement, ancestor: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== ancestor) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

function sameGeometry(a: WireGeometry, b: WireGeometry): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.trunkY === b.trunkY &&
    a.labelYs.length === b.labelYs.length &&
    a.labelYs.every((y, i) => y === b.labelYs[i])
  );
}

/**
 * The dots under the pointer brighten, as if the canvas noticed you. A mouse-only nicety: two
 * custom properties written straight to the element at most once a frame, no React state, and
 * the stylesheet drops it entirely under reduced motion.
 */
function useSpotlight(target: RefObject<HTMLElement | null>) {
  const frame = useRef<number | null>(null);
  const point = useRef({ x: 0, y: 0 });

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return {
    move: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'mouse') return;
      const rect = event.currentTarget.getBoundingClientRect();
      point.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const element = target.current;
        if (!element) return;
        element.style.setProperty('--x', `${point.current.x}px`);
        element.style.setProperty('--y', `${point.current.y}px`);
      });
    },
    leave: () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
  };
}
