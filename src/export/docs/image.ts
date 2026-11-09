/**
 * The picture a Markdown file shows: one level of a diagram, drawn by the same renderer as every
 * other export (`renderDocumentSvg`), with the docs note (`marker.ts`) and a `<title>` added.
 *
 * Deliberately narrower than Image export:
 *
 * - **Never editable.** The diagram is not embedded, whatever Image export's "Editable" box says. A
 *   README is public in a way a file sent to a colleague is not, and an editable image carries every
 *   level, note and code snippet, not just the one level in the picture. The `.draftcanvas` beside
 *   it is the editable copy.
 * - **Nothing from the editor's moment.** No selection, no selected Flow, no camera: the same file
 *   and settings always draw the same bytes, wherever the person happens to be standing. That is
 *   what lets "is the published image current?" be a plain comparison of two strings.
 *
 * Both the Use in docs panel and the desktop's redraw-on-save call this one function, so what the
 * panel previews is what the file gets.
 */

import { displayNameFor } from '../../document/factory';
import type { DraftDocument } from '../../document/types';
import { hasInside, ownerAt, viewOf } from '../../depth/tree';
import { loadTechnologyIcons } from '../../nodes/technology';
import { renderDocumentSvg } from '../../render/svg/document';
// The renderer's own escaping: it also drops characters XML forbids, which would make the file unreadable.
import { escapeXmlText } from '../../render/svg/element';
import { resolveExportBackground } from '../background';
import { collectRooms } from '../rooms';
import { markerElement, type DocsSettings } from './marker';

export type DocsRender =
  | { ok: true; svg: string; width: number; height: number }
  /** The level the settings name is gone: its shape was deleted, or lost its inside view. */
  | { ok: false; reason: 'missing-view' };

/** One level a docs image can show, as Use in docs lists them. */
export interface DocsLevel {
  path: string[];
  label: string;
}

/** Every level, outermost first: "Whole diagram", then "Inside Orders API", "Inside Orders API / Handler"… */
export function docsLevels(file: DraftDocument): DocsLevel[] {
  return collectRooms(file).map((room) => ({
    path: [...room.path],
    label: room.owners.length === 0 ? 'Whole diagram' : `Inside ${room.owners.map((owner) => oneLine(displayNameFor(owner))).join(' / ')}`,
  }));
}

/** Whether `path` still names a level of `file` (a shape that has, or had, an inside view). */
export function levelExists(file: DraftDocument, path: readonly string[]): boolean {
  if (path.length === 0) return true;
  const owner = ownerAt(file, path);
  return owner !== undefined && hasInside(owner);
}

/** What the image is called in alt text and its own `<title>`: the diagram's title, then each level in. */
export function docsTitleFor(file: DraftDocument, path: readonly string[]): string {
  const title = oneLine(file.metadata.title) || 'Architecture diagram';
  const owners: string[] = [];
  for (let depth = 1; depth <= path.length; depth += 1) {
    const owner = ownerAt(file, path.slice(0, depth));
    if (owner) owners.push(oneLine(displayNameFor(owner)));
  }
  return [title, ...owners].join(' / ');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The docs image of `file` at `settings.view`. `source` is the `.draftcanvas` file's own name, as the
 * Markdown's repository will hold it; it goes into the note, so a reader of the SVG knows where to
 * edit it.
 */
export async function renderDocsImage(file: DraftDocument, source: string, settings: DocsSettings): Promise<DocsRender> {
  if (!levelExists(file, settings.view)) return { ok: false, reason: 'missing-view' };
  const view = viewOf(file, settings.view);
  if (!view) return { ok: false, reason: 'missing-view' };
  await loadTechnologyIcons(view.nodes);
  const background = await resolveExportBackground(view, true);
  const rendered = renderDocumentSvg(view, {
    theme: settings.theme,
    preset: settings.style,
    background,
    includeBackground: true,
    // Open points stay, as they do in every picture: a published diagram that silently dropped
    // them would present each unsettled assumption as decided.
    openPoints: true,
    // Scoped by level, so two levels of one diagram inlined on one page keep their own ids.
    idScope: `docs-${settings.view.join('.') || 'top'}`,
  });
  return { ok: true, svg: withDocsHeader(rendered.svg, docsTitleFor(file, settings.view), markerElement(source, settings)), width: rendered.width, height: rendered.height };
}

/** The `<title>` (what a screen reader announces for the image) and the note, first inside `<svg>`. */
function withDocsHeader(svg: string, title: string, marker: string): string {
  const open = svg.indexOf('>', svg.indexOf('<svg'));
  if (open < 0) return svg;
  return `${svg.slice(0, open)} role="img">${`<title>${escapeXmlText(title)}</title>`}${marker}${svg.slice(open + 1)}`;
}
