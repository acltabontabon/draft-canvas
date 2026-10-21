/**
 * "Every level": one image per room, in one ZIP.
 *
 * A document is a tree of rooms, and a single picture only ever shows one of them. This walks the
 * tree, renders each room with the very renderers the single export uses, and stores the results in
 * an archive named for the path in: `checkout.png` at the top, `checkout--orders-api.png` inside
 * Orders API, and so on. Nothing here draws — a room is rendered by `renderDocumentSvg` and
 * rasterized by `rasterizeSvg`, exactly as one image would be, so the two exports cannot drift.
 */

import { displayNameFor } from '../document/factory';
import type { DraftDocument } from '../document/types';
import { rasterizeSvg } from '../render/png/rasterize';
import { renderDocumentSvg, type ExportOptions } from '../render/svg/document';
import { loadTechnologyIcons } from '../nodes/technology';
import { themeFor } from '../render/theme/tokens';
import { fileNameFor } from './project';
import { collectRooms, type ExportRoom } from './rooms';
import { zipFiles, type ZipEntry } from './zip';

export type LevelImageFormat = 'png' | 'svg';

export interface EveryLevelOptions extends ExportOptions {
  format: LevelImageFormat;
  /** PNG only — the same fixed multiplier the single export uses. */
  scale?: number;
}

export interface LevelEntry {
  room: ExportRoom;
  /** The archive member's base name, without an extension. */
  name: string;
}

/**
 * The rooms to picture, each with a file-system-safe name: the document's own slug, then one slug
 * per owner on the way in, joined with `--`. Two shapes with the same name in the same place get
 * a counter, since an archive with two members of one name is an archive that loses one.
 */
export function collectLevels(document: DraftDocument): LevelEntry[] {
  const seen = new Map<string, number>();
  const used = new Set<string>();
  return collectRooms(document).map((room) => {
    // `displayNameFor` is what the dialog calls the room ("Inside Orders API"), so the member is
    // named the way the screen named it — an unnamed owner reads as its kind, and the counter below
    // keeps two of those apart.
    const base = [slugOf(document.metadata.title), ...room.owners.map((owner) => slugOf(displayNameFor(owner)))].join('--');
    // Counted until free, not just once: a second "API" became `api-2`, which a room owned by a
    // shape named "API 2" already slugs to, and the archive kept only one of them.
    let times = seen.get(base) ?? 0;
    let name: string;
    do {
      times += 1;
      name = times === 1 ? base : `${base}-${times}`;
    } while (used.has(name));
    seen.set(base, times);
    used.add(name);
    return { room, name };
  });
}

/** `fileNameFor` without its extension — the same slug the single export's file name carries. */
function slugOf(title: string): string {
  return fileNameFor(title, '');
}

/** The archive's members, rendered — SVG text or PNG bytes per room, in tree order. */
export async function renderEveryLevel(document: DraftDocument, options: EveryLevelOptions): Promise<ZipEntry[]> {
  const { format, scale, ...rest } = options;
  // A selection belongs to the room it was made in; the point of this export is every room.
  const roomOptions: ExportOptions = { ...rest, only: undefined };
  const entries: ZipEntry[] = [];
  for (const level of collectLevels(document)) {
    await loadTechnologyIcons(level.room.document.nodes);
    const rendered = renderDocumentSvg(level.room.document, roomOptions);
    if (format === 'svg') {
      entries.push({ name: `${level.name}.svg`, data: rendered.svg });
      continue;
    }
    const blob = await rasterizeSvg(rendered.svg, {
      width: rendered.width,
      height: rendered.height,
      scale: scale ?? 2,
      background: options.transparent ? undefined : themeFor(options.theme ?? 'dark').canvas,
    });
    entries.push({ name: `${level.name}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return entries;
}

/** The whole export as one archive's bytes. */
export async function zipEveryLevel(document: DraftDocument, options: EveryLevelOptions): Promise<Uint8Array<ArrayBuffer>> {
  return zipFiles(await renderEveryLevel(document, options));
}

export const LEVELS_EXTENSION = '-levels.zip';
