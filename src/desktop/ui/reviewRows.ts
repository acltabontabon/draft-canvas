import type { DiffField, ElementDiffRow } from '../../agent/proposal';

/**
 * The review's change list in the words a person reads a diagram in. The diff underneath is the
 * file's own fields (`x`, `accent`, `parentId`); a re-layout touches the geometry of every shape and
 * connector, which listed field by field buried the one real change in coordinates. Geometry is
 * counted into one layout line instead, and the fields left are named and resolved (a boundary by its
 * label, not its id).
 */

const PLACE = new Set(['x', 'y', 'width', 'height', 'z']);
const ROUTE = new Set(['sourceAnchor', 'targetAnchor', 'routeMode', 'waypoints']);

const NAMES: Record<string, string> = {
  accent: 'Colour',
  parentId: 'Boundary',
  label: 'Label',
  type: 'Shape',
  description: 'Description',
  technology: 'Technology',
  semantic: 'Meaning',
  lineStyle: 'Line',
  source: 'From',
  target: 'To',
};

export interface ReviewRows {
  rows: ElementDiffRow[];
  /** "4 shapes moved · 3 connectors rerouted", or null when nothing only moved. */
  layout: string | null;
}

export function reviewRows(diff: readonly ElementDiffRow[], nameOf: (id: string) => string | undefined): ReviewRows {
  let moved = 0;
  let rerouted = 0;
  const rows: ElementDiffRow[] = [];
  for (const row of diff) {
    if (row.change !== 'modified' || !row.fields) {
      rows.push(row);
      continue;
    }
    const geometry = row.fields.some((f) => PLACE.has(f.field) || ROUTE.has(f.field));
    const fields = row.fields.filter((f) => !PLACE.has(f.field) && !ROUTE.has(f.field)).map((f) => readable(f, nameOf));
    if (geometry) {
      if (row.kind === 'relationship') rerouted += 1;
      else moved += 1;
    }
    if (fields.length) rows.push({ ...row, fields });
  }
  const parts = [moved && `${moved} ${moved === 1 ? 'shape' : 'shapes'} moved`, rerouted && `${rerouted} ${rerouted === 1 ? 'connector' : 'connectors'} rerouted`].filter(Boolean);
  return { rows, layout: parts.length ? parts.join(' · ') : null };
}

function readable(field: DiffField, nameOf: (id: string) => string | undefined): DiffField {
  const name = NAMES[field.field] ?? field.field;
  if (field.field !== 'parentId') return { ...field, field: name };
  const label = (id?: string) => (id === undefined ? undefined : nameOf(id) || id);
  return { field: name, before: label(field.before), after: label(field.after) };
}
