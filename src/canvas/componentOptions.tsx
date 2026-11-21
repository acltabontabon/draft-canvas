import { isGlyphComponentKind } from '../document/dataStoreGeometry';
import { COMPONENT_KINDS } from '../document/types';
import { COMPONENT_KIND_OPTION_LABELS } from '../lib/nodeKindLabels';
import { shapeVariantOptions } from './shapeVariantOptions';

/** The Component kind picker's shared option list — see `dataStoreOptions.tsx`. */
export const COMPONENT_ICON_OPTIONS = shapeVariantOptions(
  'component',
  COMPONENT_KINDS,
  COMPONENT_KIND_OPTION_LABELS,
  (kind) => ({ componentKind: kind }),
  // As for the Service glyph kinds: a box that hugs the glyph (`serviceOptions.tsx`).
  { sizeFor: (kind) => (isGlyphComponentKind(kind) ? { width: 78, height: 60 } : undefined) },
);
