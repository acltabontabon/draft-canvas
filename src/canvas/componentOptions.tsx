import { COMPONENT_KINDS } from '../document/types';
import { COMPONENT_KIND_OPTION_LABELS } from '../ui/Editor/nodeKindLabels';
import { shapeVariantOptions } from './shapeVariantOptions';

/** The Component kind picker's shared option list — see `dataStoreOptions.tsx`. Every kind draws
 *  identically (`nodes/describe.ts`'s `component()` — only the corner caption differs, and
 *  `generic` gets none), unlike Service/Database's genuinely distinct per-kind silhouettes, so this
 *  list previews as three copies of the same box with a different tiny tag. That's intentional, not
 *  a gap to fill in later — see `component()`'s own doc comment. */
export const COMPONENT_ICON_OPTIONS = shapeVariantOptions(
  'component',
  COMPONENT_KINDS,
  COMPONENT_KIND_OPTION_LABELS,
  (kind) => ({ componentKind: kind }),
);
