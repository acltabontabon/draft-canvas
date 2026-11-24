import { useReactFlow, type Viewport } from '@xyflow/react';
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useDiagramStyle } from '../../canvas/useDiagramStyle';
import { backdropTile } from '../../render/style/backdrop';
import { useTheme } from '../../theme/useTheme';
import { fitPadding } from '../../lib/fitPadding';
import { motionMs } from '../../lib/motion';
import { flowFitViewNodes, hasSomethingToFit, useEditorStore } from '../../store/editorStore';
import { useStyleStore } from '../../store/styleStore';
import { useUiStore } from '../../store/uiStore';
import { usePersonality } from '../../theme/usePersonality';
import { Button } from '../common/Button';
import { AppearanceSettings } from '../settings/AppearanceSettings';
// The panel's own look, and that of every row inside it. Imported here, not only by the Settings
// dialog: on the web this panel is the only thing that shows these.
import '../settings/settings.css';

/**
 * Appearance, beside the canvas.
 *
 * A style is judged on a real diagram, so with one open this is where it is chosen and changed:
 * docked like the Outline, never over the canvas, so every pick is seen at once on the diagram
 * itself, which is framed again in the narrower canvas as the panel opens and stays live (pan it,
 * zoom it, select in it) while it is open. The same
 * `AppearanceSettings` the desktop app's Settings page shows on Home, laid out for a column.
 */
/** The named colours shown on the cover, in the order the colour picker lists them. */
const COVER_ACCENTS = ['neutral', 'teal', 'blue', 'violet', 'amber', 'rose', 'green'] as const;
const HAND_NAMES = { clean: 'Clean', draft: 'Draft', sketch: 'Sketch' } as const;

interface Camera {
  /** Where the view was before the sidebar took its room. */
  before: Viewport | null;
  /** The person panned or zoomed while it was open: the view is theirs, and stays. */
  moved: boolean;
}

/** How long the sheet takes to leave: `dc-style-panel-out` in `settings.css` runs as long. */
const LEAVE_MS = 260;
/** How long the canvas takes to give up the room: `dc-style-panel-room` in `settings.css` runs as long. */
const ROOM_MS = 300;

export function StylePanel() {
  const open = useUiStore((state) => state.stylePanelOpen);
  // It leaves as it arrived, not in one frame: closed in the store at once (so the bars it hid can
  // start back), it stays drawn for as long as it takes to slide away.
  const [leaving, setLeaving] = useState(false);
  // Decided while rendering, not in an effect after it: a render with the panel neither open nor
  // leaving takes the sheet down and puts a new one up to slide away, and that new one framed the
  // diagram again on a slow machine, over the view being put back.
  const [shown, setShown] = useState(open);
  if (shown !== open) {
    setShown(open);
    setLeaving(!open && motionMs(LEAVE_MS) > 0);
  }
  const was = useRef(open);
  const { getViewport, setViewport } = useReactFlow();
  const camera = useRef<Camera>({ before: null, moved: false });
  useEffect(() => {
    const before = was.current;
    was.current = open;
    if (open && !before) camera.current = { before: getViewport(), moved: false };
    if (open || !before) return;
    // The view goes back to where it was, once the canvas has its room again: unless the person
    // panned or zoomed meanwhile, in which case it is theirs and stays. Asked of what they did, not
    // of where the camera is: comparing positions after an animation did not hold in every browser.
    const { before: back, moved } = camera.current;
    const wait = motionMs(LEAVE_MS);
    const restore = back && !moved ? window.setTimeout(() => void setViewport(back, { duration: motionMs(320) }), wait) : undefined;
    const timer = window.setTimeout(() => setLeaving(false), wait);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(restore);
    };
  }, [open, getViewport, setViewport]);
  if (!open && !leaving) return null;
  return <Panel leaving={!open} camera={camera} />;
}

