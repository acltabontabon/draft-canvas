import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useDiagramStyle } from '../../canvas/useDiagramStyle';
import { backdropTile } from '../../render/style/backdrop';
import { useTheme } from '../../theme/useTheme';
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

/** How long the sheet takes to leave: `dc-style-panel-out` in `settings.css` runs as long. */
const LEAVE_MS = 260;
/** How long the canvas takes to give up the room: `dc-style-panel-room` in `settings.css` runs as long. */
const ROOM_MS = 300;

export function StylePanel() {
  const open = useUiStore((state) => state.stylePanelOpen);
  // It leaves as it arrived, not in one frame: closed in the store at once (so the bars it hid can
  // start back), it stays drawn for as long as it takes to slide away.
  const [leaving, setLeaving] = useState(false);
  const was = useRef(open);
  useEffect(() => {
    const before = was.current;
    was.current = open;
    if (open || !before) return;
    const wait = motionMs(LEAVE_MS);
    if (wait === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect -- the leaving state exists only to outlive `open` by one animation.
    setLeaving(true);
    const timer = window.setTimeout(() => setLeaving(false), wait);
    return () => {
      window.clearTimeout(timer);
      setLeaving(false);
    };
  }, [open]);
  if (!open && !leaving) return null;
  return <Panel leaving={!open} />;
}

function Panel({ leaving }: { leaving: boolean }) {
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
    // Once the canvas has finished giving up the room (`dc-style-panel-room`), not while it is still
    // narrowing: a fit taken mid-way frames the diagram for a canvas wider than the one it ends in.
    const timer = window.setTimeout(() => {
      const state = useEditorStore.getState();
      if (hasSomethingToFit(state)) void fitView({ padding: 0.2, duration: motionMs(360), maxZoom: getZoom(), nodes: flowFitViewNodes(state) });
    }, motionMs(ROOM_MS) + 40);
    return () => window.clearTimeout(timer);
  }, [fitView, getZoom]);
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
