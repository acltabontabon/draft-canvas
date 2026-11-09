/**
 * What makes an SVG a *docs image*: a short note inside it saying which diagram it pictures and how.
 *
 * The note is the whole of the link between a `.draftcanvas` file and the picture a Markdown file
 * shows. The picture sits beside its source under the same name (`payments.draftcanvas` →
 * `payments.svg`), and the note records the level, the look and whether saving the source should
 * redraw it. Nothing else remembers a publication — no manifest, no database, nothing in the
 * document — so a clone of the repository carries the link with it, and deleting the image ends it.
 *
 * The note never carries the diagram. A docs image is a picture only: no embedded document, no
 * hidden level, no attachment text (see `image.ts`). Node ids name the level; they are random and
 * say nothing about the architecture.
 */

import type { ThemeName } from '../../render/theme/tokens';
import type { PersonalityPreset } from '../../theme/usePersonality';
import { PERSONALITY_PROFILES } from '../../render/roughness/presets';
import { isRecord } from '../../lib/isRecord';

/** How a published image is drawn and kept. Everything here is chosen once, in Use in docs. */
export interface DocsSettings {
  /**
   * The level the image shows, as the depth path from the top: `[]` is the whole diagram. Chosen,
   * never read from where the editor happens to be standing, so moving about later can't change it.
   */
  view: string[];
  theme: ThemeName;
  style: PersonalityPreset;
  /** Saving the source redraws the image. Off: a snapshot, updated only when asked. */
  sync: boolean;
}

/** The element the note is kept in. Rust looks for exactly this text before it replaces a file. */
export const MARKER_OPEN = '<metadata id="draftcanvas-docs">';
const MARKER_CLOSE = '</metadata>';
/** Bumped only if the note's meaning changes; a reader refuses a version it doesn't know. */
const MARKER_VERSION = 1;

export const DEFAULT_DOCS_SETTINGS: DocsSettings = { view: [], theme: 'light', style: 'clean', sync: true };

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXmlText(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The note's text: keys in a fixed order, so the same settings always write the same bytes. */
export function markerElement(source: string, settings: DocsSettings): string {
  const payload = {
    v: MARKER_VERSION,
    source,
    view: settings.view,
    theme: settings.theme,
    style: settings.style,
    sync: settings.sync,
  };
  return `${MARKER_OPEN}${escapeXmlText(JSON.stringify(payload))}${MARKER_CLOSE}`;
}

export interface DocsMarker {
  source: string;
  settings: DocsSettings;
}

/**
 * The note in `svg`, or `null` when there is none or it can't be trusted. The text came from a file
 * anyone could have edited, so each field is checked rather than cast: a wrong one reads as "not a
 * docs image", which is never written over.
 */
export function readMarker(svg: string): DocsMarker | null {
  const start = svg.indexOf(MARKER_OPEN);
  if (start < 0) return null;
  const end = svg.indexOf(MARKER_CLOSE, start + MARKER_OPEN.length);
  if (end < 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(unescapeXmlText(svg.slice(start + MARKER_OPEN.length, end)));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== MARKER_VERSION) return null;
  const { source, view, theme, style, sync } = value;
  if (typeof source !== 'string') return null;
  if (!Array.isArray(view) || !view.every((id) => typeof id === 'string') || view.length > 64) return null;
  if (theme !== 'light' && theme !== 'dark') return null;
  if (typeof style !== 'string' || !Object.hasOwn(PERSONALITY_PROFILES, style)) return null;
  if (typeof sync !== 'boolean') return null;
  return { source, settings: { view: [...view], theme, style: style as PersonalityPreset, sync } };
}

export function sameSettings(a: DocsSettings, b: DocsSettings): boolean {
  return (
    a.theme === b.theme &&
    a.style === b.style &&
    a.sync === b.sync &&
    a.view.length === b.view.length &&
    a.view.every((id, index) => id === b.view[index])
  );
}
