import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { relativeTime } from '../../lib/relativeTime';
import { StarterGlyph } from '../../ui/Library/StarterGlyph';
import { useThumbnail } from '../thumbnails';
import type { PanelApi, PanelChoice, PanelState } from '../tauri/panel';
import { TRAY_GLYPHS, type TrayGlyph } from './glyphs';

const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
const MOD = MAC ? '⌘' : 'Ctrl+';
const SHIFT = MAC ? '⇧' : 'Shift+';

/** The shortcuts the menu bar has, answered here too while the panel has the keyboard. */
function choiceForKey(event: KeyboardEvent): PanelChoice | null {
  if (event.key === 'Escape') return 'panel:dismiss';
  if (!(MAC ? event.metaKey : event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'n') return event.shiftKey ? 'tray:new-canvas' : 'tray:new-quick-draft';
  if (key === 'o') return event.shiftKey ? 'tray:open-project' : 'tray:open';
  if (key === ',' && !event.shiftKey) return 'tray:settings';
  if (key === 'q' && !event.shiftKey) return 'tray:quit';
  return null;
}

/**
 * The tray panel (`src-tauri/src/panel.rs`): Home in miniature, and drawn the same way — the one
 * thing to do as the one solid node, a connector running from it to the person's own work, every
 * diagram shown as its own silhouette. It lists and chooses; everything it chooses happens in the
 * main window, which the shell brings forward.
 */
export function TrayPanel({ api }: { api: PanelApi }) {
  const [state, setState] = useState<PanelState | null>(null);
  // Bumped each time the panel is shown, so its contents arrive again rather than just being there.
  const [shown, setShown] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    api.state().then(setState, () => setState((known) => known ?? { recents: [], drafts: [] }));
  }, [api]);

  const choose = useCallback((choice: PanelChoice | string) => void api.choose(choice).catch(() => undefined), [api]);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') setShown((n) => n + 1);
    };
    const onKey = (event: KeyboardEvent) => {
      const choice = choiceForKey(event);
      if (!choice) return;
      event.preventDefault();
      choose(choice);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('keydown', onKey);
    };
  }, [refresh, choose]);

  // The window is as tall as what it holds: the shell sizes it to this, against the icon.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let last = 0;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      void api.fit(height).catch(() => undefined);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [api]);

  const drafts = state?.drafts ?? [];
  const recents = state?.recents ?? [];

  return (
    <div className="dc-tray" ref={root} data-ready={state !== null}>
      <header className="dc-tray-head">
        <button type="button" className="dc-tray-brand" onClick={() => choose('tray:show')} title="Show Draft Canvas">
          <span className="dc-tray-mark" aria-hidden="true">
            <Glyph name="quickDraft" />
          </span>
          <span className="dc-tray-word">Draft Canvas</span>
          <svg className="dc-tray-brand-go" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <path d="M3.5 8.5l5-5M4.5 3.5h4v4" />
          </svg>
        </button>
        <button type="button" className="dc-tray-icon-button" onClick={() => choose('tray:settings')} aria-label="Settings" title={`Settings  ${MOD},`}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
            <circle cx="15" cy="7" r="2" />
            <circle cx="9" cy="17" r="2" />
          </svg>
        </button>
        <button type="button" className="dc-tray-icon-button" onClick={() => choose('tray:quit')} aria-label="Quit Draft Canvas" title={`Quit Draft Canvas  ${MOD}Q`}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M12 4v7" />
            <path d="M7.5 6.8a7 7 0 1 0 9 0" />
          </svg>
        </button>
      </header>

      <button type="button" className="dc-tray-action" onClick={() => choose('tray:new-quick-draft')}>
        <Glyph name="quickDraft" />
        <span className="dc-tray-action-text">New Quick Draft</span>
        <kbd>{MOD}N</kbd>
      </button>

      <div className="dc-tray-flow" key={shown}>
        {drafts.length > 0 && (
          <section className="dc-tray-section" aria-label="Drafts">
            <h2 className="dc-tray-label">Drafts</h2>
            <ul className="dc-tray-drafts">
              {drafts.map((draft, index) => (
                <li key={draft.id} style={{ '--i': index } as CSSProperties}>
                  <button type="button" className="dc-tray-draft" onClick={() => choose(draft.choice)} title={`Carry on with ${draft.title}`}>
                    <Thumb size="row" thumbKey={`draft:${draft.id}:${draft.updatedMs ?? 0}`} load={() => api.readDraft(draft.id)} />
                    <span className="dc-tray-draft-text">
                      <span className="dc-tray-name">
                        <span className="dc-tray-edited" aria-hidden="true" />
                        {draft.title}
                      </span>
                      {draft.updatedMs !== null && <span className="dc-tray-meta">{relativeTime(draft.updatedMs)}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="dc-tray-section" aria-label="Recent">
          <h2 className="dc-tray-label">Recent</h2>
          {recents.length > 0 ? (
            <ul className="dc-tray-shelf">
              {recents.map((recent, index) => (
                <li key={recent.handle} style={{ '--i': index + drafts.length } as CSSProperties}>
                  <button
                    type="button"
                    className="dc-tray-tile"
                    onClick={() => choose(recent.choice)}
                    title={`${recent.name} · opened ${relativeTime(recent.openedMs)}`}
                  >
                    <Thumb size="tile" thumbKey={`recent:${recent.handle}:${recent.openedMs}`} load={() => api.peekDocument(recent.handle)} />
                    <span className="dc-tray-name">{recent.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dc-tray-empty">{state ? 'The diagrams you open will gather here.' : ' '}</p>
          )}
        </section>
      </div>

      <nav className="dc-tray-ways" aria-label="More ways in">
        <Way glyph="open" label="Open…" keys={`${MOD}O`} onClick={() => choose('tray:open')} />
        <Way glyph="openProject" label="Project…" keys={`${SHIFT}${MOD}O`} onClick={() => choose('tray:open-project')} />
        <Way glyph="newCanvas" label="New file…" keys={`${SHIFT}${MOD}N`} onClick={() => choose('tray:new-canvas')} />
      </nav>
    </div>
  );
}

function Way({ glyph, label, keys, onClick }: { glyph: TrayGlyph; label: string; keys: string; onClick: () => void }) {
  return (
    <button type="button" className="dc-tray-way" onClick={onClick} title={`${label}  ${keys}`}>
      <Glyph name={glyph} />
      <span>{label}</span>
    </button>
  );
}

function Glyph({ name }: { name: TrayGlyph }) {
  const spec = TRAY_GLYPHS[name];
  return (
    <svg className="dc-tray-glyph" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      {spec.lines.map((d) => (
        <path key={d} d={d} />
      ))}
      {spec.faint?.map((d) => (
        <path key={d} className="dc-tray-glyph-faint" d={d} />
      ))}
    </svg>
  );
}

/** Where each size of drawing sits, in CSS pixels: a row's small swatch, a shelf tile's larger one. */
const THUMB = { row: { width: 52, height: 34 }, tile: { width: 92, height: 62 } } as const;

/**
 * A diagram's silhouette fitted to its swatch: the same drawing as Home's tile, centred on what is
 * actually drawn rather than on the glyph's whole box, so a small diagram doesn't sit in a corner.
 */
function Thumb({ size, thumbKey, load }: { size: keyof typeof THUMB; thumbKey: string; load: () => Promise<string | null> }) {
  const read = useThumbnail(thumbKey, load, true);
  const box = THUMB[size];
  if (read.state !== 'drawn') {
    return (
      <span className="dc-tray-thumb" data-size={size} data-state={read.state} aria-hidden="true">
        <svg className="dc-tray-sheet" viewBox="0 0 24 24" width="18" height="18">
          <path d="M6.5 3h7l4.5 4.5v12a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3Z" />
          <path d="M13.5 3v4.5H18" />
        </svg>
      </span>
    );
  }
  const { bounds } = read.shape;
  const pad = size === 'row' ? 4 : 7;
  const scale = Math.min((box.width - pad * 2) / Math.max(bounds.width, 1), (box.height - pad * 2) / Math.max(bounds.height, 1), 1.25);
  const x = box.width / 2 - (bounds.x + bounds.width / 2) * scale;
  const y = box.height / 2 - (bounds.y + bounds.height / 2) * scale;
  return (
    <span className="dc-tray-thumb" data-size={size} data-state="drawn" aria-hidden="true">
      <span className="dc-tray-thumb-art" style={{ transform: `translate(${x}px, ${y}px) scale(${scale})` }}>
        <StarterGlyph starter={read.shape} />
      </span>
    </span>
  );
}