function Panel({ leaving, camera }: { leaving: boolean; camera: RefObject<Camera> }) {
  const panel = useRef<HTMLElement>(null);
  const close = () => {
    useUiStore.getState().setStylePanelOpen(false);
    document.querySelector<HTMLElement>('.dc-canvas')?.focus();
  };
  const { fitView, getZoom } = useReactFlow();
  // The colours and backdrop the canvas beside it is drawn in, for the cover.
  const resolved = useDiagramStyle();
  const { name: device } = useTheme();
  const theme = resolved.theme(device);
  const tile = backdropTile(resolved, device);
  // What the canvas beside it is drawn in: the diagram's own look when it has one, else the style in use here.
  const { preset } = usePersonality();
  const own = useEditorStore((state) => state.document.style?.name);
  const mine = useStyleStore((state) => (state.activeId ? state.profiles.find((profile) => profile.id === state.activeId)?.name : undefined));
  const hasOwn = useEditorStore((state) => state.document.style !== undefined);
  const drawingIn = (hasOwn ? own : undefined) ?? mine ?? HAND_NAMES[preset];
  // Asked for from the keyboard (⌘K), so the keyboard arrives in it.
  useEffect(() => {
    panel.current?.focus();
  }, []);
  /**
   * The panel takes its width from the canvas, so a diagram that filled the view now runs under
   * it. It is framed again in the room that is left: the diagram is what every choice here is
   * judged on, and half of it is no picture. Never closer than it was: a small diagram is moved
   * into view, not blown up.
   */
  useEffect(() => {
    // Once the canvas has finished giving up the room, not while it is still narrowing: a fit taken
    // mid-way frames the diagram for a canvas wider than the one it ends in. The canvas itself says
    // when: a timer alone ran ahead of it in WebKit, which reports a resize a frame or two later.
    const canvas = document.querySelector('.dc-canvas');
    let quiet = 0;
    let done = false;
    const fit = () => {
      if (done) return;
      done = true;
      // Closed before the canvas settled: the view is on its way back, and is not framed over.
      if (!useUiStore.getState().stylePanelOpen) return;
      const state = useEditorStore.getState();
      if (!hasSomethingToFit(state)) return;
      void fitView({ padding: fitPadding(0.2), duration: motionMs(360), maxZoom: getZoom(), nodes: flowFitViewNodes(state) });
    };
    // A wheel over the canvas, or a drag that starts on its empty pane, is the person moving the
    // view. A press on a shape is not: selecting something to look at leaves the view where it is.
    const touched = (event: Event) => {
      if (event.type === 'wheel' || (event.target instanceof Element && event.target.closest('.react-flow__pane') !== null)) camera.current.moved = true;
    };
    canvas?.addEventListener('wheel', touched, { passive: true, capture: true });
    canvas?.addEventListener('pointerdown', touched, { capture: true });
    // Each change of size puts the fit off a little; it runs when they stop coming.
    const observer =
      canvas && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (done) return;
            window.clearTimeout(quiet);
            quiet = window.setTimeout(fit, 120);
          })
        : null;
    if (canvas) observer?.observe(canvas);
    // And in any case once the room has been given up, for a canvas whose size never changes (a
    // narrow window, where the panel sits under it).
    const last = window.setTimeout(fit, motionMs(ROOM_MS) + 400);
    return () => {
      canvas?.removeEventListener('wheel', touched, { capture: true });
      canvas?.removeEventListener('pointerdown', touched, { capture: true });
      observer?.disconnect();
      window.clearTimeout(quiet);
      window.clearTimeout(last);
    };
  }, [fitView, getZoom, camera]);
  return (
    <aside
      ref={panel}
      className="dc-style-panel"
      data-leaving={leaving ? '' : undefined}
      // Nothing in a sheet that is on its way out is there to be pressed or tabbed to.
      inert={leaving}
      role="complementary"
      aria-label="Appearance"
      tabIndex={-1}
      data-dc-keyboard-region=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.stopPropagation();
        close();
      }}
    >
      {/* The whole right side, top to bottom: the bars it would sit under have stepped back (the studio state). */}
      <div className="dc-style-panel-sheet">
        {/*
          The cover: a swatch of the style itself. Its own canvas colour and backdrop, its name in the
          hand the diagram's title is written in, and its colours in a row, so the panel opens on what
          it is about to change and shows every change to the canvas the moment it is made.
        */}
        <header
          className="dc-style-cover"
          style={
            {
              '--dc-cover': theme.canvas,
              backgroundColor: theme.canvas,
              color: theme.text,
              ...(tile ? { backgroundImage: tile.uri, backgroundSize: `${tile.width * 0.75}px ${tile.height * 0.75}px` } : {}),
            } as CSSProperties
          }
        >
          <div className="dc-style-cover-top">
            <span className="dc-style-cover-kicker">Appearance</span>
            {/* The one way out that is always in view: the bars round the canvas step back while this is open. */}
            <Button variant="quiet" className="dc-style-panel-done" aria-label="Close appearance" onClick={close}>
              Done
            </Button>
          </div>
          <div className="dc-style-cover-title">
            <h2 className="dc-style-cover-name">{drawingIn}</h2>
            <svg className="dc-style-cover-stroke" viewBox="0 0 160 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <path d="M2 5.2C28 2.4 52 6.6 80 4.2S132 2.2 158 4.6" fill="none" stroke={theme.selection} strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <div className="dc-style-cover-dots" aria-hidden="true">
            {COVER_ACCENTS.map((accent) => (
              <span key={accent} style={{ background: theme.accents[accent].fill, borderColor: theme.accents[accent].line }} />
            ))}
            <span className="dc-style-cover-brand" style={{ background: theme.selection, borderColor: theme.selection }} />
          </div>
        </header>
        <div className="dc-style-panel-body dc-prefs">
          <AppearanceSettings layout="panel" />
        </div>
      </div>
    </aside>
  );
}
