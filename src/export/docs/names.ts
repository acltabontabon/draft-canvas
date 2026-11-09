/**
 * Which file holds the picture of which level. The whole diagram is `<name>.svg`, as it always was;
 * a level inside it is `<name>.<shape>.svg` (`online-store.store-api.svg`), so a README can show the
 * context and the containers of one C4 diagram, each from its own file.
 *
 * Nothing records the pairing. A published picture's own note says which diagram and which level it
 * shows, so a level's picture is found by that note, not by its name: renaming the shape later leaves
 * the file where the Markdown points and keeps it following its level. Names are only worked out for
 * a level that has no picture yet, and never land on a file that is already something else's.
 */

import { displayNameFor } from '../../document/factory';
import type { DraftDocument } from '../../document/types';
import { ownerAt } from '../../depth/tree';
import { readMarker, type DocsMarker } from './marker';

/** A file beside the diagram named like one of its pictures, as the shell lists them. */
export interface PictureFile {
  name: string;
  state: 'ours' | 'foreign';
  svg: string | null;
  modifiedMs: number | null;
}

/** A picture this diagram published: whose note names this diagram as its source. */
export interface Published {
  name: string;
  svg: string;
  modifiedMs: number | null;
  marker: DocsMarker;
}

export type LevelPicture =
  /** Nothing yet; publishing creates `name`. */
  | { state: 'none'; name: string }
  | ({ state: 'ours' } & Published)
  /**
   * Every name this level could have is held by another file: one Draft Canvas didn't make
   * (`foreign`), or another diagram's or level's picture (`other`). Neither is ever replaced.
   */
  | { state: 'taken'; name: string; why: 'foreign' | 'other' };

/**
 * A shape's name as one part of a file name: lowercase, letters and digits of any script, dashes
 * between words. Never a dot, so the shell can tell the parts of `<name>.<level>.svg` apart.
 */
export function levelSlug(name: string): string {
  return (
    Array.from(
      name
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, ''),
    )
      .slice(0, 40)
      .join('') || 'level'
  );
}

/** The names a level's picture may take, preferred first: its own shape, then the whole path in. */
export function levelImageNames(file: DraftDocument, stem: string, view: readonly string[]): string[] {
  if (view.length === 0) return [`${stem}.svg`];
  const slugs: string[] = [];
  for (let depth = 1; depth <= view.length; depth += 1) {
    const owner = ownerAt(file, view.slice(0, depth));
    slugs.push(levelSlug(owner ? displayNameFor(owner) : view[depth - 1]!));
  }
  const path = slugs.join('.');
  // The whole path only while it stays a sensible file name (the shell allows 200 characters).
  const names = [`${stem}.${slugs.at(-1)!}.svg`, ...(path.length <= 160 ? [`${stem}.${path}.svg`] : [])];
  return [...new Set(names)];
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameView = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/** Every picture beside the file that this diagram (`<stem>.draftcanvas`) published, by name. */
export function picturesOf(files: readonly PictureFile[], stem: string): Published[] {
  const source = `${stem}.draftcanvas`;
  const found: Published[] = [];
  for (const entry of files) {
    if (entry.state !== 'ours' || entry.svg === null) continue;
    const marker = readMarker(entry.svg);
    // A picture drawn from another diagram (copied in beside this one) is that diagram's to keep.
    if (!marker || !sameName(marker.source, source)) continue;
    found.push({ name: entry.name, svg: entry.svg, modifiedMs: entry.modifiedMs, marker });
  }
  return found;
}

/** The picture of `view`: the one whose note names it, else the first free name for it. */
export function pictureFor(files: readonly PictureFile[], file: DraftDocument, stem: string, view: readonly string[]): LevelPicture {
  const mine = picturesOf(files, stem).find((picture) => sameView(picture.marker.settings.view, view));
  if (mine) return { state: 'ours', ...mine };
  const names = levelImageNames(file, stem, view);
  const free = names.find((name) => !files.some((entry) => sameName(entry.name, name)));
  if (free) return { state: 'none', name: free };
  const holder = files.find((entry) => sameName(entry.name, names[0]!));
  return { state: 'taken', name: names[0]!, why: holder?.state === 'ours' ? 'other' : 'foreign' };
}
